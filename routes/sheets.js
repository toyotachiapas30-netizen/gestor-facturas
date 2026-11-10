const express = require('express');
const { getAuthorizedClient, getGoogle } = require('./drive');
const router = express.Router();

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
    let targetGid = 0;
    try {
      const doc = await sheets.spreadsheets.get({ spreadsheetId: targetSheetId });
      const allSheets = (doc.data.sheets || []).map(s => s.properties).filter(Boolean);
      if (allSheets.length > 0) {
        const matchedTab = allSheets.find(p => p.title === tabName) || allSheets[0];
        tabName = matchedTab.title;
        targetGid = matchedTab.sheetId || 0;
      }
    } catch (metaErr) {
      console.warn('⚠️ Error al consultar pestañas de la hoja:', metaErr.message);
    }

    // Formatear fecha sin hora para que no se corte en la celda I40
    const cleanFecha = String(fecha || '').split('T')[0].split(' ')[0].trim() || fecha;

    // 3. Escribir los 4 valores directamente en la COPIA INDIVIDUAL
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: targetSheetId,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data: [
          { range: `${tabName}!${CELL_NO_FACT}`,  values: [[noFact]]     },
          { range: `${tabName}!${CELL_FECHA}`,     values: [[cleanFecha]] },
          { range: `${tabName}!${CELL_IMPORTE}`,   values: [[importe]]    },
          { range: `${tabName}!${CELL_CONCEPTO}`,  values: [[concepto]]   }
        ]
      }
    });

    const safeFolio = String(noFact || 'S-F').replace(/[^A-Za-z0-9_-]/g, '_');
    const pdfFilename = `Contrarecibo_${safeFolio}.pdf`;
    const pdfDownloadUrl = `/api/sheets/pdf/${encodeURIComponent(targetSheetId)}?gid=${encodeURIComponent(targetGid)}&filename=${encodeURIComponent(pdfFilename)}&download=1`;
    const pdfPreviewUrl = `/api/sheets/pdf/${encodeURIComponent(targetSheetId)}?gid=${encodeURIComponent(targetGid)}&filename=${encodeURIComponent(pdfFilename)}`;

    return res.json({
      ok: true,
      sheetId: targetSheetId,
      gid: targetGid,
      sheetUrl,
      pdfDownloadUrl,
      pdfPreviewUrl,
      pdfFilename,
      mensaje: 'Contrarecibo individual generado, llenado y respaldado correctamente'
    });
  } catch (err) {
    console.error('Sheets error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/sheets/pdf/:sheetId  →  Export Contrarecibo as 1-page PDF ───
router.get('/pdf/:sheetId', async (req, res) => {
  const client = getAuthorizedClient();
  if (!client) return res.status(401).json({ ok: false, error: 'No autorizado con Google.' });

  const { sheetId } = req.params;
  const gid = req.query.gid || '0';
  const filename = String(req.query.filename || `Contrarecibo_${sheetId}.pdf`).replace(/["\r\n]/g, '');
  const isDownload = req.query.download === '1' || req.query.download === 'true';

  try {
    const exportUrl = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/export?format=pdf&gid=${encodeURIComponent(gid)}&scale=4&size=letter&portrait=true&gridlines=false`;
    const response = await client.request({
      url: exportUrl,
      responseType: 'arraybuffer'
    });

    const pdfBuffer = Buffer.from(response.data);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `${isDownload ? 'attachment' : 'inline'}; filename="${filename}"`
    );
    res.setHeader('Content-Length', pdfBuffer.length);
    return res.send(pdfBuffer);
  } catch (err) {
    console.error('Error exportando PDF de Contrarecibo:', err.message);
    return res.status(500).json({ ok: false, error: 'No se pudo exportar el PDF del contrarecibo: ' + err.message });
  }
});

module.exports = router;
