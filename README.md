# Diagnosis Track — Web (GitHub Pages)

Sitio estático para visualizar dispositivos y rutas usando la API pública.

## Deploy rápido en GitHub Pages
1. Creá un repo **diagnosis-track-web** (o el nombre que quieras).
2. Subí **todo el contenido** de esta carpeta a la rama `main`.
3. En *Settings → Pages*, elegí *Deploy from a branch* → `main` → `/root`.
4. Abrí tu URL de Pages.

## Configurar
Si cambia el dominio de la API, editá `utils.js` y ajustá `API_BASE`.

## Flujo
- Iniciás sesión en `/auth/login` con usuario y pass existentes.
- El JWT se guarda en `localStorage` y se usa (si el backend lo requiere) para `/device/:id/...`.
- Se renderizan los últimos puntos de cada device (car icon verde/rojo/ámbar/gris).
- Al click en un device: panel derecho con info y acciones de rutas.
- **Rutas**: pide `/device/:id/readings?topic=diagnosis.gps2&dateFrom=YYYY-MM-DDTHH:mm:ss&dateTo=...`
  - Se envían fechas en **UTC** sin `Z` (formateo con `toISOString().slice(0,19)`).
  - Dibuja polilínea, puntos rojos con tooltip y banderas *inicio/fin*.
  - Podés **Descargar CSV** si hay ruta cargada.
