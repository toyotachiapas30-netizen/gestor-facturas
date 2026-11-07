const express = require('express');
const getGoogle = () => require('googleapis').google;
const fs = require('fs');
const path = require('path');
const { launchBrowser } = require('../utils/browser');
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

// Parsear cualquier fecha de CFDI ("2026-11-05T11:56:31", "05/11/2026", "2026-11-05 22:52:32")
function parseInvoiceDateParts(rawFecha) {
  const s = String(rawFecha || '').trim();
  // Caso ISO: YYYY-MM-DD...
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) {
    return {
      yyyy: m[1],
      mm: m[2].padStart(2, '0'),
      dd: m[3].padStart(2, '0')
    };
  }
  // Caso DD/MM/YYYY
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (m) {
    return {
      dd: m[1].padStart(2, '0'),
      mm: m[2].padStart(2, '0'),
      yyyy: m[3]
    };
  }
  const now = new Date();
  return {
    yyyy: String(now.getFullYear()),
    mm: String(now.getMonth() + 1).padStart(2, '0'),
    dd: String(now.getDate()).padStart(2, '0')
  };
}

function getTodayDDMMYYYY() {
  const now = new Date();
  const dd = String(now.getDate()).padStart(2, '0');
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const yyyy = now.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

// Limpiar importe numérico ("$6,940.00" -> 6940)
function parseNumericAmount(val) {
  if (typeof val === 'number') return val;
  const cleaned = String(val || '').replace(/[^0-9.-]/g, '');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : val;
}

// ── GET /api/sheets/find  →  Find sheet files in the folder ───
router.get('/find', async (req, res) => {
  const client = getAuthorizedClient();
  if (!client) return res.status(401).json({ ok: false, error: 'No autorizado con Google.' });

  const drive = getGoogle().drive({ version: 'v3', auth: client });

  // Soportar carpeta específica por sucursal o la carpeta por defecto de Toyota Chiapas
  const folderId = req.query.folderId || process.env.GOOGLE_SHEETS_FOLDER_ID || '1t-dylPS1zV54AJE2eGozKJDR4RqUtNO7';
  const prefix = req.query.prefix || '';
  const nombre = req.query.nombre || '';

  try {
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
      orderBy: 'modifiedTime desc',
      pageSize: 100
    });

    const files = searchRes.data.files || [];
    if (files.length === 0 && nombre.trim()) {
      const allRes = await drive.files.list({
        q: `'${folderId}' in parents and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`,
        fields: 'files(id, name, webViewLink)',
        orderBy: 'modifiedTime desc',
        pageSize: 100
      });
      return res.json({
        ok: true,
        sheets: allRes.data.files || [],
        matched: false,
        mensaje: `No se encontró hoja exacta con "${nombre}". Se muestran todas las hojas de la sucursal.`
      });
    }

    return res.json({
      ok: true,
      sheets: files,
      matched: Boolean(nombre.trim())
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/sheets/banxico-fix  →  Consulta y Captura Real de Banxico (para Pattison / USD) ──
router.get('/banxico-fix', async (req, res) => {
  const BANXICO_URL = 'https://www.banxico.org.mx/tipcamb/main.do?page=tip&idioma=sp';
  let browser = null;
  try {
    browser = await launchBrowser(['--ignore-certificate-errors']);
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 900 });
    await page.goto(BANXICO_URL, { waitUntil: 'networkidle2', timeout: 35000 });
    await new Promise((r) => setTimeout(r, 1500));

    const rateInfo = await page.evaluate(() => {
      const text = document.body?.innerText || '';
      // Buscar el valor numérico junto a FIX
      const fixMatch = text.match(/FIX[\s\S]{0,120}?(\d{2}\.\d{4})/i);
      const anyRates = text.match(/\b(1[5-9]|2[0-5])\.\d{4}\b/g) || [];
      return {
        fixRate: fixMatch ? parseFloat(fixMatch[1]) : (anyRates[0] ? parseFloat(anyRates[0]) : null),
        allRates: anyRates.slice(0, 5)
      };
    });

    const screenshotB64 = await page.screenshot({ fullPage: true, encoding: 'base64' });
    const pdfBuf = await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: { top: '10mm', bottom: '10mm', left: '10mm', right: '10mm' }
    });

    await browser.close().catch(() => {});

    return res.json({
      ok: true,
      tipoCambioFix: rateInfo.fixRate,
      url: BANXICO_URL,
      screenshot: `data:image/png;base64,${screenshotB64}`,
      pdfBase64: Buffer.from(pdfBuf).toString('base64')
    });
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    return res.status(500).json({ ok: false, error: 'Error consultando Banxico: ' + err.message });
  }
});

// ── POST /api/sheets/llenar  →  Llena el contrarecibo en la hoja real del proveedor y exporta PDF de 1 pág ──
router.post('/llenar', async (req, res) => {
  const client = getAuthorizedClient();
  if (!client) return res.status(401).json({ ok: false, error: 'No autorizado con Google.' });

  const {
    sheetId,
    noFact,
    fecha,
    importe,
    concepto,
    sheetName,
    moneda,
    tipoCambio,
    proveedorNombre
  } = req.body || {};

  if (!sheetId || !noFact || !fecha || !importe || !concepto) {
    return res.status(400).json({ ok: false, error: 'Faltan campos: sheetId, noFact, fecha, importe, concepto' });
  }

  const sheets = getGoogle().sheets({ version: 'v4', auth: client });
  const drive = getGoogle().drive({ version: 'v3', auth: client });
  let tabName = sheetName || 'Hoja1';

  try {
    // 1. Obtener metadatos de la hoja ORIGINAL del proveedor (pestañas, gid, título)
    const doc = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
    const docTitle = (doc.data.properties?.title || '').toUpperCase();
    const provUpper = (proveedorNombre || '').toUpperCase();
    const allSheets = doc.data.sheets || [];

    let targetSheetObj = allSheets.find((s) => s.properties?.title === tabName) || allSheets[0];
    if (targetSheetObj?.properties?.title) {
      tabName = targetSheetObj.properties.title;
    }
    const targetGid = targetSheetObj?.properties?.sheetId ?? 0;

    // 2. Detectar si es hoja especial (Pattison USD o Arq. Manuel)
    const isPattison =
      sheetId === '1qrffxhiMPPRSaGwnHzun7m9_grbnlc-CgNerGCnJ1CA' ||
      docTitle.includes('PATTISON') ||
      provUpper.includes('PATTISON') ||
      (String(moneda || '').toUpperCase() === 'USD' && tipoCambio);

    const isArqManuel =
      docTitle.includes('MANUEL') && docTitle.includes('GUTIERREZ') ||
      provUpper.includes('MANUEL') && provUpper.includes('GUTIERREZ');

    const dateParts = parseInvoiceDateParts(fecha);
    const fechaElaboracionHoy = `'${getTodayDDMMYYYY()}`;
    const numImporte = parseNumericAmount(importe);
    const cleanConcepto = String(concepto || '').trim();
    const cleanFolio = String(noFact || '').trim();

    // 3. Limpiar primero las celdas de facturas anteriores (D40:N43) en la hoja REAL del proveedor
    await sheets.spreadsheets.values.clear({
      spreadsheetId: sheetId,
      range: `${tabName}!D40:N43`
    }).catch(() => {});

    // 4. Preparar las celdas exactas según el tipo de hoja
    const dataUpdates = [
      // Actualizar siempre S6 con la fecha de elaboración del día
      { range: `${tabName}!S6`, values: [[fechaElaboracionHoy]] }
    ];

    if (isPattison) {
      // Regla Pattison (USD): D40 folio, I40 fecha M/D/YYYY, J40 Importe USD, L40 Tipo de Cambio FIX, M40 =J40*L40, N40 Concepto
      const fechaMDY = `'${parseInt(dateParts.mm, 10)}/${parseInt(dateParts.dd, 10)}/${dateParts.yyyy}`;
      const tcNum = parseNumericAmount(tipoCambio || 18.5);
      dataUpdates.push(
        { range: `${tabName}!D40`, values: [[cleanFolio]] },
        { range: `${tabName}!I40`, values: [[fechaMDY]] },
        { range: `${tabName}!J40`, values: [[numImporte]] },
        { range: `${tabName}!L40`, values: [[tcNum]] },
        { range: `${tabName}!M40`, values: [['=J40*L40']] },
        { range: `${tabName}!N40`, values: [[cleanConcepto]] }
      );
    } else if (isArqManuel) {
      // Regla Arq. Manuel: I40 como texto AAAA-MM-DD, J40:K40 importe, L40 concepto, J44 =SUMA(J40:K43)
      const fechaISO = `'${dateParts.yyyy}-${dateParts.mm}-${dateParts.dd}`;
      dataUpdates.push(
        { range: `${tabName}!D40`, values: [[cleanFolio]] },
        { range: `${tabName}!I40`, values: [[fechaISO]] },
        { range: `${tabName}!J40`, values: [[numImporte]] },
        { range: `${tabName}!L40`, values: [[cleanConcepto]] }
      );
    } else {
      // Regla general Toyota Chiapas: D40 folio, I40 texto 'DD/MM/YYYY (sin hora), J40 importe, L40 concepto
      const fechaDMY = `'${dateParts.dd}/${dateParts.mm}/${dateParts.yyyy}`;
      dataUpdates.push(
        { range: `${tabName}!D40`, values: [[cleanFolio]] },
        { range: `${tabName}!I40`, values: [[fechaDMY]] },
        { range: `${tabName}!J40`, values: [[numImporte]] },
        { range: `${tabName}!L40`, values: [[cleanConcepto]] }
      );
    }

    // 5. Escribir los valores directamente en la hoja REAL del proveedor
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data: dataUpdates
      }
    });

    // 6. Ajustar el alto de la fila 40 a 36 px para que conceptos largos nunca se corten en el PDF
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: {
        requests: [
          {
            updateDimensionProperties: {
              range: {
                sheetId: targetGid,
                dimension: 'ROWS',
                startIndex: 39, // Fila 40 (0-indexed)
                endIndex: 40
              },
              properties: {
                pixelSize: 38
              },
              fields: 'pixelSize'
            }
          }
        ]
      }
    }).catch((e) => console.warn('⚠️ Aviso ajustando alto de fila 40:', e.message));

    // 7. Exportar únicamente la Página 1 del Contrarecibo en PDF (rango A1:T52 para evitar hoja 2 en blanco)
    let pdfBase64 = null;
    try {
      const tokenRes = await client.getAccessToken();
      const accessToken = tokenRes?.token || tokenRes;
      const exportUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=pdf&gid=${targetGid}&size=letter&portrait=true&fitw=true&fith=true&r1=0&c1=0&r2=52&c2=20&gridlines=false&printtitle=false&sheetnames=false`;
      const axios = require('axios');
      const pdfResp = await axios.get(exportUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
        responseType: 'arraybuffer',
        timeout: 25000
      });
      pdfBase64 = Buffer.from(pdfResp.data).toString('base64');
    } catch (pdfErr) {
      console.warn('⚠️ Aviso al exportar PDF directo del Contrarecibo:', pdfErr.message);
    }

    // 8. Crear copia de respaldo en segundo plano (sin afectar la hoja original)
    const DRIVE_BACKUP_FOLDER = '1xLYLOfX581ZV7irORRVDP8JxhS4KTkks';
    drive.files.copy({
      fileId: sheetId,
      requestBody: {
        name: `Contrarecibo - ${cleanFolio} - ${new Date().toISOString().split('T')[0]}`,
        parents: [DRIVE_BACKUP_FOLDER]
      }
    }).catch(() => {});

    const sheetUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/edit#gid=${targetGid}`;

    return res.json({
      ok: true,
      sheetUrl,
      sheetId,
      gid: targetGid,
      formatoAplicado: isPattison ? 'PATTISON_USD' : isArqManuel ? 'ARQ_MANUEL' : 'ESTANDAR',
      fechaElaboracion: getTodayDDMMYYYY(),
      pdfBase64,
      mensaje: 'Contrarecibo actualizado directamente en la hoja del proveedor (S6, fila 40 a 38px) y PDF de 1 página generado.'
    });
  } catch (err) {
    console.error('Sheets error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
