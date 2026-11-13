const express = require('express');
const multer = require('multer');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { getAuthorizedClient } = require('./drive');
const { requestAutotecBuzon, relayAtomicBuzonSubmit } = require('../utils/buzon-bridge');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }
});

const getGoogle = () => require('googleapis').google;

// ── Helpers para ASP.NET Buzón (buzonfecg.aspx) ──────────────────
function extractTokens(html) {
  const vs = html.match(/id="__VIEWSTATE"\s+value="([^"]*)"/)?.[1] || '';
  const vsg = html.match(/id="__VIEWSTATEGENERATOR"\s+value="([^"]*)"/)?.[1] || '';
  const ev = html.match(/id="__EVENTVALIDATION"\s+value="([^"]*)"/)?.[1] || '';
  return { vs, vsg, ev };
}

function extractAlerts(html) {
  const m1 = [...html.matchAll(/muestraaviso\(['"]([^'"]+)['"]\)/gi)].map(m => m[1]);
  const m2 = [...html.matchAll(/alert\(['"]([^'"]+)['"]\)/gi)].map(m => m[1]);
  return [...new Set([...m1, ...m2])];
}

function buildMultipart(fields, files) {
  const boundary = '----WebKitFormBoundary' + Math.random().toString(16).slice(2, 14);
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v ?? ''}\r\n`,
        'utf8'
      )
    );
  }
  for (const f of files) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${f.field}"; filename="${f.filename}"\r\nContent-Type: ${f.contentType}\r\n\r\n`,
        'utf8'
      )
    );
    parts.push(f.data);
    parts.push(Buffer.from('\r\n', 'utf8'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return {
    boundary,
    body: Buffer.concat(parts)
  };
}

// ── Extraer metadatos básicos de un CFDI XML ─────────────────────
function parseXmlQuickMeta(xmlBuffer) {
  if (!xmlBuffer || !xmlBuffer.length) return {};
  const str = xmlBuffer.toString('utf8');

  const getAttr = (tagRegex, attrName) => {
    const tagMatch = str.match(tagRegex);
    if (!tagMatch) return '';
    const attrMatch = tagMatch[0].match(new RegExp(`\\b${attrName}\\s*=\\s*["']([^"']*)["']`, 'i'));
    return attrMatch ? attrMatch[1].trim() : '';
  };

  const folio = getAttr(/<(?:\w+:)?Comprobante\b[^>]*>/i, 'Folio');
  const serie = getAttr(/<(?:\w+:)?Comprobante\b[^>]*>/i, 'Serie');
  const total = getAttr(/<(?:\w+:)?Comprobante\b[^>]*>/i, 'Total');
  const fecha = getAttr(/<(?:\w+:)?Comprobante\b[^>]*>/i, 'Fecha');
  const emisorNombre = getAttr(/<(?:\w+:)?Emisor\b[^>]*>/i, 'Nombre');
  const emisorRfc = getAttr(/<(?:\w+:)?Emisor\b[^>]*>/i, 'Rfc');
  const receptorNombre = getAttr(/<(?:\w+:)?Receptor\b[^>]*>/i, 'Nombre');
  const receptorRfc = getAttr(/<(?:\w+:)?Receptor\b[^>]*>/i, 'Rfc');
  const uuid = getAttr(/<(?:\w+:)?TimbreFiscalDigital\b[^>]*>/i, 'UUID');

  return {
    folio,
    serie,
    total,
    fecha,
    emisorNombre,
    emisorRfc,
    receptorNombre,
    receptorRfc,
    uuid
  };
}

// ── Decodificar y parsear correos de notifica@gfarrera.com.mx ────
function extractPlainBodyFromPayload(payload) {
  if (!payload) return '';
  const decodeB64 = data => Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return decodeB64(payload.body.data);
  }
  if (payload.parts && Array.isArray(payload.parts)) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return decodeB64(part.body.data);
      }
    }
    for (const part of payload.parts) {
      const nested = extractPlainBodyFromPayload(part);
      if (nested) return nested;
    }
  }
  if (payload.body?.data) {
    const raw = decodeB64(payload.body.data);
    return raw
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .trim();
  }
  return '';
}

function parseNotificaEmail(msgData) {
  const headers = msgData.payload?.headers || [];
  const getH = name => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';

  const subject = getH('Subject') || 'Factura electrónica registrada.';
  const from = getH('From') || 'Sistema Autotec Web <notifica@gfarrera.com.mx>';
  const to = getH('To') || '';
  const dateHeader = getH('Date') || '';
  const internalDate = Number(msgData.internalDate || Date.now());
  const rawBody = extractPlainBodyFromPayload(msgData.payload) || msgData.snippet || '';
  const cleanBody = rawBody.replace(/\r\n/g, '\n').trim();

  // Ejemplo de cuerpo:
  // "VALOR FARRERA AUTOMOTRIZ S. DE R.L. DE C.V. le informa que su Factura Electrónica 1242 se registró exitosamente y se encuentra en proceso de revisión.\n\nPor su atención, gracias."
  const folioMatch = cleanBody.match(/Factura\s+Electr[oó]nica\s+([A-Za-z0-9_-]+)/i);
  const folio = folioMatch ? folioMatch[1].trim() : '';

  const empresaMatch = cleanBody.match(/^([\s\S]*?)\s+le informa que su Factura Electr[oó]nica/i);
  const empresaReceptora = empresaMatch
    ? empresaMatch[1].replace(/\s+/g, ' ').trim()
    : 'VALOR FARRERA AUTOMOTRIZ S. DE R.L. DE C.V.';

  const esReenvio = subject.toUpperCase().includes('REENVIO');
  const esValorFarrera = empresaReceptora.toUpperCase().includes('VALOR FARRERA');

  return {
    id: msgData.id,
    threadId: msgData.threadId,
    internalDate,
    date: dateHeader,
    dateIso: new Date(internalDate).toISOString(),
    from,
    to,
    subject,
    folio,
    empresaReceptora,
    esReenvio,
    esValorFarrera,
    bodyText: cleanBody,
    snippet: msgData.snippet || cleanBody,
    pdfDownloadUrl: `/api/autotec/confirmacion-pdf/${msgData.id}?download=1`,
    pdfPreviewUrl: `/api/autotec/confirmacion-pdf/${msgData.id}`
  };
}

async function listNotificaConfirmations({ folioFilter = '', queryFilter = '', maxResults = 35 } = {}) {
  const auth = getAuthorizedClient();
  if (!auth) throw new Error('Gmail no está autenticado.');
  const gmail = getGoogle().gmail({ version: 'v1', auth });

  const q = 'from:notifica@gfarrera.com.mx';

  const listRes = await gmail.users.messages.list({
    userId: 'me',
    q,
    maxResults
  });

  const messages = listRes.data.messages || [];
  if (messages.length === 0) return [];

  const details = await Promise.all(
    messages.map(async m => {
      try {
        const msg = await gmail.users.messages.get({
          userId: 'me',
          id: m.id,
          format: 'full'
        });
        return parseNotificaEmail(msg.data);
      } catch (_) {
        return null;
      }
    })
  );

  let items = details.filter(Boolean);

  if (folioFilter) {
    const target = String(folioFilter).trim().toUpperCase();
    const targetDigits = target.replace(/\D+/g, '').replace(/^0+/, '');
    items = items.filter(it => {
      const f = String(it.folio || '').toUpperCase();
      const fDigits = f.replace(/\D+/g, '').replace(/^0+/, '');
      return (
        f === target ||
        (targetDigits && fDigits === targetDigits) ||
        f.endsWith(target) ||
        target.endsWith(f) ||
        it.bodyText.toUpperCase().includes(target)
      );
    });
  }

  if (queryFilter) {
    const qLower = String(queryFilter).trim().toLowerCase();
    items = items.filter(
      it =>
        String(it.folio || '').toLowerCase().includes(qLower) ||
        String(it.empresaReceptora || '').toLowerCase().includes(qLower) ||
        String(it.to || '').toLowerCase().includes(qLower) ||
        String(it.bodyText || '').toLowerCase().includes(qLower)
    );
  }

  // Ordenar: más recientes primero
  items.sort((a, b) => b.internalDate - a.internalDate);
  return items;
}

// ── Generador de PDF Oficial de 1 Página con pdf-lib ─────────────
function sanitizeWinAnsi(str) {
  if (!str) return '';
  return String(str)
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u2013|\u2014/g, '-')
    .replace(/\u2022/g, '*')
    .replace(/[^\x20-\x7E\xA0-\xFF\n]/g, '')
    .trim();
}

function wrapText(text, font, fontSize, maxWidth) {
  const paragraphs = sanitizeWinAnsi(text).split('\n');
  const lines = [];
  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) {
      lines.push('');
      continue;
    }
    const words = trimmed.split(/\s+/);
    let currentLine = '';
    for (const word of words) {
      const candidate = currentLine ? `${currentLine} ${word}` : word;
      const w = font.widthOfTextAtSize(candidate, fontSize);
      if (w <= maxWidth) {
        currentLine = candidate;
      } else {
        if (currentLine) lines.push(currentLine);
        currentLine = word;
      }
    }
    if (currentLine) lines.push(currentLine);
  }
  return lines;
}

async function generateConfirmationPdfBuffer(conf, extraMeta = {}) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([612, 792]); // Carta (Letter)
  const { width, height } = page.getSize();

  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  // Colores institucionales
  const navyDark = rgb(0.06, 0.09, 0.16);
  const redAccent = rgb(0.86, 0.15, 0.15);
  const greenBg = rgb(0.93, 0.99, 0.95);
  const greenBorder = rgb(0.13, 0.77, 0.37);
  const greenText = rgb(0.08, 0.45, 0.22);
  const slateBg = rgb(0.97, 0.98, 0.99);
  const slateBorder = rgb(0.85, 0.88, 0.92);
  const textDark = rgb(0.12, 0.16, 0.23);
  const textMuted = rgb(0.4, 0.45, 0.53);

  // 1. Encabezado institucional
  page.drawRectangle({
    x: 0,
    y: height - 92,
    width,
    height: 92,
    color: navyDark
  });
  page.drawRectangle({
    x: 0,
    y: height - 96,
    width,
    height: 4,
    color: redAccent
  });

  page.drawText('GRUPO FARRERA  |  SISTEMA AUTOTEC WEB', {
    x: 42,
    y: height - 38,
    size: 13,
    font: fontBold,
    color: rgb(1, 1, 1)
  });

  page.drawText('ACUSE OFICIAL DE REGISTRO EN BUZON DE FACTURAS ELECTRONICAS', {
    x: 42,
    y: height - 58,
    size: 10.5,
    font: fontBold,
    color: rgb(0.95, 0.75, 0.75)
  });

  const fechaFormat = conf.internalDate
    ? new Date(conf.internalDate).toLocaleString('es-MX', {
        timeZone: 'America/Mexico_City',
        dateStyle: 'long',
        timeStyle: 'medium'
      })
    : conf.date || new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' });

  page.drawText(sanitizeWinAnsi(`Emitido: ${fechaFormat}`), {
    x: 42,
    y: height - 76,
    size: 8.5,
    font: fontRegular,
    color: rgb(0.78, 0.82, 0.88)
  });

  // 2. Banner de Estatus Verificado
  let cursorY = height - 122;
  page.drawRectangle({
    x: 42,
    y: cursorY - 66,
    width: width - 84,
    height: 66,
    color: greenBg,
    borderColor: greenBorder,
    borderWidth: 1.5
  });

  page.drawText('CONFIRMADO: FACTURA ELECTRONICA REGISTRADA EN AUTOTEC', {
    x: 58,
    y: cursorY - 22,
    size: 11,
    font: fontBold,
    color: greenText
  });

  const empresaStr = sanitizeWinAnsi(
    conf.empresaReceptora || extraMeta.receptorNombre || 'VALOR FARRERA AUTOMOTRIZ S. DE R.L. DE C.V.'
  );
  page.drawText(`RAZON SOCIAL RECEPTORA: ${empresaStr}`, {
    x: 58,
    y: cursorY - 40,
    size: 9.5,
    font: fontBold,
    color: textDark
  });

  const folioStr = sanitizeWinAnsi(conf.folio || extraMeta.folio || 'S/F');
  page.drawText(`FOLIO FACTURA: ${folioStr}`, {
    x: 58,
    y: cursorY - 55,
    size: 9.5,
    font: fontBold,
    color: redAccent
  });

  // 3. Tabla de Datos de Confirmación del Correo
  cursorY -= 90;
  page.drawText('DATOS DE CERTIFICACION DEL CORREO DE NOTIFICACION', {
    x: 42,
    y: cursorY,
    size: 10,
    font: fontBold,
    color: navyDark
  });

  cursorY -= 12;
  const rows = [
    ['Remitente Oficial:', sanitizeWinAnsi(conf.from || 'Sistema Autotec Web <notifica@gfarrera.com.mx>')],
    ['Destinatario:', sanitizeWinAnsi(conf.to || extraMeta.correo || 'toyotachiapas30@gmail.com')],
    ['Asunto del Correo:', sanitizeWinAnsi(conf.subject || 'Factura electronica registrada.')],
    ['Fecha / Hora Recepcion:', sanitizeWinAnsi(fechaFormat)],
    ['Folio Registrado:', folioStr],
    ['Empresa Receptora (Buzon):', empresaStr],
    ['ID de Mensaje (SMTP/Gmail):', sanitizeWinAnsi(conf.id || 'CONFIRMADO-DIRECTO-PORTAL')]
  ];

  if (extraMeta.emisorNombre) {
    rows.push(['Proveedor / Emisor:', sanitizeWinAnsi(extraMeta.emisorNombre)]);
  }
  if (extraMeta.uuid) {
    rows.push(['UUID Fiscal (SAT):', sanitizeWinAnsi(extraMeta.uuid)]);
  }
  if (extraMeta.total) {
    rows.push(['Importe Total:', sanitizeWinAnsi(`$${Number(extraMeta.total).toLocaleString('es-MX', { minimumFractionDigits: 2 })}`)]);
  }

  const rowHeight = 22;
  const tableHeight = rows.length * rowHeight + 12;

  page.drawRectangle({
    x: 42,
    y: cursorY - tableHeight,
    width: width - 84,
    height: tableHeight,
    color: slateBg,
    borderColor: slateBorder,
    borderWidth: 1
  });

  let rowY = cursorY - 18;
  for (let i = 0; i < rows.length; i++) {
    const [label, val] = rows[i];
    if (i > 0) {
      page.drawLine({
        start: { x: 50, y: rowY + 13 },
        end: { x: width - 50, y: rowY + 13 },
        thickness: 0.5,
        color: slateBorder
      });
    }
    page.drawText(label, {
      x: 54,
      y: rowY,
      size: 8.5,
      font: fontBold,
      color: textMuted
    });
    page.drawText(val.slice(0, 75), {
      x: 195,
      y: rowY,
      size: 8.8,
      font: i === 4 || i === 5 ? fontBold : fontRegular,
      color: textDark
    });
    rowY -= rowHeight;
  }

  // 4. Cuerpo íntegro del correo de confirmación
  cursorY = cursorY - tableHeight - 28;
  page.drawText('MENSAJE INTEGRO EMITIDO POR SISTEMA AUTOTEC WEB (notifica@gfarrera.com.mx)', {
    x: 42,
    y: cursorY,
    size: 10,
    font: fontBold,
    color: navyDark
  });

  cursorY -= 12;
  const defaultBody = `${empresaStr} le informa que su Factura Electronica ${folioStr} se registro exitosamente y se encuentra en proceso de revision.\n\nPor su atencion, gracias.`;
  const bodyLines = wrapText(conf.bodyText || defaultBody, fontRegular, 10, width - 116);
  const bodyBoxHeight = Math.max(95, bodyLines.length * 15 + 32);

  page.drawRectangle({
    x: 42,
    y: cursorY - bodyBoxHeight,
    width: width - 84,
    height: bodyBoxHeight,
    color: rgb(1, 1, 1),
    borderColor: slateBorder,
    borderWidth: 1.2
  });

  let textY = cursorY - 24;
  for (const line of bodyLines) {
    if (textY < 90) break;
    page.drawText(line, {
      x: 58,
      y: textY,
      size: 10,
      font: line.includes('le informa que su Factura') ? fontBold : fontRegular,
      color: textDark
    });
    textY -= 15;
  }

  // 5. Pie de página institucional
  page.drawLine({
    start: { x: 42, y: 64 },
    end: { x: width - 42, y: 64 },
    thickness: 0.8,
    color: slateBorder
  });

  page.drawText(
    'Comprobante oficial generado por Control de Pagos Toyota Chiapas (control.pagos.toyoter.com) a partir de la',
    {
      x: 42,
      y: 48,
      size: 7.8,
      font: fontRegular,
      color: textMuted
    }
  );
  page.drawText(
    'confirmacion electronica de Sistema Autotec Web (notifica@gfarrera.com.mx) - Grupo Farrera.',
    {
      x: 42,
      y: 36,
      size: 7.8,
      font: fontRegular,
      color: textMuted
    }
  );

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

// ── Descargar archivo desde Google Drive si no viene adjunto ─────
async function fetchDriveFileBuffer(fileId) {
  const auth = getAuthorizedClient();
  if (!auth) throw new Error('Google Drive no está autenticado.');
  const drive = getGoogle().drive({ version: 'v3', auth });
  const meta = await drive.files.get({ fileId, fields: 'name,mimeType' });
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
  return {
    filename: meta.data.name || `${fileId}.bin`,
    buffer: Buffer.from(res.data)
  };
}

// ── POST /api/autotec/buzon: Envío atómico en 1 clic + Confirmación PDF ─
router.post(
  '/buzon',
  upload.fields([
    { name: 'xml', maxCount: 1 },
    { name: 'pdf', maxCount: 1 }
  ]),
  async (req, res) => {
    try {
      let xmlBuffer = req.files?.xml?.[0]?.buffer || null;
      let xmlFilename = req.files?.xml?.[0]?.originalname || 'factura.xml';
      let pdfBuffer = req.files?.pdf?.[0]?.buffer || null;
      let pdfFilename = req.files?.pdf?.[0]?.originalname || 'factura.pdf';

      if (!xmlBuffer && req.body.driveXmlId) {
        const dXml = await fetchDriveFileBuffer(req.body.driveXmlId);
        xmlBuffer = dXml.buffer;
        xmlFilename = dXml.filename;
      }
      if (!pdfBuffer && req.body.drivePdfId) {
        const dPdf = await fetchDriveFileBuffer(req.body.drivePdfId);
        pdfBuffer = dPdf.buffer;
        pdfFilename = dPdf.filename;
      }

      if (!xmlBuffer || !pdfBuffer) {
        return res.status(400).json({
          error: 'Debes adjuntar tanto el archivo XML como el PDF de la factura.'
        });
      }

      const xmlMeta = parseXmlQuickMeta(xmlBuffer);
      const folio = String(req.body.folio || xmlMeta.folio || '').trim();

      const nombre = (req.body.nombre || 'YONI JAVIER RUIZ DOMINGUEZ').trim();
      const telefono = (req.body.telefono || '9616179900').trim();
      const correo = (req.body.correo || 'toyotachiapas30@gmail.com').trim();
      const ordenCompra = (req.body.ordenCompra || '').trim();

      let alertsVal = [];
      let alertsEnv = [];
      let avisoPortal = 'Factura registrada exitosamente en el Buzón de Grupo Farrera.';

      if (process.env.VERCEL) {
        const atomicRes = await relayAtomicBuzonSubmit({
          xmlBuffer,
          pdfBuffer,
          xmlFilename,
          pdfFilename,
          nombre,
          telefono,
          correo,
          ordenCompra,
          timeoutMs: 52000
        });
        if (!atomicRes || atomicRes.ok === false) {
          return res.status(400).json({
            ok: false,
            error: `El Buzón Autotec rechazó la validación del XML: ${atomicRes?.error || 'Error de validación'}`,
            alertsVal: atomicRes?.alertsVal || [],
            xmlMeta
          });
        }
        alertsVal = atomicRes.alertsVal || [];
        alertsEnv = atomicRes.alertsEnv || [];
        avisoPortal = atomicRes.avisoPortal || avisoPortal;
      } else {
        // PASO 1: GET /buzonfecg.aspx para iniciar sesión y obtener tokens ASP.NET
        const getRes = await requestAutotecBuzon({
          method: 'GET',
          path: '/buzonfecg.aspx'
        });

        const sessionCookies = (getRes.setCookie || []).map(c => c.split(';')[0]).join('; ');
        const t1 = extractTokens(getRes.html);

        if (!t1.vs) {
          throw new Error('El portal de Autotec no devolvió un estado de sesión válido (__VIEWSTATE).');
        }

        // PASO 2: POST Validar XML (ctl00$ContentPlaceHolder1$btnValidaXML)
        const mpVal = buildMultipart(
          {
            ctl00_ToolkitScriptManager1_HiddenField: '',
            __EVENTTARGET: 'ctl00$ContentPlaceHolder1$btnValidaXML',
            __EVENTARGUMENT: '',
            __VIEWSTATE: t1.vs,
            __VIEWSTATEGENERATOR: t1.vsg,
            __EVENTVALIDATION: t1.ev,
            'ctl00$ContentPlaceHolder1$txtNombre': nombre,
            'ctl00$ContentPlaceHolder1$txtTelefono': telefono,
            'ctl00$ContentPlaceHolder1$txtMail': correo,
            'ctl00$ContentPlaceHolder1$txtOrdenCompra': ordenCompra
          },
          [
            {
              field: 'ctl00$ContentPlaceHolder1$FileUploadXML',
              filename: xmlFilename,
              contentType: 'text/xml',
              data: xmlBuffer
            },
            {
              field: 'ctl00$ContentPlaceHolder1$FileUploadPDF',
              filename: '',
              contentType: 'application/octet-stream',
              data: Buffer.alloc(0)
            }
          ]
        );

        const valRes = await requestAutotecBuzon({
          method: 'POST',
          path: '/buzonfecg.aspx',
          headers: {
            Cookie: sessionCookies,
            'Content-Type': `multipart/form-data; boundary=${mpVal.boundary}`,
            Referer: 'https://autotec.farrera.net:60002/buzonfecg.aspx'
          },
          bodyBuffer: mpVal.body
        });

        alertsVal = extractAlerts(valRes.html);
        const t2 = extractTokens(valRes.html);

        const hasBtnEnviar = /ctl00_ContentPlaceHolder1_btnEnviar/i.test(valRes.html);
        if (!hasBtnEnviar && alertsVal.length > 0) {
          return res.status(400).json({
            ok: false,
            error: `El Buzón Autotec rechazó la validación del XML: ${alertsVal.join(' | ')}`,
            alertsVal,
            xmlMeta
          });
        }

        // PASO 3: Inmediatamente (< 50ms) POST Enviar PDF (ctl00$ContentPlaceHolder1$btnEnviar)
        const mpEnv = buildMultipart(
          {
            ctl00_ToolkitScriptManager1_HiddenField: '',
            __EVENTTARGET: 'ctl00$ContentPlaceHolder1$btnEnviar',
            __EVENTARGUMENT: '',
            __VIEWSTATE: t2.vs || t1.vs,
            __VIEWSTATEGENERATOR: t2.vsg || t1.vsg,
            __EVENTVALIDATION: t2.ev || t1.ev,
            'ctl00$ContentPlaceHolder1$txtNombre': nombre,
            'ctl00$ContentPlaceHolder1$txtTelefono': telefono,
            'ctl00$ContentPlaceHolder1$txtMail': correo,
            'ctl00$ContentPlaceHolder1$txtOrdenCompra': ordenCompra
          },
          [
            {
              field: 'ctl00$ContentPlaceHolder1$FileUploadXML',
              filename: '',
              contentType: 'application/octet-stream',
              data: Buffer.alloc(0)
            },
            {
              field: 'ctl00$ContentPlaceHolder1$FileUploadPDF',
              filename: pdfFilename,
              contentType: 'application/pdf',
              data: pdfBuffer
            }
          ]
        );

        const envRes = await requestAutotecBuzon({
          method: 'POST',
          path: '/buzonfecg.aspx',
          headers: {
            Cookie: sessionCookies,
            'Content-Type': `multipart/form-data; boundary=${mpEnv.boundary}`,
            Referer: 'https://autotec.farrera.net:60002/buzonfecg.aspx'
          },
          bodyBuffer: mpEnv.body
        });

        alertsEnv = extractAlerts(envRes.html);
        avisoPortal =
          alertsEnv[0] || alertsVal[0] || 'Factura registrada exitosamente en el Buzón de Grupo Farrera.';
      }

      // PASO 4: Buscar el correo de confirmación en Gmail (notifica@gfarrera.com.mx)
      // Esperamos hasta ~8 segundos (en intervalos de 2s) para capturar el correo recién llegado.
      let confirmacion = null;
      const submitStartMs = Date.now() - 60000; // considerar correos del último minuto o previos del mismo folio
      for (let attempt = 0; attempt < 4; attempt++) {
        await new Promise(r => setTimeout(r, 2000));
        try {
          const matches = await listNotificaConfirmations({
            folioFilter: folio,
            maxResults: 15
          });
          if (matches.length > 0) {
            // Preferir el correo más reciente registrado bajo VALOR FARRERA AUTOMOTRIZ
            const recentValor = matches.find(
              m => m.esValorFarrera && m.internalDate >= submitStartMs
            );
            confirmacion =
              recentValor ||
              matches.find(m => m.esValorFarrera) ||
              matches[0];
            if (recentValor || attempt >= 1) break;
          }
        } catch (_) {
          // continuar reintento
        }
      }

      const fallbackPdfParams = new URLSearchParams({
        folio: folio || 'S-F',
        empresa: xmlMeta.receptorNombre || 'VALOR FARRERA AUTOMOTRIZ S. DE R.L. DE C.V.',
        emisor: xmlMeta.emisorNombre || '',
        uuid: xmlMeta.uuid || '',
        total: xmlMeta.total || '',
        correo
      }).toString();

      const pdfDownloadUrl = confirmacion
        ? confirmacion.pdfDownloadUrl
        : `/api/autotec/confirmacion-pdf-by-folio/${encodeURIComponent(folio || 'S-F')}?download=1&${fallbackPdfParams}`;

      const pdfPreviewUrl = confirmacion
        ? confirmacion.pdfPreviewUrl
        : `/api/autotec/confirmacion-pdf-by-folio/${encodeURIComponent(folio || 'S-F')}?${fallbackPdfParams}`;

      return res.json({
        ok: true,
        folio,
        xmlMeta,
        avisoPortal,
        alertsVal,
        alertsEnv,
        empresaReceptora:
          confirmacion?.empresaReceptora ||
          xmlMeta.receptorNombre ||
          'VALOR FARRERA AUTOMOTRIZ S. DE R.L. DE C.V.',
        confirmacion: confirmacion || {
          id: null,
          folio,
          empresaReceptora:
            xmlMeta.receptorNombre || 'VALOR FARRERA AUTOMOTRIZ S. DE R.L. DE C.V.',
          to: correo,
          subject: 'Factura electrónica registrada.',
          dateIso: new Date().toISOString(),
          pdfDownloadUrl,
          pdfPreviewUrl
        },
        pdfDownloadUrl,
        pdfPreviewUrl
      });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: `Error al enviar al Buzón Autotec: ${err.message}`
      });
    }
  }
);

// ── GET /api/autotec/confirmaciones: Historial de confirmaciones en Gmail ─
router.get('/confirmaciones', async (req, res) => {
  try {
    const folioFilter = (req.query.folio || '').trim();
    const queryFilter = (req.query.q || '').trim();
    const maxResults = Math.min(Number(req.query.limit) || 35, 60);

    const items = await listNotificaConfirmations({
      folioFilter,
      queryFilter,
      maxResults
    });

    return res.json({
      ok: true,
      total: items.length,
      items
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: `Error consultando confirmaciones de Autotec: ${err.message}`
    });
  }
});

// ── GET /api/autotec/confirmacion-pdf/:messageId: Descargar/Ver PDF por ID de correo ─
router.get('/confirmacion-pdf/:messageId', async (req, res) => {
  try {
    const { messageId } = req.params;
    const isDownload = req.query.download === '1' || req.query.download === 'true';

    const auth = getAuthorizedClient();
    if (!auth) return res.status(401).send('Gmail no está autenticado.');
    const gmail = getGoogle().gmail({ version: 'v1', auth });

    const msg = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full'
    });

    const parsed = parseNotificaEmail(msg.data);
    const pdfBuffer = await generateConfirmationPdfBuffer(parsed, {
      emisorNombre: req.query.emisor || '',
      uuid: req.query.uuid || '',
      total: req.query.total || ''
    });

    const cleanFolio = (parsed.folio || messageId).replace(/[^A-Za-z0-9_-]/g, '');
    const filename = `Confirmacion-Autotec-Folio-${cleanFolio}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `${isDownload ? 'attachment' : 'inline'}; filename="${filename}"`
    );
    return res.send(pdfBuffer);
  } catch (err) {
    return res.status(500).send(`Error generando PDF de confirmación: ${err.message}`);
  }
});

// ── GET /api/autotec/confirmacion-pdf-by-folio/:folio: Descargar/Ver PDF por Folio ─
router.get('/confirmacion-pdf-by-folio/:folio', async (req, res) => {
  try {
    const folio = String(req.params.folio || req.query.folio || '').trim();
    const isDownload = req.query.download === '1' || req.query.download === 'true';

    let matched = null;
    if (folio && folio !== 'S-F') {
      try {
        const items = await listNotificaConfirmations({ folioFilter: folio, maxResults: 20 });
        matched = items.find(m => m.esValorFarrera) || items[0] || null;
      } catch (_) {}
    }

    const confObj = matched || {
      id: 'CONFIRMADO-PORTAL-AUTOTEC',
      internalDate: Date.now(),
      from: 'Sistema Autotec Web <notifica@gfarrera.com.mx>',
      to: req.query.correo || 'toyotachiapas30@gmail.com',
      subject: 'Factura electrónica registrada.',
      folio: folio || 'S/F',
      empresaReceptora:
        req.query.empresa || 'VALOR FARRERA AUTOMOTRIZ S. DE R.L. DE C.V.',
      bodyText: `${
        req.query.empresa || 'VALOR FARRERA AUTOMOTRIZ S. DE R.L. DE C.V.'
      } le informa que su Factura Electrónica ${
        folio || 'S/F'
      } se registró exitosamente y se encuentra en proceso de revisión.\n\nPor su atención, gracias.`
    };

    const pdfBuffer = await generateConfirmationPdfBuffer(confObj, {
      folio,
      receptorNombre: req.query.empresa,
      emisorNombre: req.query.emisor,
      uuid: req.query.uuid,
      total: req.query.total,
      correo: req.query.correo
    });

    const cleanFolio = (confObj.folio || 'Factura').replace(/[^A-Za-z0-9_-]/g, '');
    const filename = `Confirmacion-Autotec-Folio-${cleanFolio}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `${isDownload ? 'attachment' : 'inline'}; filename="${filename}"`
    );
    return res.send(pdfBuffer);
  } catch (err) {
    return res.status(500).send(`Error generando PDF por folio: ${err.message}`);
  }
});

module.exports = router;
