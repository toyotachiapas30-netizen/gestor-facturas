const { getAuthorizedClient, getGoogle } = require('../routes/drive');

const ANTIGRAVITY_FOLDER_ID = '1KaGywtG0CnKVKJE5wL8cVSq48U7tvl0F';
const MASTER_SPREADSHEET_ID = process.env.CONTROL_PAGOS_SHEET_ID || '1vh1tHeCCrM3rZvOPg5WQEiJNw5Aoc36bUB32It2AP7U';
const MASTER_SPREADSHEET_URL = `https://docs.google.com/spreadsheets/d/${MASTER_SPREADSHEET_ID}/edit`;
const CODE_FOLDER_ID = '1dYwzhpPkWNQcYJ67QaHGZEZNz4YVuIw2';
const EVIDENCIAS_FOLDER_ID = '1SHJ-Z6SFqoSIVc5h8Vp7gaUGvtO7xRXG';

let syncTimer = null;
let isSyncing = false;

async function syncAllToMasterSheet(db) {
  if (isSyncing || !db) return;
  isSyncing = true;
  try {
    const client = getAuthorizedClient();
    if (!client) return;
    const sheets = getGoogle().sheets({ version: 'v4', auth: client });

    // 1. Preparar filas de Control de Gastos
    const gastosRows = db.prepare(`
      SELECT id, fecha_solicitud, fecha_factura, mes, sucursal, proveedor, folio, uuid,
             monto, concepto, categoria, estatus, sheet_url, factura_url, comprobante_pago_url, created_at
      FROM gastos
      WHERE id != '00000000-0000-0000-0000-000000000000'
      ORDER BY created_at DESC
    `).all();

    const gastosHeader = [
      'ID', 'Fecha Solicitud', 'Fecha Factura', 'Mes', 'Sucursal', 'Proveedor',
      'Folio', 'UUID', 'Monto (MXN)', 'Concepto', 'Categoría', 'Estatus',
      'Link Contrarecibo (Sheets)', 'Link Factura (PDF)', 'Link Comprobante Pago', 'Fecha Registro'
    ];

    const gastosValues = [
      gastosHeader,
      ...gastosRows.map(g => [
        g.id || '',
        g.fecha_solicitud || '',
        g.fecha_factura || '',
        g.mes || '',
        g.sucursal || 'Toyota Chiapas',
        g.proveedor || '',
        g.folio || '',
        g.uuid || '',
        typeof g.monto === 'number' ? g.monto : (parseFloat(g.monto) || 0),
        g.concepto || '',
        g.categoria || 'OTROS',
        g.estatus || 'en_proceso',
        g.sheet_url || '',
        g.factura_url || '',
        g.comprobante_pago_url || '',
        g.created_at || ''
      ])
    ];

    // 2. Preparar filas de Bandeja de Entrada
    const bandejaRows = db.prepare(`
      SELECT id_clave, message_id, uuid, estatus, updated_at
      FROM bandeja_estado
      ORDER BY updated_at DESC
    `).all();

    const bandejaValues = [
      ['ID Clave', 'Message ID (Gmail)', 'UUID Factura', 'Estatus', 'Última Actualización'],
      ...bandejaRows.map(b => [
        b.id_clave || '',
        b.message_id || '',
        b.uuid || '',
        b.estatus || 'pendiente',
        b.updated_at || ''
      ])
    ];

    // 3. Preparar filas de Configuración Sistema (ocultando tokens largos pero guardando llaves operativas)
    const configRows = db.prepare(`
      SELECT clave, valor, updated_at
      FROM bandeja_config
      WHERE clave != 'google_tokens'
      ORDER BY clave ASC
    `).all();

    const configValues = [
      ['Clave de Configuración', 'Valor', 'Última Actualización'],
      ...configRows.map(c => [
        c.clave || '',
        c.valor || '',
        c.updated_at || ''
      ])
    ];

    // Limpiar y actualizar las 3 pestañas en lote
    await sheets.spreadsheets.values.batchClear({
      spreadsheetId: MASTER_SPREADSHEET_ID,
      requestBody: {
        ranges: [
          "'Control de Gastos'!A1:P2000",
          "'Bandeja de Entrada'!A1:E2000",
          "'Configuración Sistema'!A1:C200"
        ]
      }
    });

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: MASTER_SPREADSHEET_ID,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data: [
          { range: "'Control de Gastos'!A1", values: gastosValues },
          { range: "'Bandeja de Entrada'!A1", values: bandejaValues },
          { range: "'Configuración Sistema'!A1", values: configValues }
        ]
      }
    });

    console.log(`📊 [Google Sheets DB] Sincronizados ${gastosRows.length} gastos en carpeta Antigravity.`);
  } catch (err) {
    console.warn('⚠️ [Google Sheets DB] Aviso al sincronizar con Google Sheets:', err.message);
  } finally {
    isSyncing = false;
  }
}

function scheduleMasterSheetSync(db) {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncAllToMasterSheet(db).catch(() => {});
  }, 1500);
}

async function appendFlowLog({ paso, proveedor, folio, uuid, resultado, link }) {
  try {
    const client = getAuthorizedClient();
    if (!client) return;
    const sheets = getGoogle().sheets({ version: 'v4', auth: client });
    const fecha = new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' });
    await sheets.spreadsheets.values.append({
      spreadsheetId: MASTER_SPREADSHEET_ID,
      range: "'Bitácora de Flujo'!A:F",
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[fecha, paso || '', proveedor || '', folio || uuid || '', resultado || 'OK', link || '']]
      }
    });
  } catch (e) {}
}

module.exports = {
  ANTIGRAVITY_FOLDER_ID,
  MASTER_SPREADSHEET_ID,
  MASTER_SPREADSHEET_URL,
  CODE_FOLDER_ID,
  EVIDENCIAS_FOLDER_ID,
  syncAllToMasterSheet,
  scheduleMasterSheetSync,
  appendFlowLog
};
