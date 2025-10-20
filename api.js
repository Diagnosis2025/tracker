// api.js — Valle API + normalización robusta + fallback local para histórico
import { API_BASE } from './utils.js';

let AUTH_TOKEN = null;

export function setAuthToken(token) {
  AUTH_TOKEN = token || null;
}

// === ACTUALIZAR USUARIO ===
// === UPDATE USER METADATA (reemplaza metadata completo) ===
export async function apiUpdateUserMetadata(userId, metadata, token) {
  if (!userId) throw new Error('apiUpdateUserMetadata: falta userId');
  const url = `${API_BASE}/users/${encodeURIComponent(userId)}/metadata`;
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  // El backend define PATCH que reemplaza metadata completo con el objeto enviado
  return await doJson(url, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(metadata),
  });
}

// PUT por defecto; si el backend solo acepta PATCH, hacemos fallback automático.


async function doJson(url, opts = {}) {
  const baseHeaders = { 'Content-Type': 'application/json' };
  if (AUTH_TOKEN) baseHeaders['Authorization'] = `Bearer ${AUTH_TOKEN}`;

  const headers = Object.assign(baseHeaders, opts.headers || {});
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

// -------------------- AUTH --------------------
export async function apiLogin({ username, password }) {
  // En Valle es alias + password
  const body = { alias: username, password };
  const res = await doJson(`${API_BASE}/auth/login`, {
    method: 'POST',
    body: JSON.stringify(body)
  });
  const token = res?.accessToken;
  if (!token) throw new Error('Login sin accessToken.');
  setAuthToken(token);

  // metadata puede venir en res.metadata o res.user.metadata
  const metadata = res?.metadata || res?.user?.metadata || null;

  return { token, user: res.user, metadata };
}

// --------------- Timestamps y coords ---------------
function parseValleTimestamp({ dateTime, date, time, data }) {
  // 1) ISO estándar YYYY-MM-DDTHH:mm:ssZ
  if (dateTime && /^\d{4}-\d{2}-\d{2}T/.test(dateTime)) return new Date(dateTime);

  // 2) Compacto YYMMDDTHHMMSSZ (ej: 251017T210852Z)
  if (dateTime && /^\d{6}T\d{6}Z$/.test(dateTime)) {
    const yy = +dateTime.slice(0,2), mm = +dateTime.slice(2,4), dd = +dateTime.slice(4,6);
    const HH = +dateTime.slice(7,9),  MM = +dateTime.slice(9,11), SS = +dateTime.slice(11,13);
    return new Date(Date.UTC(2000+yy, mm-1, dd, HH, MM, SS));
  }

  // 3) Separado date/time (YYMMDD / HHMMSS)
  if (/^\d{6}$/.test(date||'') && /^\d{6}$/.test(time||'')) {
    const yy = +date.slice(0,2), mm = +date.slice(2,4), dd = +date.slice(4,6);
    const HH = +time.slice(0,2),  MM = +time.slice(2,4), SS = +time.slice(4,6);
    return new Date(Date.UTC(2000+yy, mm-1, dd, HH, MM, SS));
  }

  // 4) f/h dentro de data => f: YYYY-MM-DD, h: HHMMSS
  const f = data?.f, h = data?.h;
  if (/^\d{4}-\d{2}-\d{2}$/.test(f||'') && /^\d{6}$/.test(h||'')) {
    const [Y,M,D] = f.split('-').map(Number);
    const HH = +h.slice(0,2),  MM = +h.slice(2,4), SS = +h.slice(4,6);
    return new Date(Date.UTC(Y, M-1, D, HH, MM, SS));
  }

  // Fallback: ahora
  return new Date();
}

function coordsToLatLon(location, data) {
  // Preferir GeoJSON [lon, lat]
  const arr = location?.coordinates;
  if (Array.isArray(arr) && arr.length >= 2) {
    const [lon, lat] = arr;
    return { lat: Number(lat), lon: Number(lon) };
  }
  // Fallback a la nueva trama (la/lo como strings/números)
  const la = Number(data?.la), lo = Number(data?.lo);
  if (Number.isFinite(la) && Number.isFinite(lo)) return { lat: la, lon: lo };
  return { lat: null, lon: null };
}

function fallbackEventFromSpeed(v) {
  const speed = Number.isFinite(Number(v)) ? Number(v) : 0;
  return speed > 0 ? 10 : 11;
}

// --------------- Normalizaciones ---------------
export function normalizeLastReading(raw) {
  const d = raw?.data || {};
  const devId = raw?.deviceId ?? raw?.id;

  const ts = parseValleTimestamp({
    dateTime: raw?.dateTime,
    date: raw?.date,
    time: raw?.time,
    data: d
  });

  const { lat, lon } = coordsToLatLon(raw?.location, d);

  const v  = d.v ?? 0;
  const ev = d.ev ?? d.e ?? fallbackEventFromSpeed(v);
  const sg = d.sg ?? d.q ?? d.signal ?? null;     // q → señal
  const Bt = d.Bt ?? d.b ?? d.bt ?? null;         // b → batería

  return {
    deviceId: devId,
    timestamp: ts.toISOString(),
    data: {
      ...d,
      la: lat,
      lo: lon,
      v,
      ev,
      sg,
      Bt
    },
    _raw: raw
  };
}

export function normalizeHistoryItem(it) {
  const d = it?.data || {};
  const devId = it?.deviceId ?? it?.id;

  const ts = parseValleTimestamp({
    dateTime: it?.dateTime,
    date: it?.date,
    time: it?.time,
    data: d
  });

  const { lat, lon } = coordsToLatLon(it?.location, d);

  const v  = Number(d.v ?? 0) || 0;
  const ev = Number(d.ev ?? d.e ?? fallbackEventFromSpeed(v)) || 0;
  const sg = d.sg ?? d.q ?? d.signal ?? '';

  return {
    deviceId: devId,
    lat, lon, v, ev, sg,
    Bt: d.Bt ?? d.b ?? d.bt,
    ts,
    raw: it
  };
}

// -------------------- GPS --------------------

// 1) Listar dispositivos disponibles (último punto por device)
export async function apiListAvailable({ page = 1, limit = 50, sort = 'desc' } = {}) {
  return doJson(`${API_BASE}/proxy/gps/device/available?page=${page}&limit=${limit}&sort=${encodeURIComponent(sort)}`);
}

// 2) Última lectura de un device
export async function apiLastReading(deviceId) {
  const raw = await doJson(`${API_BASE}/proxy/gps/device/${encodeURIComponent(deviceId)}/last-reading`);
  return normalizeLastReading(raw);
}

// 3) Últimas lecturas de varios devices (bulk)
export async function apiLastReadingsBulk(deviceIds = []) {
  if (!deviceIds.length) return [];
  const url = `${API_BASE}/proxy/gps/device/last-reading?ids=${encodeURIComponent(deviceIds.join(','))}`;
  const arr = await doJson(url);
  return (arr || []).map(normalizeLastReading);
}

// 4) Histórico por rango (con fallback local)
export async function apiReadingsRange(
  deviceId,
  start,
  end,
  { page = 1, limit = 200, maxPages = 10, topic = 'valle.gps' } = {}
) {
  // a) Intento oficial con fechas (end-exclusive → end+1 día)
  const formatDateYYYYMMDD_Local = (date) => {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  };
  const endPlusOne = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1);
  const dateFrom = formatDateYYYYMMDD_Local(start);
  const dateTo   = formatDateYYYYMMDD_Local(endPlusOne);

  try {
    const url1 = `${API_BASE}/proxy/gps/device/${encodeURIComponent(deviceId)}/readings`
      + `?dateFrom=${encodeURIComponent(dateFrom)}`
      + `&dateTo=${encodeURIComponent(dateTo)}`
      + `&page=${page}&limit=${limit}`
      + `&topic=${encodeURIComponent(topic)}`;

    const res1 = await doJson(url1);
    const arr1 = Array.isArray(res1?.data) ? res1.data : (Array.isArray(res1) ? res1 : []);
    if (arr1.length) {
      // NORMALIZO Y FILTRO POR LA FRANJA HORARIA EXACTA [start, end)
      const pts = arr1.map(normalizeHistoryItem).filter((pt) => {
        const t = (pt.ts instanceof Date) ? pt.ts : new Date(pt.ts);
       return t >= start && t < end; // filtra estrictamente por hora
       });
      pts.sort((a, b) => a.ts - b.ts);
      return pts;
    }
  } catch (_) {
    // si falla, seguimos al fallback
  }

  // b) Fallback: traer sin fechas (solo topic), paginar y filtrar localmente por [start, endPlusOne)
  const points = [];
  let p = 1;
  let pages = 0;

  while (pages < maxPages) {
    const url2 = `${API_BASE}/proxy/gps/device/${encodeURIComponent(deviceId)}/readings`
      + `?page=${p}&limit=${limit}`
      + `&topic=${encodeURIComponent(topic)}`;

    const res2 = await doJson(url2);
    const arr2 = Array.isArray(res2?.data) ? res2.data : (Array.isArray(res2) ? res2 : []);
    if (!arr2.length) break;

    const chunk = arr2.map(normalizeHistoryItem);
    for (const pt of chunk) {
      const t = (pt.ts instanceof Date) ? pt.ts : new Date(pt.ts);
      if (t >= start && t < end) points.push(pt);
    }

    p++; pages++;
    if (res2?.meta && res2.meta.hasNext === false) break;
  }

  points.sort((a, b) => a.ts - b.ts);
  return points;
}

// 5) Dispositivos cercanos
export async function apiNear({ lat, lon, distance = 5000, page = 1, limit = 20 }) {
  const url = `${API_BASE}/proxy/gps/device/near?lat=${encodeURIComponent(lat)}&long=${encodeURIComponent(lon)}`
            + `&distance=${encodeURIComponent(distance)}&page=${page}&limit=${limit}`;
  return doJson(url);
}
