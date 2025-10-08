import { API_BASE, showToast, parseDevicesInput, carIconByEvent, eventLabel, fmtDate, fmtTime, downloadCsv, reverseGeocode, sleep, haversineKm, iconByTypeAndEvent } from './utils.js';
import { apiLogin, apiLastReading, apiReadingsRange } from './api.js';
import { initCSVModule } from './load-csv.js';

let deviceMeta = {}; // id -> meta del user (name, plate, brand, model, color, colorHex, ...)
let loginPassword = null;
let map, user, token;
let markers = {};
let devices = [];
let currentPolyline = null;
let currentRoute = [];        // puntos mostrados (para descargar)
let currentDevice = null;
let lastRange = null;         // {from:Date, to:Date}
let routeMarkers = [];

let lastInfo = {};            // id -> {ev, ts:Date, lat, lon, stale:boolean}
let transitIds = [];
let detenidoIds = [];
let sinRepIds = [];
let fleetMarkersHidden = false;
let baseTileLayer = null; // ← referencia al tile base

const normDeg = (d) => ((d % 360) + 360) % 360;
// Offset si tu SVG apunta al Este (→). Si tu SVG apunta al Norte (↑), dejalo en 0.
const ARROW_OFFSET_DEG = -90;
const el = (id) => document.getElementById(id);
// --- Iconos de inicio/fin de ruta ---
const flagStartIcon = L.icon({
  iconUrl: 'assets/flag-start.svg',
  iconSize: [28, 28],
  iconAnchor: [14, 27],    // ancla abajo al centro
  popupAnchor: [0, -22]
});

const flagEndIcon = L.icon({
  iconUrl: 'assets/flag-end.svg',
  iconSize: [28, 28],
  iconAnchor: [14, 27],
  popupAnchor: [0, -22]
});

// =================== helpers UI (exclusividad de paneles) ===================
function getDeviceType(id) {
  const m = getDeviceMeta(id) || {};
  // admite 'type' o 'tipo' en el meta por dispositivo
  return (m.type || m.tipo || user?.data?.tipo || 'auto');
}



function clearAllMarkers() {
  if (!map) return;
  Object.values(markers).forEach(m => { try { map.removeLayer(m); } catch {} });
  markers = {};
}

function nukeNonBaseLayers() {
  if (!map) return;
  map.eachLayer(layer => {
    // quitá todo menos el tile layer base
    if (!(layer instanceof L.TileLayer)) {
      try { map.removeLayer(layer); } catch {}
    }
  });
  // limpiar ruta y marcadores auxiliares
  if (currentPolyline) { try { map.removeLayer(currentPolyline); } catch {} ; currentPolyline = null; }
  routeMarkers.forEach(r => { try { map.removeLayer(r); } catch {} });
  routeMarkers = [];
}

function resetSessionState() {
  // estado de sesión/contadores
  lastInfo   = {};
  transitIds = [];
  detenidoIds = [];
  sinRepIds  = [];
  setUnitsCount(0);
}


function downloadReportPDF() {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  
  // Obtener datos del informe
  const vehicleName = el('reportVehicleName').textContent;
  const period = el('reportPeriod').textContent;
  const km = el('reportKm').textContent;
  const points = el('reportPoints').textContent;
  
  // Configurar fuente y colores
  doc.setFont("helvetica");
  
  // Título principal
  doc.setFontSize(18);
  doc.setTextColor(37, 99, 235); // Azul
  doc.text("Informe de Kilómetros Recorridos", 105, 20, { align: "center" });
  
  // Subtítulo
  doc.setFontSize(12);
  doc.setTextColor(100, 100, 100);
  doc.text("Generado desde la aplicación Diagnosis Tracker", 105, 28, { align: "center" });
  
  // Línea separadora
  doc.setDrawColor(200, 200, 200);
  doc.line(20, 35, 190, 35);
  
  // Contenido del informe
  doc.setFontSize(11);
  doc.setTextColor(0, 0, 0);
  
  let y = 50;
  
  // Vehículo
  doc.setFont("helvetica", "bold");
  doc.text("Vehículo:", 20, y);
  doc.setFont("helvetica", "normal");
  doc.text(vehicleName, 60, y);
  y += 10;
  
  // Período
  doc.setFont("helvetica", "bold");
  doc.text("Período:", 20, y);
  doc.setFont("helvetica", "normal");
  doc.text(period, 60, y);
  y += 15;
  
  // Resultado principal (destacado)
  doc.setFillColor(240, 249, 255);
  doc.roundedRect(15, y - 5, 180, 20, 3, 3, 'F');
  doc.setFontSize(14);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(37, 99, 235);
  doc.text("Kilómetros recorridos:", 20, y + 5);
  doc.setFontSize(16);
  doc.text(km, 150, y + 5, { align: "right" });
  y += 25;
  
  // Puntos procesados
  doc.setFontSize(10);
  doc.setTextColor(100, 100, 100);
  doc.setFont("helvetica", "normal");
  doc.text(`Datos procesados: ${points} puntos GPS`, 20, y);
  y += 15;
  
  // Resumen en texto
  doc.setFontSize(11);
  doc.setTextColor(0, 0, 0);
  const kmValue = el('reportKm').textContent.replace(' km', '');
  const deviceId = el('reportDeviceSelect').value;
  const displayName = getDisplayName(deviceId);
  const [fromPeriod, toPeriod] = period.split(' → ');
  
  const summaryText = `El vehículo "${displayName}" recorrió ${kmValue} kilómetros desde ${fromPeriod} hasta ${toPeriod}.`;
  
  const lines = doc.splitTextToSize(summaryText, 170);
  doc.text(lines, 20, y);
  y += lines.length * 7 + 10;
  
  // Nota técnica
  doc.setFontSize(9);
  doc.setTextColor(120, 120, 120);
  doc.text("Nota: El cálculo se realizó en base a coordenadas GPS registradas por el dispositivo.", 20, y);
  y += 5;
  doc.text("Se filtraron saltos superiores a 5 km para evitar lecturas erróneas.", 20, y);
  
  // Footer
  doc.setDrawColor(200, 200, 200);
  doc.line(20, 270, 190, 270);
  doc.setFontSize(8);
  doc.setTextColor(150, 150, 150);
  const date = new Date();
  const dateStr = `${date.getDate()}/${date.getMonth()+1}/${date.getFullYear()} ${date.getHours()}:${String(date.getMinutes()).padStart(2,'0')}`;
  doc.text(`Diagnosis S.A. - Generado el ${dateStr}`, 105, 280, { align: "center" });
  doc.text("argentinadiagnosis@gmail.com", 105, 285, { align: "center" });
  
  // Descargar
  const filename = `Informe_${displayName.replace(/\s+/g, '_')}_${fmtDate(new Date()).replace(/-/g, '')}.pdf`;
  doc.save(filename);
  
  showToast('Informe PDF descargado');
}


function closePanelsExcept(exceptId = null) {
  ['searchPanel', 'fleetPanel', 'detailsPanel'].forEach(id => {
    if (id !== exceptId) el(id).classList.add('hidden');
  });
}
function openPanel(id) {
  closePanelsExcept(id);
  el(id).classList.remove('hidden');
}

function hideFleetMarkers() {
  if (!map || fleetMarkersHidden) return;
  Object.values(markers).forEach(m => {
    if (m && map.hasLayer(m)) map.removeLayer(m);
  });
  fleetMarkersHidden = true;
}

function showFleetMarkers() {
  if (!map || !fleetMarkersHidden) return;
  Object.values(markers).forEach(m => {
    if (m && !map.hasLayer(m)) m.addTo(map);
  });
  fleetMarkersHidden = false;
}

function getDeviceMeta(id) {
  if (!id) return null;
  const key = String(id);
  return deviceMeta && typeof deviceMeta === 'object' ? deviceMeta[key] || null : null;
}

function getDisplayName(id) {
  const m = getDeviceMeta(id);
  return (m && m.name) ? String(m.name) : String(id);
}

function setText(id, val) {
  const n = el(id);
  if (n) n.textContent = (val == null || val === '') ? '-' : String(val);
}

// atajos
function showSearch()   { openPanel('searchPanel'); }
function hideSearch()   { el('searchPanel').classList.add('hidden'); }
function showFleet()    { openPanel('fleetPanel'); }
function hideFleet()    { el('fleetPanel').classList.add('hidden'); }
function showDetails()  {   openPanel('detailsPanel');  el('detailsPanel').classList.remove('minimized'); }
function hideDetails()  { el('detailsPanel').classList.add('hidden'); }
function showStatus()   { openPanel('statusPanel'); }
function hideStatus()   { el('statusPanel').classList.add('hidden'); }
// ===== Flechas de dirección en la ruta =====

// Calcula rumbo A->B en grados
function bearingDeg([lat1, lon1], [lat2, lon2]) {
  const toRad = (x) => x * Math.PI / 180;
  const toDeg = (x) => x * 180 / Math.PI;
  const φ1 = toRad(lat1), φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1)*Math.sin(φ2) - Math.sin(φ1)*Math.cos(φ2)*Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// === Bridge mínimo para editor.js ===
window.App = {
  get state() { return { user, token, devices, deviceMeta, markers, currentDevice, loginPassword }; },
  setDeviceMeta(newMeta) { deviceMeta = newMeta; },
  getDisplayName,
  getDeviceMeta,
  renderFleet
};



// Usa el SVG de assets y lo rota con CSS
function makeArrowIcon(angleDeg) {
  const size = 20;
  const rot = normDeg(angleDeg + ARROW_OFFSET_DEG); // <-- normalizado

  return L.divIcon({
    className: 'arrow-icon',
    html: `<img src="assets/arrow-current.svg" alt="→"
              style="transform: rotate(${rot}deg);
                     transform-origin: 50% 50%;
                     width:${size}px; height:${size}px;">`,
    iconSize: [size, size],
    iconAnchor: [size/2, size/2],
    popupAnchor: [0, -size/2]
  });
}


// Coloca flechas en puntos medios de los tramos (con límite para no saturar)
function addRouteArrows(latlngs) {
  if (!latlngs || latlngs.length < 2) return;

  const maxArrows = 50; // subí/bajá si querés más/menos flechas
  const step = Math.max(1, Math.ceil(latlngs.length / maxArrows));

  for (let i = 0; i < latlngs.length - 1; i += step) {
    const a = latlngs[i];
    const b = latlngs[i + 1];
    if (!a || !b) continue;

    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const angle = bearingDeg(a, b);

    const arrow = L.marker(mid, {
      icon: makeArrowIcon(angle),
      interactive: false,
      keyboard: false,
      zIndexOffset: 500
    }).addTo(map);

    routeMarkers.push(arrow); // así clearRoute() las borra
  }
}

function setAuthDebug(obj) {
  const dbg = document.getElementById('authDebug');
  if (!dbg) return; // si ya no existe el cuadro, no hacemos nada
  dbg.textContent = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
}

function setUnitsCount(n) { el('unitsCount').textContent = n; }

function showAuthPane() {
  el('authPane').classList.remove('hidden');
  el('mapPane').classList.add('hidden');
  // Ocultar la barra superior
  document.querySelector('.topbar').classList.add('hidden');
}

function showMapPane() {
  el('authPane').classList.add('hidden');
  el('mapPane').classList.remove('hidden');
  // Mostrar la barra superior después del login
  document.querySelector('.topbar').classList.remove('hidden');
}

// =================== mapa ===================
function initMap() {
  map = L.map('map', { zoomControl: false }).setView([-26.8, -65.2], 5);

  baseTileLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);

  L.control.zoom({ position: 'bottomright' }).addTo(map);
}

// --- Batería: parser y formateo ---
function parseBattery(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number') return isFinite(raw) ? raw : null;
  if (typeof raw === 'string') {
    // acepta "12,22", " 12.2 ", incluso "12,22V"
    const s = raw.trim().replace(',', '.').replace(/[^\d.\-+eE]/g, '');
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
function fmtBattery(v) {
  if (v == null) return '-';
  return `${v.toFixed(2)} V`;
}

function ensureMarker(deviceId, lat, lon, ev) {
  const type = getDeviceType(deviceId);

  let iconUrl;
  if (ev === 'stale') {
    iconUrl = `assets/${String(type).toLowerCase()}_sindatos.svg`;
  } else {
    iconUrl = iconByTypeAndEvent(type, ev);
  }

  const icon = L.icon({
    iconUrl,
    iconSize: [36, 36],
    iconAnchor: [18, 18],
  });

  if (markers[deviceId]) {
    const m = markers[deviceId];
    m.setLatLng([lat, lon]).setIcon(icon);

    if (!fleetMarkersHidden && !map.hasLayer(m)) m.addTo(map);

    const label = getDisplayName(deviceId);
    m.unbindTooltip();
    m.bindTooltip(label, {
      permanent: true,
      direction: 'bottom',
      offset: [0, 10],
      className: 'marker-label'
    });

  } else {
    const m = L.marker([lat, lon], { icon });
    const label = getDisplayName(deviceId);
    m.bindTooltip(label, {
      permanent: true,
      direction: 'bottom',
      offset: [0, 10],
      className: 'marker-label'
    });
    m.on('click', () => onMarkerClick(deviceId));

    if (!fleetMarkersHidden) m.addTo(map);
    markers[deviceId] = m;
  }
}




// =================== marker click / detalles ===================
async function onMarkerClick(deviceId) {
  currentDevice = deviceId;
  try {
    const js = await apiLastReading(deviceId);
    const d = js?.data || {};
    const t = new Date(js?.timestamp || js?.ts || Date.now());
    fillDetailsPanel({
      deviceId,
      ts: t,
      ev: d.ev ?? d.e ?? 0,
      v: d.v ?? '-',
      sg: d.sg ?? '-',
      lat: Number(d.la ?? d.lat ?? 0),
      lon: Number(d.lo ?? d.lon ?? 0),
      bt: parseBattery(d.Bt ?? d.bt ?? d.battery),  // <<< batería normalizada

    });
    showDetails(); // abre SOLO detalles, cierra el resto
  } catch (e) {
    console.error('onMarkerClick', e);
    showToast('No se pudo leer el último reporte');
    window.dispatchEvent(new CustomEvent('app:device-selected', { detail: { id: deviceId } }));

  }
}

function fillDetailsPanel({ deviceId, ts, ev, v, sg, lat, lon, bt }) {
const display = getDisplayName(deviceId);
el('dpDevice').textContent = `${display} (${deviceId})`;

// meta
const meta = getDeviceMeta(deviceId) || {};
setText('dpPlate', meta.plate);
setText('dpBrand', meta.brand);
setText('dpModel', meta.model);
setText('dpColor', meta.color);

// opcional: si querés colorear “Color” con el hex
if (meta.colorHex) {
  const c = el('dpColor');
  if (c) {
    c.innerHTML = `<span style="display:inline-block;width:12px;height:12px;border-radius:50%;vertical-align:middle;margin-right:6px;border:1px solid #ccc;background:${meta.colorHex}"></span>${meta.color || meta.colorHex}`;
  }
}

  el('dpDate').textContent   = fmtDate(ts);
  el('dpTime').textContent   = fmtTime(ts);
  el('dpEvent').textContent  = eventLabel(ev);
  el('dpSpeed').textContent  = `${Number(v)||0} km/h`;
  el('dpSignal').textContent = `${sg ?? '-'}`;
  el('dpLatLon').textContent = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
  const batEl = el('dpBattery');
  if (batEl) batEl.textContent = fmtBattery(bt);

  // 👉 Dirección
  const addrEl = el('dpAddress');
  if (addrEl) {
    addrEl.textContent = 'Buscando...';
    reverseGeocode(lat, lon)
      .then(addr => addrEl.textContent = addr || '(sin dirección)')
      .catch(()  => addrEl.textContent = '(sin dirección)');
  }

  clearRoute();
}

async function enrichRouteWithAddresses(points) {
  // consulta secuencial con leve pausa: amable con el servicio
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!p.addr && p.lat && p.lon) {
      try {
        p.addr = await reverseGeocode(p.lat, p.lon);
      } catch {
        p.addr = '';
      }
      // cada 5 puntos, dormimos un cachito
      if (i % 5 === 0) await sleep(300);
    }
  }
}

// =================== carga de últimos puntos ===================
// =================== carga de últimos puntos ===================
async function loadLastPoints(ids) {
  if (!ids || !ids.length) { setUnitsCount(0); return; }

  // reset
  lastInfo   = {};
  transitIds = [];
  detenidoIds = [];
  sinRepIds  = [];

  // 👉 Sets para evitar duplicados
  const transitSet  = new Set();
  const detenidoSet = new Set();
  const sinRepSet   = new Set();

  const now = Date.now();
  const isStale = (t) => (now - t) >= 5 * 3600 * 1000; // ≥5h

  let bounds = [];
  for (const idRaw of ids) {
    const id = String(idRaw).trim();   // 👉 normalizá el ID
    try {
      const js = await apiLastReading(id);
      const d = js?.data || {};
      const ts = new Date(js?.timestamp || js?.ts || Date.now());

      const lat = Number(d.la ?? d.lat ?? 0);
      const lon = Number(d.lo ?? d.lon ?? 0);
      const ev  = Number(d.ev ?? d.e  ?? 0);
      const stale = isStale(ts.getTime());

      if (isFinite(lat) && isFinite(lon) && lat !== 0 && lon !== 0) {
        const nlat = lat > 0 ? -Math.abs(lat) : lat;
        const nlon = lon > 0 ? -Math.abs(lon) : lon;

        if (stale) {
          ensureMarker(id, nlat, nlon, 'stale');
        } else {
          ensureMarker(id, nlat, nlon, ev);
        }
        bounds.push([nlat, nlon]);
      }

      // clasificar (prioridad: stale)
      lastInfo[id] = { ev, ts, lat, lon, stale };

      if (stale) {
        sinRepSet.add(id);            // ✅ sin duplicados
      } else if (ev === 10 || ev === 31) {
        transitSet.add(id);
      } else if (ev === 11 || ev === 30) {
        detenidoSet.add(id);
      }
    } catch (e) {
      console.error('last-reading error', id, e);
    }
  }

  // Pasá a arrays para el resto del código
  transitIds  = Array.from(transitSet);
  detenidoIds = Array.from(detenidoSet);
  sinRepIds   = Array.from(sinRepSet);

  setUnitsCount(Object.keys(markers).length);
  updateStatusPanel({
    username: user?.username || '-',
    total: Array.from(new Set(ids.map(x => String(x).trim()))).length, // total sin duplicados
    transitIds, detenidoIds, sinRepIds
  });

  if (!fleetMarkersHidden && bounds.length) {
    map.fitBounds(bounds, { padding: [24, 24] });
  }
}


// =================== INFORMES ===================
function showReports() {
  openPanel('reportsPanel');
  populateReportDevices();
  setupReportDateInputs();
}

function hideReports() {
  el('reportsPanel').classList.add('hidden');
  el('reportResult').style.display = 'none';
}

function populateReportDevices() {
  const sel = el('reportDeviceSelect');
  if (!sel) return;
  
  sel.innerHTML = '<option value="">-- Elegir --</option>' +
    devices.map(id => {
      const name = getDisplayName(id);
      return `<option value="${id}">${name} (${id})</option>`;
    }).join('');
}

function setupReportDateInputs() {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const pad = (n) => n.toString().padStart(2, '0');
  const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  
  const fromInput = el('reportFrom');
  const toInput = el('reportTo');
  if (fromInput && toInput) {
    fromInput.value = fmt(weekAgo);
    toInput.value = fmt(now);
  }
}

async function generateKmReport() {
  const deviceId = el('reportDeviceSelect').value;
  const fromStr = el('reportFrom').value;
  const toStr = el('reportTo').value;
  
  if (!deviceId) {
    showToast('Seleccione un vehículo');
    return;
  }
  if (!fromStr || !toStr) {
    showToast('Complete ambas fechas');
    return;
  }
  
  const from = new Date(fromStr + ':00');
  const to = new Date(toStr + ':00');
  
  if (isNaN(from.getTime()) || isNaN(to.getTime())) {
    showToast('Fechas inválidas');
    return;
  }
  if (to < from) {
    showToast('La fecha "Hasta" debe ser posterior a "Desde"');
    return;
  }
  
  el('reportMsg').textContent = 'Calculando...';
  el('reportResult').style.display = 'none';
  
  try {
    const points = await apiReadingsRange(deviceId, from, to);
    
    if (!points || points.length === 0) {
      el('reportMsg').textContent = 'No hay datos en el período seleccionado';
      return;
    }
    
    // Calcular distancia total
    let totalKm = 0;
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1];
      const curr = points[i];
      
      if (prev.lat && prev.lon && curr.lat && curr.lon) {
        const dist = haversineKm(prev.lat, prev.lon, curr.lat, curr.lon);
        // Filtrar saltos irreales (más de 5 km entre puntos consecutivos)
        if (dist < 5) {
          totalKm += dist;
        }
      }
    }
    
    // Mostrar resultado
    const vehicleName = getDisplayName(deviceId);
    el('reportVehicleName').textContent = `${vehicleName} (${deviceId})`;
    el('reportPeriod').textContent = `${fmtDate(from)} ${fmtTime(from)} → ${fmtDate(to)} ${fmtTime(to)}`;
    el('reportKm').textContent = `${totalKm.toFixed(2)} km`;
    el('reportPoints').textContent = points.length;
    el('reportResult').style.display = 'block';
    el('reportMsg').textContent = '';
    
    showToast(`Informe generado: ${totalKm.toFixed(2)} km`);
    
  } catch (e) {
    console.error('Error generando informe:', e);
    el('reportMsg').textContent = 'Error: ' + e.message;
    showToast('Error al generar el informe');
  }
}

function updateStatusPanel({ username, total, transitIds, detenidoIds, sinRepIds }) {
  el('spUser').textContent     = username || '-';
  el('spTotal').textContent    = String(total ?? 0);
  el('spTransit').textContent  = String(transitIds?.length ?? 0);
  el('spDetenido').textContent = String(detenidoIds?.length ?? 0);
  el('spSinRep').textContent   = String(sinRepIds?.length ?? 0);

  el('spTransitRow').onclick   = () => focusDevices(transitIds);
  el('spDetenidoRow').onclick  = () => focusDevices(detenidoIds);
  el('spSinRepRow').onclick    = () => focusDevices(sinRepIds);
}


function focusDevices(idList) {
  if (!idList || !idList.length) { showToast('No hay vehículos en ese grupo'); return; }
  hideDetails(); hideSearch(); hideFleet();
  clearRoute();
  hideDetails(); 
  hideSearch(); 
  hideFleet();
  const pts = [];
  idList.forEach(id => {
    const m = markers[id];
    if (m) pts.push(m.getLatLng());
  });
  if (!pts.length) { showToast('No hay posiciones para ese grupo'); return; }
  map.fitBounds(pts, { padding: [24,24] });
}

// =================== flota (lista) ===================
// =================== flota (lista) ===================
function renderFleet(ids) {
  const ul = el('fleetList');

  // Construye la lista
ul.innerHTML = ids.map(id => {
  const name = getDisplayName(id);
  return `<li><strong>${name}</strong> <span class="muted">(${id})</span> <button data-id="${id}" class="btn">Ver</button></li>`;
}).join('');


  // Un único handler, no { once:true }, no addEventListener duplicados
  ul.onclick = (ev) => {
    const b = ev.target.closest('button[data-id]');
    if (!b) return;

    const id = b.getAttribute('data-id').trim();
    const m  = markers[id];

    // Abrimos detalles siempre (aunque no haya marker)
    onMarkerClick(id);

    if (m) {
      map.setView(m.getLatLng(), 15);
    } else {
      showToast(`Sin posición aún para ${id}`);
    }
  };
}

function setSidebarCollapsed(collapsed){
  const sp = el('statusPanel');
  sp.classList.toggle('collapsed', collapsed);
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  // Dale un tiempito al CSS y luego recalculamos el mapa
  setTimeout(() => { if (map) map.invalidateSize(); }, 200);
}

// botón del panel
el('btnStatusToggle').addEventListener('click', () => {
  const collapsed = !el('statusPanel').classList.contains('collapsed');
  setSidebarCollapsed(collapsed);
});

// =================== rutas ===================
function clearRoute() {
  if (currentPolyline) { map.removeLayer(currentPolyline); currentPolyline = null; }
  routeMarkers.forEach(marker => map.removeLayer(marker));
  routeMarkers = [];
  currentRoute = [];
  lastRange = null;
  el('btnDownload').disabled = true;
}

function drawRoute(points) {
  hideFleetMarkers();
  clearRoute();
  if (!points.length) { showToast('No hay puntos en el rango'); return; }

  const latlngs = [];
  for (const p of points) {
    if (!p.lat || !p.lon) continue;
    const nlat = p.lat > 0 ? -Math.abs(p.lat) : p.lat;
    const nlon = p.lon > 0 ? -Math.abs(p.lon) : p.lon;
    latlngs.push([nlat, nlon]);

    // Punto rojo de cada trama
    const marker = L.circleMarker([nlat, nlon], {
      radius: 5,
      color: '#ff0000',
      fillColor: '#ff0000',
      fillOpacity: 0.7,
      weight: 1
    }).addTo(map);

const dispName = getDisplayName(currentDevice);
const popupContent = `
  <div class="route-popup">
    <strong>Dispositivo:</strong> ${dispName} (${currentDevice})<br>
    <strong>Fecha:</strong> ${fmtDate(p.ts)}<br>
    <strong>Hora:</strong> ${fmtTime(p.ts)}<br>
    <strong>Velocidad:</strong> ${p.v || 0} km/h<br>
    <strong>Evento:</strong> ${eventLabel(p.ev)}<br>
    <strong>Señal:</strong> ${p.sg || '-'}<br>
    <strong>Coordenadas:</strong> ${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}<br>
    <strong>Batería:</strong> ${fmtBattery(parseBattery(p.Bt ?? p.bt ?? p.battery))}
  </div>
`;

    marker.bindPopup(popupContent, { closeButton: false });
    marker.on('mouseover', function() { this.openPopup(); });
    marker.on('mouseout',  function() { this.closePopup(); });
    routeMarkers.push(marker);
  }

  // Polyline
  currentPolyline = L.polyline(latlngs, { color:'#2563eb', weight: 4 }).addTo(map);
addRouteArrows(latlngs);
  // ====== Banderas INICIO / FIN ======
  if (latlngs.length >= 1) {
    // Primer punto → flag-start
    const first = latlngs[0];
    const firstData = points[0];
    const startFlag = L.marker(first, {
      icon: flagStartIcon,
      zIndexOffset: 1000
    })
    .bindTooltip('Inicio', { direction:'top', offset:[0,-10] })
    .bindPopup(`
      <div class="route-popup">
        <strong>Inicio</strong><br>
        ${fmtDate(firstData.ts)} ${fmtTime(firstData.ts)}<br>
        ${firstData.lat.toFixed(6)}, ${firstData.lon.toFixed(6)}
      </div>
    `)
    .addTo(map);
    routeMarkers.push(startFlag);
  }

  if (latlngs.length >= 2) {
    // Último punto → flag-end
    const last = latlngs[latlngs.length - 1];
    const lastData = points[points.length - 1];
    const endFlag = L.marker(last, {
      icon: flagEndIcon,
      zIndexOffset: 1000
    })
    .bindTooltip('Fin', { direction:'top', offset:[0,-10] })
    .bindPopup(`
      <div class="route-popup">
        <strong>Fin</strong><br>
        ${fmtDate(lastData.ts)} ${fmtTime(lastData.ts)}<br>
        ${lastData.lat.toFixed(6)}, ${lastData.lon.toFixed(6)}
      </div>
    `)
    .addTo(map);
    routeMarkers.push(endFlag);
  }
  // ====== /Banderas ======
  annotateStops(points, latlngs);
  map.fitBounds(currentPolyline.getBounds(), { padding:[24,24] });
  currentRoute = points;
  el('btnDownload').disabled = currentRoute.length === 0;
  


}


// =================== datetime inputs ===================
function setupDateTimeInputs() {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  const todayEnd   = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
  const pad = (n) => n.toString().padStart(2, '0');
  const formatForInput = (date) =>
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const fromInput = document.getElementById('dtFrom');
  const toInput   = document.getElementById('dtTo');
  if (fromInput && toInput) {
    fromInput.value = formatForInput(todayStart);
    toInput.value   = formatForInput(todayEnd);
  }
}
document.addEventListener('DOMContentLoaded', setupDateTimeInputs);

// =================== fetch ruta ===================
async function fetchAndDrawRange(deviceId, from, to) {
  try {
    console.log('[RANGE] local:', from, '→', to);
    const points = await apiReadingsRange(deviceId, from, to);
    if (!points.length) {
      showToast('No se encontraron puntos en el rango seleccionado');
    } else {
      drawRoute(points);
      lastRange = { from, to };
      showToast(`Se encontraron ${points.length} puntos`);
    }
  } catch (e) {
    console.error('Error en fetchAndDrawRange:', e);
    showToast('Error leyendo la ruta: ' + e.message);
  }
}


// =================== auth & acciones ===================
async function onCreateUser() {
  const username = el('username').value.trim();
  const password = el('password').value.trim();
  const devices = parseDevicesInput(el('devices').value);
  const tipo = el('tipo').value.trim();
  const nivel = el('nivel').value.trim();
  if (!username || !password) { showToast('Usuario y contraseña requeridos'); return; }
  try {
    const res = await apiCreateUser({ username, password, devices, tipo, nivel });
    setAuthDebug(res);
    showToast('Usuario creado');
  } catch (e) {
    setAuthDebug(String(e)); showToast('Error al crear usuario');
  }
}


// Funcionalidad para el menú desplegable
const btnMenu = document.getElementById('btnMenu');
const menuContent = document.getElementById('menuContent');

if (btnMenu && menuContent) {
  btnMenu.addEventListener('click', (e) => {
    e.stopPropagation();
    menuContent.classList.toggle('hidden');
  });
  
  // Cerrar menú al hacer clic fuera
  document.addEventListener('click', () => {
    menuContent.classList.add('hidden');
  });
  
  // Prevenir que el clic en el menú lo cierre
  menuContent.addEventListener('click', (e) => {
    e.stopPropagation();
  });
}

// Configurar opciones del menú
document.getElementById('menuExit').addEventListener('click', onLogout);
// Informes
document.getElementById('menuReports')?.addEventListener('click', (e) => {
  e.preventDefault();
  showReports();
});

el('btnCloseReports')?.addEventListener('click', hideReports);
el('btnGenerateReport')?.addEventListener('click', generateKmReport);
el('btnDownloadReport')?.addEventListener('click', downloadReportPDF);

// ===== Referencias (dropdown a la izquierda) =====
const btnRefs = document.getElementById('btnRefs');
const refsContent = document.getElementById('refsContent');

if (btnRefs && refsContent) {
  btnRefs.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = refsContent.classList.toggle('hidden');
    btnRefs.setAttribute('aria-expanded', String(!open));
  });

  // Evitar que el clic dentro cierre el menú
  refsContent.addEventListener('click', (e) => e.stopPropagation());

  // Cerrar referencias si se hace clic afuera
  document.addEventListener('click', () => {
    refsContent.classList.add('hidden');
    btnRefs.setAttribute('aria-expanded', 'false');
  });
}



async function onLogin() {
  const username = el('username').value.trim();
  const password = el('password').value.trim();
  loginPassword = password; 
  if (!username || !password) { showToast('Usuario y contraseña requeridos'); return; }

  if (window.matchMedia('(max-width: 1024px)').matches) setSidebarCollapsed(true);

  try {
    const res = await apiLogin({ username, password });
    token = res.token; user = res.user;
    deviceMeta = (user?.data?.devices_meta) || {};
    devices = (user?.data?.devices || []).map(String);

    showMapPane();
    if (!map) initMap();

    // Habilitar "Cargar rutas" y "Limpiar Ruta CSV"
  initCSVModule({
  onRouteLoaded: (points) => {
    // Mostrar solo la ruta del CSV
    if (typeof hideFleetMarkers === 'function') hideFleetMarkers();
    currentDevice = 'CSV_IMPORT';
    drawRoute(points);
    if (currentPolyline) map.fitBounds(currentPolyline.getBounds(), { padding: [24, 24] });
    showDetails();
    showToast(`Ruta CSV visualizada con ${points.length} puntos`);
  },
  onClearRequested: () => {
    clearRoute();
    currentDevice = null;
    hideDetails();
    if (typeof showFleetMarkers === 'function') showFleetMarkers();
    showToast('Ruta CSV eliminada');
  }
});

    // 🔥 LIMPIEZA COMPLETA ANTES DE MOSTRAR LOS NUEVOS
    nukeNonBaseLayers();
    clearAllMarkers();
    clearRoute();
    resetSessionState();

    el('spUser').textContent = user?.username || '-';
    showStatus();

    await loadLastPoints(devices);
    renderFleet(devices);

    setAuthDebug(res);
    if (!devices.length) showToast('Login ok, pero no hay devices en data');
    else showToast(`Login ok: ${devices.length} dispositivos`);
  } catch (e) {
    setAuthDebug(String(e));
    if (String(e).includes('TypeError')) showToast('Error de red/CORS. Ver consola.');
    else showToast('Login falló');
  }
  window.dispatchEvent(new CustomEvent('app:logged-in', { detail: { user } }));
}


function onLogout() {
  // limpiar capas/markers del mapa
  nukeNonBaseLayers();
  clearAllMarkers();
  clearRoute();
  resetSessionState();

  token = null; user = null; devices = [];
  deviceMeta = {};
  showAuthPane();
  document.getElementById('statusPanel').classList.add('hidden');
  showToast('Sesión cerrada');
  window.dispatchEvent(new Event('app:logged-out'));
}




function onRefresh() {
  if (!devices.length) { showToast('No hay dispositivos'); return; }
  clearRoute();
  hideDetails();
  hideSearch();
  hideFleet();

  // volver a mostrar autos y recargar
  showFleetMarkers();
  loadLastPoints(devices);
}



// chips "Ver hoy"
function onChipsClick(ev) {
  const b = ev.target.closest('button.chip');
  if (!b || !currentDevice) return;
  const minutes = Number(b.getAttribute('data-min') || 0);
  if (!minutes) return;
  const to   = new Date();               // hora local
  const from = new Date(to.getTime() - minutes * 60 * 1000);
  console.log('[Ver hoy]', { device: currentDevice, fromLocal: from, toLocal: to });
  fetchAndDrawRange(currentDevice, from, to);
}


// rango manual
function onApplyRange() {
  if (!currentDevice) { showToast('Primero elegí un dispositivo'); return; }
  const fromStr = el('dtFrom').value;
  const toStr   = el('dtTo').value;
  if (!fromStr || !toStr) { showToast('Completá ambas fechas'); return; }
  const from = new Date(fromStr + ':00');
  const to   = new Date(toStr + ':00');
  if (isNaN(from.getTime()) || isNaN(to.getTime())) { showToast('Fechas inválidas'); return; }
  if (to < from) { showToast('El rango es inválido'); return; }
  fetchAndDrawRange(currentDevice, from, to);
}

// ====== Paradas (detenciones) ======
const STOP_DIAMETER_M = 20;                       // diámetro del círculo
const STOP_RADIUS_M   = STOP_DIAMETER_M / 2;      // radio (m)
const STOP_MIN_POINTS = 3;                        // # mínimo de puntos para considerar "detenido"
const STOP_MIN_DURATION_MS = 5 * 60 * 1000;       // duración mínima: 2 minutos (ajustable)

// Haversine en metros
function haversineMeters([lat1, lon1], [lat2, lon2]) {
  const toRad = (x) => x * Math.PI / 180;
  const R = 6371000; // m
  const φ1 = toRad(lat1), φ2 = toRad(lat2);
  const Δφ = toRad(lat2 - lat1);
  const Δλ = toRad(lon2 - lon1);
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Crea un marcador + tooltip/popup para la parada
function addStopBadge(centerLatLng, startTs, endTs) {
  const durMs  = (endTs instanceof Date ? endTs.getTime() : new Date(endTs).getTime()) -
                 (startTs instanceof Date ? startTs.getTime() : new Date(startTs).getTime());
  const mins   = Math.max(1, Math.round(durMs / 60000)); // redondeo a min
  const marker = L.circleMarker(centerLatLng, {
    radius: 7,
    color: '#111827',
    fillColor: '#f59e0b',
    fillOpacity: 1,
    weight: 2
  }).addTo(map);

  marker.bindTooltip(`Detenido ${mins} min`, {
    permanent: true,
    direction: 'top',
    offset: [0, -10]
  });

  marker.bindPopup(`
    <div class="route-popup">
      <strong>Detenido</strong><br>
      ${fmtDate(startTs)} ${fmtTime(startTs)} → ${fmtDate(endTs)} ${fmtTime(endTs)}<br>
      Duración: ${mins} min
    </div>
  `);

  routeMarkers.push(marker);
}

// Detecta “paradas” en base a los latlngs dibujados (los mismos que tu polyline)
// y los puntos originales (para tiempos). Asume que points está en orden temporal.
function annotateStops(points, latlngs) {
  if (!latlngs || latlngs.length === 0) return;

  // Helper para leer timestamp en ms
  const tms = (p) => (p.ts instanceof Date ? p.ts.getTime() : new Date(p.ts).getTime());

  let clusterStartIdx = 0;
  let count = 1;
  let sumLat = latlngs[0][0];
  let sumLon = latlngs[0][1];
  let center = [sumLat, sumLon];

  const flushCluster = (endIdxExclusive) => {
    const startIdx = clusterStartIdx;
    const endIdx   = endIdxExclusive - 1;
    if (endIdx <= startIdx) return;

    const nPoints = count;
    const dur = tms(points[endIdx]) - tms(points[startIdx]);

    if (nPoints >= STOP_MIN_POINTS && dur >= STOP_MIN_DURATION_MS) {
      const startTs = points[startIdx].ts instanceof Date ? points[startIdx].ts : new Date(points[startIdx].ts);
      const endTs   = points[endIdx].ts   instanceof Date ? points[endIdx].ts   : new Date(points[endIdx].ts);
      addStopBadge(center, startTs, endTs);
    }
  };

  for (let i = 1; i < latlngs.length; i++) {
    const [lat, lon] = latlngs[i];
    const d = haversineMeters([lat, lon], center);

    if (d <= STOP_RADIUS_M) {
      // sigue dentro del círculo → actualizamos centro como promedio simple
      count += 1;
      sumLat += lat;
      sumLon += lon;
      center = [sumLat / count, sumLon / count];
    } else {
      // cerramos cluster anterior y arrancamos uno nuevo
      flushCluster(i);
      clusterStartIdx = i;
      count = 1;
      sumLat = lat;
      sumLon = lon;
      center = [lat, lon];
    }
  }
  // Último cluster
  flushCluster(latlngs.length);
}


// descargar CSV
async function onDownloadCsv() {
  if (!currentRoute.length || !currentDevice) return;

  // 👉 cargar direcciones (usa caché, así que es rápido si repetís)
  showToast('Agregando direcciones a la exportación, espere 1 minuto...');
  await enrichRouteWithAddresses(currentRoute);

  const rows = currentRoute.map(p => ({
    lat: p.lat,
    lon: p.lon,
    date: fmtDate(p.ts),
    time: fmtTime(p.ts),
    v: p.v,
    event: eventLabel(p.ev),
    sg: p.sg,
    address: p.addr || ''   // 👉 nueva columna
  }));

  let name = `ruta_${currentDevice}`;
  if (lastRange?.from && lastRange?.to) {
    name += `_${fmtDate(lastRange.from)}_${fmtTime(lastRange.from).replaceAll(':','')}` +
            `__${fmtDate(lastRange.to)}_${fmtTime(lastRange.to).replaceAll(':','')}`;
  }
  name += '.csv';

  downloadCsv(name, rows);
  showToast('CSV descargado con direcciones');
}


// =================== wire-up ===================
el('btnLogin').addEventListener('click', onLogin);

document.getElementById('loginForm')?.addEventListener('submit', (e) => {
  e.preventDefault();
  onLogin();
});
el('btnRefresh').addEventListener('click', onRefresh);
el('btnSearch').addEventListener('click', showSearch);
el('btnDoSearch').addEventListener('click', () => {
  const id = el('searchId').value.trim();
  if (!id) return;
  if (!devices.includes(id)) { el('searchMsg').textContent = 'El ID no está habilitado para este usuario'; return; }
  const m = markers[id];
  if (m) { map.setView(m.getLatLng(), 16); onMarkerClick(id); el('searchMsg').textContent = ''; }
  else { el('searchMsg').textContent = 'Sin posición aún para este ID'; }
});
el('btnCloseSearch').addEventListener('click', hideSearch);

el('btnFleet').addEventListener('click', showFleet);
el('btnCloseFleet').addEventListener('click', hideFleet);
// Minimizar / expandir detalles sin perder la ruta
el('btnMinimizeDetails')?.addEventListener('click', () => {
  const panel = el('detailsPanel');
  const btn   = el('btnMinimizeDetails');
  panel.classList.toggle('minimized');

  const minimized = panel.classList.contains('minimized');
  // Cambiamos el ícono y el título del botón
  btn.textContent = minimized ? '▴' : '▾';
  btn.title = minimized ? 'Expandir' : 'Minimizar';
});

el('btnCloseDetails').addEventListener('click', async () => {
  hideDetails();
  clearRoute();                   // ← si querés mantener la ruta, quitá esta línea
  showFleetMarkers();
  if (devices?.length) await loadLastPoints(devices);
});


el('btnApplyRange').addEventListener('click', onApplyRange);
el('btnDownload').addEventListener('click', onDownloadCsv);

// chips dentro del panel de detalles
el('detailsPanel').addEventListener('click', (ev) => {
  if (ev.target.closest('.chips')) onChipsClick(ev);
});

// locate (center on browser location)
// locate (center on browser location and add circle marker)
el('btnLocate').addEventListener('click', async () => {
  if (!map) return;
  if (!navigator.geolocation) { showToast('Geolocalización no disponible'); return; }
  
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude, longitude } = pos.coords;
      
      // Centrar el mapa en la ubicación
      map.setView([latitude, longitude], 14);
      
      // Eliminar marcador anterior si existe
      if (window.currentLocationMarker) {
        map.removeLayer(window.currentLocationMarker);
      }
      
      // Crear y agregar círculo para la ubicación actual
      window.currentLocationMarker = L.circleMarker([latitude, longitude], {
        radius: 8,
        fillColor: "#3388ff",
        color: "#ffffff",
        weight: 2,
        opacity: 1,
        fillOpacity: 0.8
      }).addTo(map);
      
      // Agregar popup con información
      window.currentLocationMarker.bindPopup(`
        <div class="location-popup">
          <strong>Tu ubicación actual</strong><br>
          Lat: ${latitude.toFixed(6)}<br>
          Lon: ${longitude.toFixed(6)}<br>
          Precisión: ${pos.coords.accuracy ? pos.coords.accuracy.toFixed(0) + 'm' : 'N/A'}<br>
          ${new Date().toLocaleString()}
        </div>
      `).openPopup();
      
      showToast('Ubicación encontrada y marcada');
    },
    (error) => {
      console.error('Error getting location:', error);
      let message = 'No se pudo obtener tu ubicación';
      switch(error.code) {
        case error.PERMISSION_DENIED:
          message = 'Permiso de ubicación denegado';
          break;
        case error.POSITION_UNAVAILABLE:
          message = 'Información de ubicación no disponible';
          break;
        case error.TIMEOUT:
          message = 'Tiempo de espera agotado para obtener la ubicación';
          break;
      }
      showToast(message);
    },
    { 
      enableHighAccuracy: true, 
      timeout: 10000,
      maximumAge: 60000 
    }
  );
});
