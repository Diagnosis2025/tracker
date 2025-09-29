// editor.js
import { apiUpdateUser } from './api.js';
import { showToast } from './utils.js';

const el = (id) => document.getElementById(id);

function getApp() {
  const app = window.App;
  if (!app || !app.state) {
    throw new Error('App no inicializada (window.App.state no disponible)');
  }
  return app;
}

function setText(id, val) {
  const n = el(id);
  if (n) n.textContent = (val == null || val === '') ? '-' : String(val);
}

function loadDeviceMetaIntoForm(id) {
  const { state } = getApp();
  const m = state.deviceMeta?.[String(id)] || {};
  el('editName').value     = m.name  || '';
  el('editPlate').value    = m.plate || '';
  el('editBrand').value    = m.brand || '';
  el('editModel').value    = m.model || '';
  el('editColor').value    = m.color || '';
  el('editColorHex').value = m.colorHex || '#000000';
}

function populateSelect() {
  const { state, getDisplayName } = getApp();
  const sel = el('editDeviceSelect');
  if (!sel) return;

  const ids = (state.devices || []).map(String);
  sel.innerHTML = ids.map(id => `<option value="${id}">${id} — ${getDisplayName(id)}</option>`).join('');

  if (state.currentDevice && ids.includes(String(state.currentDevice))) {
    sel.value = String(state.currentDevice);
  }
  loadDeviceMetaIntoForm(sel.value);
}

function showEdit() {
  document.getElementById('editPanel')?.classList.remove('hidden');
}
function hideEdit() {
  document.getElementById('editPanel')?.classList.add('hidden');
}

async function saveMetaForm() {
  const { state, setDeviceMeta, getDisplayName, renderFleet } = getApp();

  if (Number(state?.user?.data?.nivel || 0) !== 1) {
    showToast('No tiene permisos para editar');
    return;
  }

  const id = el('editDeviceSelect').value;
  if (!id) { showToast('Elegí un dispositivo'); return; }

  const updated = {
    name:  el('editName').value.trim(),
    plate: el('editPlate').value.trim(),
    brand: el('editBrand').value.trim(),
    model: el('editModel').value.trim(),
    color: el('editColor').value.trim(),
    colorHex: el('editColorHex').value || '#000000',
    updatedAt: new Date().toISOString()
  };

  // Merge con lo existente (no perder otros campos)
  const newDevicesMeta = { ...(state.deviceMeta || {}) };
  newDevicesMeta[String(id)] = { ...(newDevicesMeta[String(id)] || {}), ...updated };

  // ⚠️ Reusar data original SIN tocar nivel / devices / tipo / password
  const userData = state.user?.data || {};
  const payload = {
    username: state.user?.username,
    data: {
      devices: userData.devices ?? [],
      tipo: userData.tipo ?? 'auto',
      nivel: userData.nivel ?? 2,
      devices_meta: newDevicesMeta
    }
  };

  const userId = String(state.user?.id ?? state.user?._id); // soporta id o _id
  const msg = el('editMsg');
  if (msg) msg.textContent = 'Guardando...';

  try {
    await apiUpdateUser(userId, payload, state?.token || null);

    // 1) Persistir en memoria de la app
    setDeviceMeta(newDevicesMeta);

    // 2) Actualizar tooltip del marcador si existe
    const m = state.markers?.[id];
    if (m) {
      const label = getDisplayName(id);
      m.unbindTooltip();
      m.bindTooltip(label, {
        permanent: true,
        direction: 'bottom',
        offset: [0, 10],
        className: 'marker-label'
      });
    }

    // 3) Refrescar “Mi flota”
    if (typeof renderFleet === 'function') {
      renderFleet(state.devices || []);
    }

    // 4) Si el panel de detalles está abierto para este device, refrescar visible
    if (state.currentDevice && String(state.currentDevice) === String(id)) {
      const display = getDisplayName(id);
      const dpDev = el('dpDevice');
      if (dpDev) dpDev.textContent = `${display} (${id})`;

      setText('dpPlate', updated.plate);
      setText('dpBrand', updated.brand);
      setText('dpModel', updated.model);
      const c = el('dpColor');
      if (c) {
        c.innerHTML = `<span style="display:inline-block;width:12px;height:12px;border-radius:50%;vertical-align:middle;margin-right:6px;border:1px solid #ccc;background:${updated.colorHex}"></span>${updated.color || updated.colorHex}`;
      }
    }

    if (msg) msg.textContent = 'Cambios guardados ✔';
    showToast('Datos del vehículo actualizados');
    hideEdit();
  } catch (e) {
    console.error('update error', e);
    if (msg) msg.textContent = 'Error al guardar';
    showToast('No se pudo guardar: ' + e.message);
  }
}

function onLoggedIn() {
  const { state } = getApp();
  const canEdit = Number(state?.user?.data?.nivel || 0) === 1;
  const editBtn = el('menuEdit');
  if (editBtn) editBtn.classList.toggle('hidden', !canEdit);
}

// ===== Wire-up UI =====
function initEditorUI() {
  el('menuEdit')?.addEventListener('click', (e) => {
    e.preventDefault();
    try {
      const { state } = getApp();
      if (Number(state?.user?.data?.nivel || 0) !== 1) {
        showToast('No tiene permisos para editar');
        return;
      }
      populateSelect();
      showEdit();
    } catch (err) {
      console.error(err);
      showToast('Iniciá sesión antes de editar');
    }
  });

  el('btnCloseEdit')?.addEventListener('click', hideEdit);
  el('btnCancelMeta')?.addEventListener('click', hideEdit);

  el('editDeviceSelect')?.addEventListener('change', (e) => {
    loadDeviceMetaIntoForm(e.target.value);
  });

  el('btnSaveMeta')?.addEventListener('click', saveMetaForm);

  window.addEventListener('app:logged-in', onLoggedIn);
  window.addEventListener('app:logged-out', () => {
    const editBtn = el('menuEdit');
    if (editBtn) editBtn.classList.add('hidden');
  });

  try { onLoggedIn(); } catch {}
}

document.addEventListener('DOMContentLoaded', initEditorUI);
