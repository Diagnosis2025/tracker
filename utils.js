export const API_BASE = "https://diagnosis-api-production.up.railway.app";

export function showToast(msg, ms=2500) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  setTimeout(() => t.classList.add('hidden'), ms);
}

export function parseDevicesInput(s) {
  if (!s || !s.trim()) return [];
  return s.split(',').map(x => x.trim()).filter(Boolean);
}

// --- Geocodificación inversa con caché (Nominatim) ---
const geocodeCache = new Map();
export async function reverseGeocode(lat, lon) {
  // redondeo para cachear “casi” el mismo lugar
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
    case 20: return '#ef4444'; // pánico
    case 31: return '#22c55e'; // motor encendido
    case 30: return '#b91c1c'; // detenido/apagado
    case 29: return '#000000'; // sin alimentación
    case 28: return '#7e22ce'; // con alimentación
    case 11: return '#f59e0b'; // detenido
    case 10: return '#22c55e'; // tránsito
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

// En utils.js - modificar la función carIconByEvent
export function carIconByEvent(ev) {
  // Si recibe el string 'stale', usar icono gris
  if (ev === 'stale') {
    return 'assets/car-gray.svg';
  }
  
  // Lógica original para eventos numéricos
  const eventNum = typeof ev === 'string' ? parseInt(ev) : ev;
  
  switch (eventNum) {
    case 10: // en movimiento
      return 'assets/car_moving_green_play.svg';
    case 31: // movimiento
      return 'assets/car_moving_green_play.svg';
    case 11: // detenido
      return 'assets/car_stopped_green_stop.svg';
    case 210: // en movimiento
      return 'assets/car_red_panic_sos.svg';
    case 30: // detenido
      return 'assets/car_yellow.svg';
    default:
      return 'assets/car-blue.svg';
  }
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


