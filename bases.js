// bases.js
import { apiUpdateUserMetadata } from './api.js';
import { showToast } from './utils.js';

const el = (id) => document.getElementById(id);

function getApp() {
  const app = window.App;
  if (!app || !app.state) throw new Error('App no inicializada');
  return app;
}

// === Permisos: admin o nivel 1 (mismo criterio que editor) ===
function canEditUser(state) {
  const roles = [
    state?.user?.role,
    state?.user?.data?.role,
    state?.user?.metadata?.role,
    state?.metadata?.role,
  ].map(x => String(x || '').toLowerCase());
  const isAdmin  = roles.includes('admin');
  const isNivel1 = Number(state?.user?.data?.nivel || 0) === 1;
  return isAdmin || isNivel1;
}

// === Intentar obtener el mapa de varias formas ===
function getMap() {
  // Si tu app expone el mapa, intentamos en este orden:
  return window.App?.getMap?.()
      || window.App?.state?.map
      || window.map
      || window.__map
      || null;
}

// === Capa para bases ===
let basesLayer = null;

function ensureBasesLayer() {
  const map = getMap();
  if (!map) return null;
  if (!basesLayer) {
    basesLayer = L.layerGroup().addTo(map);
  }
  return basesLayer;
}

function clearBasesOnMap() {
  const layer = ensureBasesLayer();
  if (layer) layer.clearLayers();
}

function drawBaseOnMap(base) {
  const layer = ensureBasesLayer();
  if (!layer) return;

  const pts = Array.isArray(base?.points) ? base.points : [];
  if (pts.length !== 4) return;

  // pts: [[lat,lon], [lat,lon], [lat,lon], [lat,lon]]
  const latlngs = pts.map(p => L.latLng(p[0], p[1]));
  const poly = L.polygon(latlngs, {
    weight: 2,
    fillOpacity: 0.08
  });

  const label = base?.name ? `🏢 ${base.name}` : 'Base';
  poly.bindTooltip(label, {
    permanent: true,
    direction: 'center',
    className: 'marker-label'
  });
  layer.addLayer(poly);
}

function renderAllBasesOnMap(basesArr) {
  clearBasesOnMap();
  (basesArr || []).forEach(drawBaseOnMap);
}

// === Metadata helpers ===
function readBaseMetadata(state) {
  // Prioridad: state.metadata → state.user.metadata → state.user.data
  const meta =
    (state?.metadata && typeof state.metadata === 'object') ? state.metadata :
    (state?.user?.metadata && typeof state.user.metadata === 'object') ? state.user.metadata :
    (state?.user?.data && typeof state.user.data === 'object') ? state.user.data :
    {};
  const bases = Array.isArray(meta.bases) ? meta.bases : [];
  return { baseMeta: meta, bases };
}

function setStateMetadata(newMeta) {
  // No todos los proyectos exponen esto; tratamos de dejarlo coherente en memoria:
  try {
    const { state } = getApp();
    if (state) {
      // Actualizar ambas copias si existen
      if (state.metadata) state.metadata = newMeta;
      if (state.user) {
        state.user.metadata = newMeta;
        // mantener compatibilidad con código que mira user.data.*:
        if (state.user.data && typeof state.user.data === 'object') {
          // NO sobreescribimos data completa para no romper otros flujos
          // (sólo si querés, podés copiar campos espejo, pero no es necesario)
        }
      }
    }
  } catch {}
}

// === UI: lista bases existentes ===
function renderBasesList(bases) {
  const list = el('basesList');
  if (!list) return;

  if (!bases || bases.length === 0) {
    list.innerHTML = `<div class="muted">No hay bases cargadas.</div>`;
    return;
  }

  list.innerHTML = bases.map((b, idx) => `
    <div class="item" data-index="${idx}" style="display:flex;align-items:center;gap:8px;justify-content:space-between;padding:6px 0;border-bottom:1px solid #eee">
      <div>
        <div><b>${b.name || 'Base'}</b></div>
        <div class="muted" style="font-size:12px">Puntos: ${Array.isArray(b.points) ? b.points.length : 0}</div>
      </div>
      <div>
        <button class="btn btn-sm" data-action="zoom" title="Centrar">🔍</button>
        <button class="btn btn-sm" data-action="delete" title="Eliminar">🗑</button>
      </div>
    </div>
  `).join('');

  list.querySelectorAll('.item .btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const action = e.currentTarget.getAttribute('data-action');
      const item   = e.currentTarget.closest('.item');
      const idx    = Number(item?.getAttribute('data-index') || -1);
      const { state } = getApp();
      const { bases } = readBaseMetadata(state);

      if (idx < 0 || idx >= bases.length) return;

      if (action === 'delete') {
        onDeleteBase(idx);
      } else if (action === 'zoom') {
        onZoomBase(bases[idx]);
      }
    });
  });
}

function onZoomBase(base) {
  const map = getMap();
  if (!map) return;
  const pts = Array.isArray(base?.points) ? base.points : [];
  if (pts.length !== 4) return;
  const latlngs = pts.map(p => L.latLng(p[0], p[1]));
  const poly = L.polygon(latlngs);
  map.fitBounds(poly.getBounds(), { padding: [20, 20] });
}

// === Guardar: agrega base al metadata y PATCH /users/{id}/metadata ===
async function onAddBase() {
  const { state } = getApp();
  if (!canEditUser(state)) { showToast('No tiene permisos para editar'); return; }

  const name = el('baseName')?.value.trim();
  const p1 = [Number(el('p1lat')?.value), Number(el('p1lon')?.value)];
  const p2 = [Number(el('p2lat')?.value), Number(el('p2lon')?.value)];
  const p3 = [Number(el('p3lat')?.value), Number(el('p3lon')?.value)];
  const p4 = [Number(el('p4lat')?.value), Number(el('p4lon')?.value)];

  // Validaciones simples
  const points = [p1, p2, p3, p4];
  if (!name) { showToast('Ingresá un nombre para la base'); return; }
  if (points.some(p => Number.isNaN(p[0]) || Number.isNaN(p[1]))) {
    showToast('Completá todas las coordenadas (lat/lon)');
    return;
  }

  const { baseMeta, bases } = readBaseMetadata(state);
  if (bases.length >= 4) { showToast('Máximo 4 bases'); return; }

  const newBase = {
    name,
    points,
    updatedAt: new Date().toISOString()
  };
  const newBases = bases.concat([newBase]);
  const newMeta  = { ...baseMeta, bases: newBases };

  const userId = String(state.user?.id ?? state.user?._id);
  const token  = state?.token || null;

  const msg = el('basesMsg');
  if (msg) msg.textContent = 'Guardando...';

  try {
    await apiUpdateUserMetadata(userId, newMeta, token);

    // Actualizar memoria front y mapa
    setStateMetadata(newMeta);
    renderBasesList(newBases);
    renderAllBasesOnMap(newBases);

    if (msg) msg.textContent = 'Base agregada ✔';
    showToast('Base guardada');
    // Limpiar inputs
    clearBaseForm();
  } catch (e) {
    console.error('bases save error', e);
    if (msg) msg.textContent = 'Error al guardar';
    showToast('No se pudo guardar: ' + (e?.message || 'Error'));
  }
}

function clearBaseForm() {
  ['baseName','p1lat','p1lon','p2lat','p2lon','p3lat','p3lon','p4lat','p4lon']
    .forEach(id => { if (el(id)) el(id).value = ''; });
}

// === Eliminar base (por índice) ===
async function onDeleteBase(idx) {
  const { state } = getApp();
  if (!canEditUser(state)) { showToast('No tiene permisos para editar'); return; }

  const { baseMeta, bases } = readBaseMetadata(state);
  if (idx < 0 || idx >= bases.length) return;

  const newBases = bases.slice(0, idx).concat(bases.slice(idx + 1));
  const newMeta  = { ...baseMeta, bases: newBases };

  const userId = String(state.user?.id ?? state.user?._id);
  const token  = state?.token || null;

  const msg = el('basesMsg');
  if (msg) msg.textContent = 'Guardando...';

  try {
    await apiUpdateUserMetadata(userId, newMeta, token);
    setStateMetadata(newMeta);
    renderBasesList(newBases);
    renderAllBasesOnMap(newBases);
    if (msg) msg.textContent = 'Base eliminada ✔';
    showToast('Base eliminada');
  } catch (e) {
    console.error('bases delete error', e);
    if (msg) msg.textContent = 'Error al eliminar';
    showToast('No se pudo eliminar: ' + (e?.message || 'Error'));
  }
}

// === Abrir/cerrar panel ===
function showBases() { el('basesPanel')?.classList.remove('hidden'); }
function hideBases() { el('basesPanel')?.classList.add('hidden'); }

// === Visibilidad del menú según permisos ===
function onLoggedIn() {
  const { state } = getApp();
  const menu = el('menuBases');
  if (menu) menu.classList.toggle('hidden', !canEditUser(state));

  // Render inicial de bases (si ya hay en metadata)
  const { bases } = readBaseMetadata(state);
  renderBasesList(bases);
  renderAllBasesOnMap(bases);
}

// === Wire-up ===
function initBasesUI() {
  // Menú
  el('menuBases')?.addEventListener('click', (e) => {
    e.preventDefault();
    try {
      const { state } = getApp();
      if (!canEditUser(state)) { showToast('No tiene permisos para editar'); return; }
      showBases();
    } catch (err) {
      console.error(err);
      showToast('Iniciá sesión primero');
    }
  });

  // Botones panel
  el('btnCloseBases')?.addEventListener('click', hideBases);
  el('btnCancelBase')?.addEventListener('click', hideBases);
  el('btnAddBase')?.addEventListener('click', onAddBase);

  // Eventos de app
  window.addEventListener('app:logged-in', onLoggedIn);
  window.addEventListener('app:logged-out', () => {
    const menu = el('menuBases');
    if (menu) menu.classList.add('hidden');
    renderBasesList([]);
    renderAllBasesOnMap([]);
  });

  // Si recargaste logueado, intenta setear
  try { onLoggedIn(); } catch {}
}

document.addEventListener('DOMContentLoaded', initBasesUI);
