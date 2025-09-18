// load-csv.js
import { showToast } from './utils.js';

let csvModuleInitialized = false;

export function initCSVModule() {
  if (csvModuleInitialized) return;
  
  const menuLoadCSV = document.getElementById('menuLoadCSV');
  if (menuLoadCSV) {
    menuLoadCSV.addEventListener('click', handleCSVLoad);
    csvModuleInitialized = true;
  }
}

function handleCSVLoad() {
  // Crear input de tipo file para seleccionar CSV
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.csv';
  
  fileInput.addEventListener('change', (event) => {
    const file = event.target.files[0];
    if (file) {
      processCSVFile(file);
    }
  });
  
  fileInput.click();
}

function processCSVFile(file) {
  const reader = new FileReader();
  
  reader.onload = (e) => {
    try {
      const csvData = e.target.result;
      const routes = parseCSVData(csvData);
      showToast(`Archivo CSV cargado: ${routes.length} rutas procesadas`);
      // Aquí puedes agregar la lógica para procesar las rutas
      console.log('Datos CSV procesados:', routes);
    } catch (error) {
      console.error('Error procesando CSV:', error);
      showToast('Error al procesar el archivo CSV');
    }
  };
  
  reader.onerror = () => {
    showToast('Error al leer el archivo');
  };
  
  reader.readAsText(file);
}

function parseCSVData(csvData) {
  // Implementación básica de parser CSV
  const lines = csvData.split('\n');
  const routes = [];
  
  // Omitir la primera línea si es un encabezado
  const startLine = lines[0].includes('ruta') ? 1 : 0;
  
  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line) {
      const values = line.split(',');
      if (values.length >= 2) {
        routes.push({
          id: values[0].trim(),
          ruta: values[1].trim(),
          // Agregar más campos según sea necesario
        });
      }
    }
  }
  
  return routes;
}