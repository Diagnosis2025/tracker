import {
  API_BASE, showToast, parseDevicesInput, carIconByEvent, eventLabel,
  fmtDate, fmtTime, downloadCsv, reverseGeocode, sleep, haversineKm,
  iconByTypeAndEvent, normalizeType
} from './utils.js';
import {
  apiLogin,
  apiListAvailable,
  apiLastReading,
  apiReadingsRange,
  apiLastReadingsBulk,
  setAuthToken
} from './api.js';
import { initCSVModule } from './load-csv.js';

let deviceMeta = {}; // id -> meta del user (name, plate, brand, model, color, colorHex, ...)
let loginPassword = null;
let map, user, token, userMetadata;
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
let baseTileLayer = null;

const normDeg = (d) => ((d % 360) + 360) % 360;
const ARROW_OFFSET_DEG = -90;
const el = (id) => document.getElementById(id);

const flagStartIcon = L.icon({
  iconUrl: 'assets/flag-start.svg',
  iconSize: [28, 28],
  iconAnchor: [14, 27],
  popupAnchor: [0, -22]
});
const flagEndIcon = L.icon({
  iconUrl: 'assets/flag-end.svg',
  iconSize: [28, 28],
  iconAnchor: [14, 27],
  popupAnchor: [0, -22]
});

// =================== helpers UI ===================
function getDeviceType(id) {
  const m = getDeviceMeta(id) || {};
  // admite 'type' o 'tipo' por dispositivo, o 'tipo' a nivel metadata de usuario
  return normalizeType(m.type || m.tipo || userMetadata?.tipo || 'auto');
}

function clearAllMarkers() {
  if (!map) return;
  Object.values(markers).forEach(m => { try { map.removeLayer(m); } catch {} });
  markers = {};
}

function nukeNonBaseLayers() {
  if (!map) return;
  map.eachLayer(layer => {
    if (!(layer instanceof L.TileLayer)) {
      try { map.removeLayer(layer); } catch {}
    }
  });
  if (currentPolyline) { try { map.removeLayer(currentPolyline); } catch {} ; currentPolyline = null; }
  routeMarkers.forEach(r => { try { map.removeLayer(r); } catch {} });
  routeMarkers = [];
}

function resetSessionState() {
  lastInfo   = {};
  transitIds = [];
  detenidoIds = [];
  sinRepIds  = [];
  setUnitsCount(0);
}

function downloadReportPDF() {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();

  const vehicleName = el('reportVehicleName').textContent;
  const period = el('reportPeriod').textContent;
  const km = el('reportKm').textContent;
  const points = el('reportPoints').textContent;

  doc.setFont("helvetica");
  doc.setFontSize(18);
  doc.setTextColor(37, 99, 235);
  doc.text("Informe de Kilómetros Recorridos", 105, 20, { align: "center" });

  doc.setFontSize(12);
  doc.setTextColor(100, 100, 100);
  doc.text("Generado desde la aplicación Diagnosis Tracker", 105, 28, { align: "center" });

  doc.setDrawColor(200, 200, 200);
  doc.line(20, 35, 190, 35);

  doc.setFontSize(11);
  doc.setTextColor(0, 0, 0);

  let y = 50;

  doc.setFont("helvetica", "bold");
  doc.text("Vehículo:", 20, y);
  doc.setFont("helvetica", "normal");
  doc.text(vehicleName, 60, y);
  y += 10;

  doc.setFont("helvetica", "bold");
  doc.text("Período:", 20, y);
  doc.setFont("helvetica", "normal");
  doc.text(period, 60, y);
  y += 15;

  doc.setFillColor(240, 249, 255);
  doc.roundedRect(15, y - 5, 180, 20, 3, 3, 'F');
  doc.setFontSize(14);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(37, 99, 235);
  doc.text("Kilómetros recorridos:", 20, y + 5);
  doc.setFontSize(16);
  doc.text(km, 150, y + 5, { align: "right" });
  y += 25;

  doc.setFontSize(10);
  doc.setTextColor(100, 100, 100);
  doc.setFont("helvetica", "normal");
  doc.text(`Datos procesados: ${points} puntos GPS`, 20, y);
  y += 15;

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

  doc.setFontSize(9);
  doc.setTextColor(120, 120, 120);
  doc.text("Nota: El cálculo se realizó en base a coordenadas GPS registradas por el dispositivo.", 20, y);
  y += 5;
  doc.text("Se filtraron saltos superiores a 5 km para evitar lecturas erróneas.", 20, y);

  doc.setDrawColor(200, 200, 200);
  doc.line(20, 270, 190, 270);
  doc.setFontSize(8);
  doc.setTextColor(150, 150, 150);
  const date = new Date();
  const dateStr = `${date.getDate()}/${date.getMonth()+1}/${date.getFullYear()} ${date.getHours()}:${String(date.getMinutes()).padStart(2,'0')}`;
  doc.text(`Diagnosis S.A. - Generado el ${dateStr}`, 105, 280, { align: "center" });
  doc.text("argentinadiagnosis@gmail.com", 105, 285, { align: "center" });

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

function showSearch()   { openPanel('searchPanel'); }
function hideSearch()   { el('searchPanel').classList.add('hidden'); }
function showFleet()    { openPanel('fleetPanel'); }
function hideFleet()    { el('fleetPanel').classList.add('hidden'); }
function showDetails()  { openPanel('detailsPanel');  el('detailsPanel').classList.remove('minimized'); }
function hideDetails()  { el('detailsPanel').classList.add('hidden'); }
function showStatus()   { openPanel('statusPanel'); }
function hideStatus()   { el('statusPanel').classList.add('hidden'); }

// ===== Flechas de dirección =====
function bearingDeg([lat1, lon1], [lat2, lon2]) {
  const toRad = (x) => x * Math.PI / 180;
  const toDeg = (x) => x * 180 / Math.PI;
  const φ1 = toRad(lat1), φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1)*Math.sin(φ2) - Math.sin(φ1)*Math.cos(φ2)*Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

window.App = {
  get state() { return { user, token, devices, deviceMeta, markers, currentDevice, loginPassword }; },
  setDeviceMeta(newMeta) { deviceMeta = newMeta; },
  getDisplayName,
  getDeviceMeta,
  renderFleet
};

function makeArrowIcon(angleDeg) {
  const size = 20;
  const rot = normDeg(angleDeg + ARROW_OFFSET_DEG);
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

function addRouteArrows(latlngs) {
  if (!latlngs || latlngs.length < 2) return;
  const maxArrows = 50;
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
    routeMarkers.push(arrow);
  }
}

function setAuthDebug(obj) {
  const dbg = document.getElementById('authDebug');
  if (!dbg) return;
  dbg.textContent = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
}
function setUnitsCount(n) { el('unitsCount').textContent = n; }

function showAuthPane() {
  el('authPane').classList.remove('hidden');
  el('mapPane').classList.add('hidden');
  document.querySelector('.topbar').classList.add('hidden');
}
function showMapPane() {
  el('authPane').classList.add('hidden');
  el('mapPane').classList.remove('hidden');
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
  if (ev === 'stale') iconUrl = `assets/${String(type).toLowerCase()}_sindatos.svg`;
  else iconUrl = iconByTypeAndEvent(type, ev);

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
    const t = new Date(js?.timestamp || Date.now());
    fillDetailsPanel({
      deviceId,
      ts: t,
      ev: d.ev ?? 0,
      v: d.v ?? '-',
      sg: d.sg ?? '-',
      lat: Number(d.la ?? 0),
      lon: Number(d.lo ?? 0),
      bt: parseBattery(d.Bt ?? d.bt ?? d.battery),
    });
    showDetails();
  } catch (e) {
    console.error('onMarkerClick', e);
    showToast('No se pudo leer el último reporte');
    window.dispatchEvent(new CustomEvent('app:device-selected', { detail: { id: deviceId } }));
  }
}

function fillDetailsPanel({ deviceId, ts, ev, v, sg, lat, lon, bt }) {
  const display = getDisplayName(deviceId);
  el('dpDevice').textContent = `${display} (${deviceId})`;

  const meta = getDeviceMeta(deviceId) || {};
  setText('dpPlate', meta.plate);
  setText('dpBrand', meta.brand);
  setText('dpModel', meta.model);
  setText('dpColor', meta.color);

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
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!p.addr && p.lat && p.lon) {
      try {
        p.addr = await reverseGeocode(p.lat, p.lon);
      } catch {
        p.addr = '';
      }
      if (i % 5 === 0) await sleep(300);
    }
  }
}

// =================== carga de últimos puntos ===================
async function loadLastPoints(ids) {
  if (!ids || !ids.length) { setUnitsCount(0); return; }

  lastInfo   = {};
  transitIds = [];
  detenidoIds = [];
  sinRepIds  = [];

  const transitSet  = new Set();
  const detenidoSet = new Set();
  const sinRepSet   = new Set();

  const now = Date.now();
  const isStale = (t) => (now - t) >= 5 * 3600 * 1000; // ≥5h

  const bounds = [];
  for (const idRaw of ids) {
    const id = String(idRaw).trim();
    try {
      const js = await apiLastReading(id);
      const d = js?.data || {};
      const ts = new Date(js?.timestamp || js?.ts || Date.now());

      const lat = Number(d.la ?? d.lat ?? 0);
      const lon = Number(d.lo ?? d.lon ?? 0);
      const ev  = Number(d.ev ?? d.e  ?? 0);
      const stale = isStale(ts.getTime());

      if (isFinite(lat) && isFinite(lon) && lat !== 0 && lon !== 0) {
        if (stale) ensureMarker(id, lat, lon, 'stale');
        else       ensureMarker(id, lat, lon, ev);
        bounds.push([lat, lon]);
      }

      lastInfo[id] = { ev, ts, lat, lon, stale };

      if (stale) {
        sinRepSet.add(id);
      } else if (ev === 10 || ev === 31) {
        transitSet.add(id);
      } else if (ev === 11 || ev === 30) {
        detenidoSet.add(id);
      }
    } catch (e) {
      console.error('last-reading error', id, e);
    }
  }

  transitIds  = Array.from(transitSet);
  detenidoIds = Array.from(detenidoSet);
  sinRepIds   = Array.from(sinRepSet);

  setUnitsCount(Object.keys(markers).length);
  updateStatusPanel({
    username: user?.alias || '-',
    total: Array.from(new Set(ids.map(x => String(x).trim()))).length,
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

  if (!deviceId) { showToast('Seleccione un vehículo'); return; }
  if (!fromStr || !toStr) { showToast('Complete ambas fechas'); return; }

  const from = new Date(fromStr + ':00');
  const to = new Date(toStr + ':00');

  if (isNaN(from.getTime()) || isNaN(to.getTime())) { showToast('Fechas inválidas'); return; }
  if (to < from) { showToast('La fecha "Hasta" debe ser posterior a "Desde"'); return; }

  el('reportMsg').textContent = 'Calculando...';
  el('reportResult').style.display = 'none';

  try {
    const points = await apiReadingsRange(deviceId, from, to);

    if (!points || points.length === 0) {
      el('reportMsg').textContent = 'No hay datos en el período seleccionado';
      return;
    }

    let totalKm = 0;
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1];
      const curr = points[i];
      if (prev.lat && prev.lon && curr.lat && curr.lon) {
        const dist = haversineKm(prev.lat, prev.lon, curr.lat, curr.lon);
        if (dist < 5) totalKm += dist;
      }
    }

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
  const pts = [];
  idList.forEach(id => {
    const m = markers[id];
    if (m) pts.push(m.getLatLng());
  });
  if (!pts.length) { showToast('No hay posiciones para ese grupo'); return; }
  map.fitBounds(pts, { padding: [24,24] });
}

// =================== flota (lista) ===================
function renderFleet(ids) {
  const ul = el('fleetList');
  ul.innerHTML = ids.map(id => {
    const name = getDisplayName(id);
    return `<li><strong>${name}</strong> <span class="muted">(${id})</span> <button data-id="${id}" class="btn">Ver</button></li>`;
  }).join('');

  ul.onclick = (ev) => {
    const b = ev.target.closest('button[data-id]');
    if (!b) return;
    const id = b.getAttribute('data-id').trim();
    const m  = markers[id];

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
  setTimeout(() => { if (map) map.invalidateSize(); }, 200);
}

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
    // SIN invertir signos
    latlngs.push([p.lat, p.lon]);

    const marker = L.circleMarker([p.lat, p.lon], {
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

  currentPolyline = L.polyline(latlngs, { color:'#2563eb', weight: 4 }).addTo(map);
  addRouteArrows(latlngs);

  if (latlngs.length >= 1) {
    const first = latlngs[0];
    const firstData = points[0];
    const startFlag = L.marker(first, { icon: flagStartIcon, zIndexOffset: 1000 })
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
    const last = latlngs[latlngs.length - 1];
    const lastData = points[points.length - 1];
    const endFlag = L.marker(last, { icon: flagEndIcon, zIndexOffset: 1000 })
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

const btnMenu = document.getElementById('btnMenu');
const menuContent = document.getElementById('menuContent');

if (btnMenu && menuContent) {
  btnMenu.addEventListener('click', (e) => {
    e.stopPropagation();
    menuContent.classList.toggle('hidden');
  });
  document.addEventListener('click', () => {
    menuContent.classList.add('hidden');
  });
  menuContent.addEventListener('click', (e) => {
    e.stopPropagation();
  });
}

document.getElementById('menuExit').addEventListener('click', onLogout);
document.getElementById('menuReports')?.addEventListener('click', (e) => {
  e.preventDefault();
  showReports();
});

el('btnCloseReports')?.addEventListener('click', hideReports);
el('btnGenerateReport')?.addEventListener('click', generateKmReport);
el('btnDownloadReport')?.addEventListener('click', downloadReportPDF);

// Referencias (dropdown)
const btnRefs = document.getElementById('btnRefs');
const refsContent = document.getElementById('refsContent');

if (btnRefs && refsContent) {
  btnRefs.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = refsContent.classList.toggle('hidden');
    btnRefs.setAttribute('aria-expanded', String(!open));
  });
  refsContent.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => {
    refsContent.classList.add('hidden');
    btnRefs.setAttribute('aria-expanded', 'false');
  });
}

async function onLogin() {
  const username = el('username').value.trim(); // alias
  const password = el('password').value.trim();
  loginPassword = password;
  if (!username || !password) { showToast('Usuario y contraseña requeridos'); return; }

  if (window.matchMedia('(max-width: 1024px)').matches) setSidebarCollapsed(true);

  try {
    // Login Valle -> set token
    const res = await apiLogin({ username, password });
    token = res.token; user = res.user; userMetadata = res.metadata || null;
    setAuthToken(token);

    // Flota AUTORIZADA según metadata del usuario
    deviceMeta = userMetadata?.devices_meta || {};
    devices = (userMetadata?.devices || []).map(String);

    // Mostrar UI
    showMapPane();
    if (!map) initMap();

    // Limpieza
    nukeNonBaseLayers();
    clearAllMarkers();
    clearRoute();
    resetSessionState();

    el('spUser').textContent = user?.alias || user?.name || '-';
    showStatus();

    // Renderizar flota (autorizados) + cargar últimos puntos si hay
    renderFleet(devices);
    if (devices.length) await loadLastPoints(devices);

    setAuthDebug({ login: { user, metadata: userMetadata }, devicesCount: devices.length });
    showToast(devices.length ? `Login ok: ${devices.length} dispositivos` : 'Login ok: sin dispositivos autorizados');
  } catch (e) {
    setAuthDebug(String(e));
    if (String(e).includes('TypeError')) showToast('Error de red/CORS. Ver consola.');
    else showToast('Login falló');
  }
  window.dispatchEvent(new CustomEvent('app:logged-in', { detail: { user } }));
}

function onLogout() {
  nukeNonBaseLayers();
  clearAllMarkers();
  clearRoute();
  resetSessionState();

  token = null; user = null; userMetadata = null; devices = [];
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
  showFleetMarkers();
  loadLastPoints(devices);
}

// chips "Ver hoy"
function onChipsClick(ev) {
  const b = ev.target.closest('button.chip');
  if (!b || !currentDevice) return;
  const minutes = Number(b.getAttribute('data-min') || 0);
  if (!minutes) return;
  const to   = new Date();
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
  if (to < from) { showToast('La fecha es inválida'); return; }
  fetchAndDrawRange(currentDevice, from, to);
}

// ====== Paradas (detenciones) ======
const STOP_DIAMETER_M = 20;
const STOP_RADIUS_M   = STOP_DIAMETER_M / 2;
const STOP_MIN_POINTS = 3;
const STOP_MIN_DURATION_MS = 5 * 60 * 1000;

function haversineMeters([lat1, lon1], [lat2, lon2]) {
  const toRad = (x) => x * Math.PI / 180;
  const R = 6371000;
  const φ1 = toRad(lat1), φ2 = toRad(lat2);
  const Δφ = toRad(lat2 - lat1);
  const Δλ = toRad(lon2 - lon1);
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function addStopBadge(centerLatLng, startTs, endTs) {
  const durMs  = (endTs instanceof Date ? endTs.getTime() : new Date(endTs).getTime()) -
                 (startTs instanceof Date ? startTs.getTime() : new Date(startTs).getTime());
  const mins   = Math.max(1, Math.round(durMs / 60000));
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

function annotateStops(points, latlngs) {
  if (!latlngs || latlngs.length === 0) return;

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
      count += 1;
      sumLat += lat;
      sumLon += lon;
      center = [sumLat / count, sumLon / count];
    } else {
      flushCluster(i);
      clusterStartIdx = i;
      count = 1;
      sumLat = lat;
      sumLon = lon;
      center = [lat, lon];
    }
  }
  flushCluster(latlngs.length);
}

// descargar CSV
async function onDownloadCsv() {
  if (!currentRoute.length || !currentDevice) return;
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
    address: p.addr || ''
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
el('btnMinimizeDetails')?.addEventListener('click', () => {
  const panel = el('detailsPanel');
  const btn   = el('btnMinimizeDetails');
  panel.classList.toggle('minimized');
  const minimized = panel.classList.contains('minimized');
  btn.textContent = minimized ? '▴' : '▾';
  btn.title = minimized ? 'Expandir' : 'Minimizar';
});

el('btnCloseDetails').addEventListener('click', async () => {
  hideDetails();
  clearRoute();
  showFleetMarkers();
  if (devices?.length) await loadLastPoints(devices);
});

el('btnApplyRange').addEventListener('click', onApplyRange);
el('btnDownload').addEventListener('click', onDownloadCsv);

el('detailsPanel').addEventListener('click', (ev) => {
  if (ev.target.closest('.chips')) onChipsClick(ev);
});

el('btnLocate').addEventListener('click', async () => {
  if (!map) return;
  if (!navigator.geolocation) { showToast('Geolocalización no disponible'); return; }

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude, longitude } = pos.coords;
      map.setView([latitude, longitude], 14);

      if (window.currentLocationMarker) {
        map.removeLayer(window.currentLocationMarker);
      }

      window.currentLocationMarker = L.circleMarker([latitude, longitude], {
        radius: 8,
        fillColor: "#3388ff",
        color: "#ffffff",
        weight: 2,
        opacity: 1,
        fillOpacity: 0.8
      }).addTo(map);

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
        case error.PERMISSION_DENIED:  message = 'Permiso de ubicación denegado'; break;
        case error.POSITION_UNAVAILABLE: message = 'Información de ubicación no disponible'; break;
        case error.TIMEOUT: message = 'Tiempo de espera agotado para obtener la ubicación'; break;
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
