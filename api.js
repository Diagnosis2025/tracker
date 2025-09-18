import { API_BASE } from './utils.js';

async function doJson(url, opts={}) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  const fetchOpts = Object.assign({ mode: 'cors' }, opts, { headers });
  const r = await fetch(url, fetchOpts);
  if (!r.ok) {
    const text = await r.text().catch(()=>'');
    throw new Error(`HTTP ${r.status} ${r.statusText} – ${text}`);
  }
  const ct = r.headers.get('content-type') || '';
  if (ct.includes('application/json')) return await r.json();
  const txt = await r.text();
  try { return JSON.parse(txt); } catch { return { raw: txt }; }
}

export async function apiCreateUser({ username, password, devices=[], tipo='', nivel=null }) {
  const body = { username, password, data: {} };
  if (Array.isArray(devices) && devices.length) body.data.devices = devices;
  if (tipo) body.data.tipo = tipo;
  if (nivel !== null && nivel !== undefined && nivel !== '') body.data.nivel = Number(nivel);
  return doJson(`${API_BASE}/user/create`, { method: 'POST', body: JSON.stringify(body) });
}

export async function apiLogin({ username, password }) {
  return doJson(`${API_BASE}/auth/login`, { method: 'POST', body: JSON.stringify({ username, password }) });
}

export async function apiLastReading(deviceId) {
  return doJson(`${API_BASE}/device/${deviceId}/last-reading`, { method: 'GET' });
}

// Paginado y filtrado por rango en cliente
// Reemplazar la función apiReadingsRange con esta versión corregida
export async function apiReadingsRange(deviceId, start, end, topic = 'diagnosis.gps2', maxPages = 10, pageSize = 200) {
  const points = [];
  let page = 1;
  let hasMore = true;
  
  console.log(`Buscando datos para dispositivo ${deviceId} desde ${start} hasta ${end}`);
  
  // Formatear fechas en el formato que espera la API: YYYY-MM-DDTHH:mm:ss
  const formatDateForAPI = (date) => {
    const pad = (n) => n.toString().padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  };
  
  const dateFromStr = formatDateForAPI(start);
  const dateToStr = formatDateForAPI(end);
  
  console.log(`Fecha formateada desde: ${dateFromStr}`);
  console.log(`Fecha formateada hasta: ${dateToStr}`);
  
  try {
    while (page <= maxPages && hasMore) {
      // URL CORREGIDA - el deviceId va antes de /readings
      const url = `${API_BASE}/device/${deviceId}/readings?page=${page}&limit=${pageSize}&topic=${encodeURIComponent(topic)}&dateFrom=${encodeURIComponent(dateFromStr)}&dateTo=${encodeURIComponent(dateToStr)}`;
      
      console.log(`Consultando URL: ${url}`);
      
      const response = await fetch(url);
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Error ${response.status}: ${errorText}`);
        throw new Error(`HTTP ${response.status}: No se pudieron obtener los datos`);
      }
      
      const result = await response.json();
      
      // Verificar estructura de respuesta
      if (!result || !Array.isArray(result)) {
        console.error('Estructura inesperada:', result);
        // Intentar con otra estructura
        if (result && result.data && Array.isArray(result.data)) {
          console.log('Usando estructura alternativa con propiedad data');
          result.data.forEach(item => processDataItem(item, points));
        } else {
          break;
        }
      } else {
        // Estructura esperada: array directo
        result.forEach(item => processDataItem(item, points));
      }
      
      // Simplificar: asumir que no hay más páginas por ahora
      hasMore = false;
      page++;
    }
    
    // Ordenar por tiempo
    points.sort((a, b) => a.ts - b.ts);
    console.log(`Total de puntos encontrados: ${points.length}`);
    return points;
    
  } catch (error) {
    console.error('Error en apiReadingsRange:', error);
    throw new Error(`No se pudieron obtener los datos: ${error.message}`);
  }
}

// Función auxiliar para procesar items de datos
function processDataItem(item, points) {
  const d = item.data || {};
  const ts = new Date(item.timestamp || item.ts || Date.now());
  
  const lat = parseFloat(d.la || d.lat || 0);
  const lon = parseFloat(d.lo || d.lon || 0);
  
  // Solo agregar si tiene coordenadas válidas
  if (!isNaN(lat) && !isNaN(lon) && lat !== 0 && lon !== 0) {
    points.push({
      lat: lat,
      lon: lon,
      v: parseInt(d.v || 0),
      ev: parseInt(d.ev || d.e || 0),
      sg: d.sg || '',
      ts: ts,
      raw: item
    });
  }
}