// load-csv.js - Carga y parsing de CSV, sin tocar el mapa.
// Entrega los puntos a app.js vía callbacks.

import { showToast } from './utils.js';

let csvModuleInitialized = false;
// Callbacks inyectados desde app.js
let onRouteLoadedCb = null;
let onClearRequestedCb = null;

export function initCSVModule({ onRouteLoaded, onClearRequested } = {}) {
  if (csvModuleInitialized) return;
  onRouteLoadedCb   = typeof onRouteLoaded   === 'function' ? onRouteLoaded   : null;
  onClearRequestedCb= typeof onClearRequested=== 'function' ? onClearRequested: null;

  // Botón "Cargar ruta desde archivo .csv" (id=menuLoadCSV)
const menuLoadCSV = document.getElementById('menuLoadCSV');
if (menuLoadCSV) {
  menuLoadCSV.addEventListener('click', (e) => {
    e.preventDefault();            // ← evita que navegue a "#"
    handleCSVLoad();
  });
}


  // Botón "Limpiar Ruta CSV" (id=menuClearCSV). Si no existe, lo creo.
  let menuClearCSV = document.getElementById('menuClearCSV');
  if (!menuClearCSV) {
    menuClearCSV = document.createElement('div');
    menuClearCSV.id = 'menuClearCSV';
    menuClearCSV.className = 'menu-item';
    menuClearCSV.innerHTML = '<span class="menu-icon">🗑️</span> Limpiar Ruta CSV';
    const menuContent = document.getElementById('menuContent');
    if (menuContent) menuContent.appendChild(menuClearCSV);
  }
  menuClearCSV.addEventListener('click', () => {
    if (onClearRequestedCb) onClearRequestedCb();
  });

  csvModuleInitialized = true;
}

// ========== UI: seleccionar archivo ==========
function handleCSVLoad() {
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.csv';
  fileInput.addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    if (file) processCSVFile(file);
  });
  fileInput.click();
}

function processCSVFile(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const csvData = e.target.result;
      const routePoints = parseCSVData(csvData);
      if (routePoints.length > 0) {
        showToast(`Archivo CSV cargado: ${routePoints.length} puntos`);
        if (onRouteLoadedCb) onRouteLoadedCb(routePoints);
      } else {
        showToast('El archivo CSV no contiene datos válidos');
      }
    } catch (error) {
      console.error('Error procesando CSV:', error);
      showToast('Error al procesar el archivo CSV: ' + error.message);
    }
  };
  reader.onerror = () => showToast('Error al leer el archivo');
  reader.readAsText(file, 'utf-8'); // fuerza UTF-8 (ayuda con acentos)
}

// ========== Parsing CSV ==========
function normalize(str) {
  return (str || '')
    .trim()
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, ''); // saca tildes
}

// CSV robusto (maneja comillas y comillas escapadas)
function parseCSVLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (ch === ',' && !inQuotes) {
      values.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  values.push(current);
  return values;
}

function parseCSVData(csvData) {
  // separa por líneas (soporta \r\n)
  const lines = csvData.replace(/\r/g, '').split('\n').filter(l => l.trim().length);
  if (lines.length < 2) return [];

  // Header
  const headerRaw = parseCSVLine(lines[0]);
  const header = headerRaw.map(h => normalize(h));

  // Buscar índices por nombre (soporta variantes mal decodificadas)
  const idx = (names) => header.findIndex(h => names.map(normalize).includes(h));

  const iLat  = idx(['latitud', 'lat', 'latitude']);
  const iLon  = idx(['longitud', 'lon', 'long', 'longitude']);
  const iFec  = idx(['fecha', 'date']);
  const iHor  = idx(['hora', 'time']);
  const iVel  = idx(['velocidad (km/h)', 'velocidad', 'speed']);
  const iEvt  = idx(['evento', 'event']);
  const iSen  = idx(['senal 4g', 'señal 4g', 'senial 4g']);      // seÃ±al → normalizado
  const iDir  = idx(['direccion', 'dirección', 'address', 'direccion']);

  if ([iLat,iLon,iFec,iHor].some(x => x < 0)) {
    throw new Error('Encabezados inválidos. Se requieren Latitud, Longitud, Fecha y Hora.');
  }

  const decode = (s) => (s || '')
    .replace(/Ã¡/g,'á').replace(/Ã©/g,'é').replace(/Ã­/g,'í').replace(/Ã³/g,'ó').replace(/Ãº/g,'ú')
    .replace(/Ã±/g,'ñ').replace(/Ã/g,'Á').replace(/Ã/g,'É').replace(/Ã/g,'Í').replace(/Ã/g,'Ó')
    .replace(/Ã/g,'Ú').replace(/Ã/g,'Ñ').replace(/Ã¼/g,'ü').replace(/Ã–/g,'Ö').replace(/ÃŸ/g,'ß')
    .replace(/Â°/g,'°');

  const routePoints = [];

  for (let li = 1; li < lines.length; li++) {
    const parts = parseCSVLine(lines[li]).map(s => s.replace(/^"|"$/g, '').trim());
    if (!parts.length) continue;

    const lat = parseFloat(parts[iLat]);
    const lon = parseFloat(parts[iLon]);
    const fecha = parts[iFec];
    const hora  = parts[iHor];

    if (Number.isNaN(lat) || Number.isNaN(lon) || lat === 0 || lon === 0) continue;

    // timestamp
    const [Y,M,D] = (fecha || '').split('-').map(n => parseInt(n,10));
    const [h,m,s] = (hora  || '').split(':').map(n => parseInt(n,10));
    const ts = new Date(Y || 1970, (M||1)-1, D||1, h||0, m||0, s||0);

    const vel = iVel >= 0 ? parseInt(parts[iVel], 10) || 0 : 0;
    const evText = iEvt >= 0 ? decode(parts[iEvt]) : '';
    const sg  = iSen >= 0 ? decode(parts[iSen]) : '';
    const addr= iDir >= 0 ? decode(parts[iDir]) : '';

    // mapear texto a código (coincide con tu app.js)
    let ev = 0;
    const t = normalize(evText);
    if (t.includes('transito') || t.includes('tránsito') || t.includes('encendido') || t.includes('motor encendido')) ev = 10;
    else if (t.includes('detenido') || t.includes('motor detenido')) ev = 11;

    routePoints.push({
      lat, lon, ts, v: vel, ev,
      sg, addr
    });
  }

  return routePoints;
}
