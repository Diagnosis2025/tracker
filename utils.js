export const API_BASE = "https://valle.api.dstechhub.com";

export function showToast(msg, ms=2500) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  setTimeout(() => t.classList.add('hidden'), ms);
}

const EVENT_MAP = {
  TRANSIT: new Set([10, 31]),
  DETENIDO: new Set([11]),
  APAGADO: new Set([30]),
  PANICO: new Set([20, 21]),
};

export function normalizeType(t) {
  const s = String(t || '').toLowerCase();
  if (s.startsWith('mot')) return 'moto';
  if (s.startsWith('traf')) return 'trafic';
  if (s.startsWith('cam')) return 'camion';
  return 'auto'; // default
}

export function parseDevicesInput(s) {
  if (!s || !s.trim()) return [];
  return s.split(',').map(x => x.trim()).filter(Boolean);
}

// --- Geocodificación inversa con caché (Nominatim) ---
const geocodeCache = new Map();
export async function reverseGeocode(lat, lon) {
  const key = `${Number(lat).toFixed(5)},${Number(lon).toFixed(5)}`;
  if (geocodeCache.has(key)) return geocodeCache.get(key);

  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&zoom=18&addressdetails=1&accept-language=es`;

  const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!r.ok) throw new Error(`Geocode failed: ${r.status}`);
  const j = await r.json();
  const addr = j.display_name || '';
  geocodeCache.set(key, addr || '');
  return addr || '';
}

// Pausa simple para throttling
export function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

export function eventColor(ev) {
  switch (Number(ev)) {
    case 20: return '#ef4444';
    case 31: return '#22c55e';
    case 30: return '#b91c1c';
    case 29: return '#000000';
    case 28: return '#7e22ce';
    case 11: return '#f59e0b';
    case 10: return '#22c55e';
    default: return '#9ca3af';
  }
}

export function eventLabel(ev) {
  switch (Number(ev)) {
    case 20: return 'Pánico';
    case 31: return 'Motor Encendido';
    case 30: return 'Motor Detenido';
    case 29: return 'Sin alimentación';
    case 28: return 'Con alimentación';
    case 11: return 'Detenido';
    case 10: return 'Tránsito';
    default: return `Evento ${ev ?? '-'}`;
  }
}

// Calcular distancia Haversine entre dos puntos (en km)
export function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (x) => x * Math.PI / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function iconByTypeAndEvent(type, ev) {
  const T = normalizeType(type);

  if (ev === 'stale') {
    return `assets/${T}_sindatos.svg`;
  }

  const eventNum = typeof ev === 'string' ? parseInt(ev, 10) : ev;

  if (EVENT_MAP.TRANSIT.has(eventNum))  return `assets/${T}_transito.svg`;
  if (EVENT_MAP.DETENIDO.has(eventNum)) return `assets/${T}_detenido.svg`;
  if (EVENT_MAP.APAGADO.has(eventNum))  return `assets/${T}_apagado.svg`;
  if (EVENT_MAP.PANICO.has(eventNum))   return `assets/${T}_panico.svg`;

  return `assets/${T}_detenido.svg`;
}

export function carIconByEvent(ev) {
  return iconByTypeAndEvent('auto', ev);
}

export function fmtDate(d) {
  const z = n => String(n).padStart(2,'0');
  return `${d.getFullYear()}-${z(d.getMonth()+1)}-${z(d.getDate())}`;
}
export function fmtTime(d) {
  const z = n => String(n).padStart(2,'0');
  return `${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`;
}

export function downloadCsv(filename, rows) {
  const hasAddress = rows.some(r => 'address' in r);
  const header = hasAddress
    ? 'Latitud,Longitud,Fecha,Hora,Velocidad (km/h),Evento,Señal 4G,Dirección'
    : 'Latitud,Longitud,Fecha,Hora,Velocidad (km/h),Evento,Señal 4G';

  const csv = [
    header,
    ...rows.map(r => {
      const arr = [
        r.lat, r.lon,
        r.date, r.time,
        (r.v ?? ''), (r.event ?? ''), (r.sg ?? '')
      ];
      if (hasAddress) arr.push(r.address ?? '');
      return arr.map(v => `"${String(v).replaceAll('"','""')}"`).join(',');
    })
  ].join('\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}
