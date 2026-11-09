const express = require('express');
// const { google } = require('googleapis'); // lazy load
const getGoogle = () => require('googleapis').google;
const fs = require('fs');
const path = require('path');
const router = express.Router();

const TOKENS_FILE = path.join(__dirname, '..', '.google-tokens.json');

function getAuthorizedClient() {
  if (!fs.existsSync(TOKENS_FILE)) return null;
  const tokens = JSON.parse(fs.readFileSync(TOKENS_FILE));
  const { google } = require('googleapis');
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `http://localhost:${process.env.PORT || 3001}/api/drive/callback`
  );
  client.setCredentials(tokens);
  return client;
}

// Cells in the contrarecibo sheet (fixed positions)
const CELL_NO_FACT  = 'D40';  // No. de Factura / Recibo
const CELL_FECHA    = 'I40';  // Fecha
const CELL_IMPORTE  = 'J40';  // Importe
const CELL_CONCEPTO = 'L40';  // Concepto del Gasto

// ── GET /api/sheets/find  →  Find sheet files in the folder ───
// Optional query: ?nombre=PROVEEDOR — filters sheets by name
router.get('/find', async (req, res) => {
  const client = getAuthorizedClient();
  if (!client) return res.status(401).json({ ok: false, error: 'No autorizado con Google.' });

  const drive = getGoogle().drive({ version: 'v3', auth: client });
  
  // Always query from the configured GOOGLE_SHEETS_FOLDER_ID
  const folderId = process.env.GOOGLE_SHEETS_FOLDER_ID || '1t-dylPS1zV54AJE2eGozKJDR4RqUtNO7';
  const prefix = req.query.prefix || '';
  const nombre = req.query.nombre || '';
  
  console.log(`🔍 Buscando contrarecibo en carpeta: ${folderId} (Prefix: "${prefix}", Nombre: "${nombre}")`);

  try {
    // Search strictly for Google Sheets inside the specified folder
    let q = `'${folderId}' in parents and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`;

    if (prefix.trim()) {
      q += ` and name contains '${prefix.trim()}'`;
    }

    if (nombre.trim()) {
      const cleanNombre = nombre.trim().replace(/'/g, "\\'");
      q += ` and name contains '${cleanNombre}'`;
    }

    const searchRes = await drive.files.list({
      q,
      fields: 'files(id, name, webViewLink, mimeType)',
      orderBy: 'modifiedTime desc'
    });

    const files = searchRes.data.files;
    if (files.length === 0 && nombre.trim()) {
      // If no results with filter, try without filter and return all
      const allRes = await drive.files.list({
        q: `'${folderId}' in parents and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`,
        fields: 'files(id, name, webViewLink)',
        orderBy: 'modifiedTime desc'
      });
      return res.json({
        ok: true,
        sheets: allRes.data.files,
        matched: false,
        mensaje: `No se encontró hoja con nombre "${nombre}". Se muestran todas las hojas.`
      });
    }

    return res.json({
      ok: true,
      sheets: files,
      matched: nombre.trim() ? true : false
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /api/sheets/llenar  →  Fill contrarecibo cells ───
// Body: { sheetId, noFact, fecha, importe, concepto, sheetName }
router.post('/llenar', async (req, res) => {
  const client = getAuthorizedClient();
  if (!client) return res.status(401).json({ ok: false, error: 'No autorizado con Google.' });

  const { sheetId, noFact, fecha, importe, concepto, sheetName } = req.body;
  if (!sheetId || !noFact || !fecha || !importe || !concepto)
    return res.status(400).json({ ok: false, error: 'Faltan campos: sheetId, noFact, fecha, importe, concepto' });

  const sheets = getGoogle().sheets({ version: 'v4', auth: client });
  const drive = getGoogle().drive({ version: 'v3', auth: client });
  let tabName = sheetName || 'Hoja1';

  try {
    // 1. Crear copia individual del contrarecibo en la carpeta de respaldos de Drive
    const DRIVE_BACKUP_FOLDER = '1xLYLOfX581ZV7irORRVDP8JxhS4KTkks';
    let targetSheetId = sheetId;
    let sheetUrl = `https://docs.google.com/spreadsheets/d/${sheetId}`;

    try {
      const copyRes = await drive.files.copy({
        fileId: sheetId,
        requestBody: {
          name: `Contrarecibo - ${noFact} - ${new Date().toISOString().split('T')[0]}`,
          parents: [DRIVE_BACKUP_FOLDER]
        },
        fields: 'id, webViewLink'
      });
      targetSheetId = copyRes.data.id;
      sheetUrl = copyRes.data.webViewLink || `https://docs.google.com/spreadsheets/d/${targetSheetId}`;
      console.log(`✅ Copia individual de contrarecibo creada en Drive: ${targetSheetId}`);
    } catch (copyErr) {
      console.error('⚠️ Error al crear copia en Drive, escribiendo en plantilla:', copyErr.message);
    }

    // 2. Autodetectar pestañas en el documento para usar la primera si la especificada no existe
    try {
      const doc = await sheets.spreadsheets.get({ spreadsheetId: targetSheetId });
      const sheetNames = (doc.data.sheets || []).map(s => s.properties.title).filter(Boolean);
      if (sheetNames.length > 0) {
        if (!sheetNames.includes(tabName)) {
          console.log(`⚠️ La pestaña "${tabName}" no existe. Autodetectando primera disponible: "${sheetNames[0]}"`);
          tabName = sheetNames[0];
        }
      }
    } catch (metaErr) {
      console.warn('⚠️ Error al consultar pestañas de la hoja:', metaErr.message);
    }

    // 3. Escribir los 4 valores directamente en la COPIA INDIVIDUAL
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: targetSheetId,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data: [
          { range: `${tabName}!${CELL_NO_FACT}`,  values: [[noFact]]   },
          { range: `${tabName}!${CELL_FECHA}`,     values: [[fecha]]    },
          { range: `${tabName}!${CELL_IMPORTE}`,   values: [[importe]]  },
          { range: `${tabName}!${CELL_CONCEPTO}`,  values: [[concepto]] }
        ]
      }
    });

    return res.json({ ok: true, sheetUrl, mensaje: 'Contrarecibo individual generado, llenado y respaldado correctamente' });
  } catch (err) {
    console.error('Sheets error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
