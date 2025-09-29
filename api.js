// api.js
import { API_BASE } from './utils.js';

async function doJson(url, opts={}) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  const fetchOpts = Object.assign({ mode: 'cors' }, opts, { headers });
  const r = await fetch(url, fetchOpts);
  if (!r.ok) {
    const text = await r.text().catch(()=> '');
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

// —— NUEVO: siempre formatear en UTC, con 'Z' ——
// Si tu backend NO soporta la 'Z', cambiá `return s + 'Z'` por `return s`
function formatUTCForAPI(date) {
  const pad = (n) => n.toString().padStart(2, '0');
  const y = date.getUTCFullYear();
  const m = pad(date.getUTCMonth() + 1);
  const d = pad(date.getUTCDate());
  const H = pad(date.getUTCHours());
  const M = pad(date.getUTCMinutes());
  const S = pad(date.getUTCSeconds());
  return `${y}-${m}-${d}T${H}:${M}:${S}Z`;
}

// Procesar item → puntos
function processDataItem(item, points) {
  const d  = item.data || {};
  const ts = new Date(item.timestamp || item.ts || Date.now());

  const lat = parseFloat(d.la ?? d.lat ?? 0);
  const lon = parseFloat(d.lo ?? d.lon ?? 0);

  if (!isNaN(lat) && !isNaN(lon) && lat !== 0 && lon !== 0) {
    points.push({
      lat,
      lon,
      v: parseInt(d.v ?? 0),
      ev: parseInt(d.ev ?? d.e ?? 0),
      sg: d.sg ?? '',
      ts,
      raw: item
    });
  }
}



export async function apiUpdateUser(userId, payload, token = null) {
  if (!userId) throw new Error('Falta userId');
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const url = `${API_BASE}/user/update/${encodeURIComponent(userId)}`;
  const r = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });

  if (!r.ok) {
    const txt = await r.text().catch(()=>'');
    throw new Error(`HTTP ${r.status} – ${txt || 'Error en update'}`);
  }
  const ct = r.headers.get('content-type') || '';
  return ct.includes('application/json') ? r.json() : r.text();
}





export async function apiReadingsRange(
  deviceId,
  start,
  end,
  topic = 'diagnosis.gps2',
  maxPages = 10,
  pageSize = 200
) {
  async function fetchOnce(topicToUse) {
    const points = [];
    let page = 1;
    let hasMore = true;

    const dateFromStr = formatUTCForAPI(start);
    const dateToStr   = formatUTCForAPI(end);

    while (page <= maxPages && hasMore) {
      const url = `${API_BASE}/device/${deviceId}/readings` +
        `?page=${page}&limit=${pageSize}` +
        `&topic=${encodeURIComponent(topicToUse)}` +
        `&dateFrom=${encodeURIComponent(dateFromStr)}` +
        `&dateTo=${encodeURIComponent(dateToStr)}`;

      const response = await fetch(url);
      if (!response.ok) {
        const errorText = await response.text().catch(()=>'');
        throw new Error(`HTTP ${response.status}: ${errorText || 'No se pudieron obtener los datos'}`);
      }

      const result = await response.json();
      const arr = Array.isArray(result) ? result : (Array.isArray(result?.data) ? result.data : []);
      if (!arr.length) {
        hasMore = false;
      } else {
        arr.forEach(item => processDataItem(item, points));
        // si tu backend soporta 'hasMore' en el payload, usalo; si no, corta en una sola página:
        hasMore = false;
      }
      page++;
    }

    points.sort((a, b) => a.ts - b.ts);
    return points;
  }

  // 1) intentá con el topic indicado
  let pts = await fetchOnce(topic);

  // 2) si no hay puntos, probá con un fallback común
  if (!pts.length && topic === 'diagnosis.gps2') {
    try {
      pts = await fetchOnce('diagnosis.gps'); // fallback
    } catch { /* ignorar */ }
  }

  return pts;
}
