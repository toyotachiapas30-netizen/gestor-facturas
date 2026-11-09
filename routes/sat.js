const express = require('express');
const axios = require('axios');
const https = require('https');
const xml2js = require('xml2js');
const multer = require('multer');
const FormData = require('form-data');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });
const httpsAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: false });

const SAT_SOAP_URL = 'https://consultaqr.facturaelectronica.sat.gob.mx/ConsultaCFDIService.svc';
const SOAP_ACTION = 'http://tempuri.org/IConsultaCFDIService/Consulta';
const SAT_PORTAL_URL = 'https://verificacfdi.facturaelectronica.sat.gob.mx/';

let cachedSatLogoBytes = null;

async function getSatLogoBytes() {
  if (cachedSatLogoBytes) return cachedSatLogoBytes;
  try {
    const r = await axios.get(`${SAT_PORTAL_URL}Content/images/Logo-Hacienda-SAT.jpg`, {
      httpsAgent,
      responseType: 'arraybuffer',
      timeout: 8000
    });
    cachedSatLogoBytes = Buffer.from(r.data);
    return cachedSatLogoBytes;
  } catch (e) {
    return null;
  }
}

function buildSoapEnvelope(re, rr, tt, id) {
  const totalFormatted = parseFloat(tt).toFixed(6);
  const expresion = `?re=${encodeURIComponent(re)}&rr=${encodeURIComponent(rr)}&tt=${totalFormatted}&id=${id}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/">
  <soapenv:Header/>
  <soapenv:Body>
    <tem:Consulta>
      <tem:expresionImpresa><![CDATA[${expresion}]]></tem:expresionImpresa>
    </tem:Consulta>
  </soapenv:Body>
</soapenv:Envelope>`;
}

async function parseSoapResponse(xmlResponse) {
  const result = await xml2js.parseStringPromise(xmlResponse, { explicitArray: false });
  const body = result['s:Envelope']['s:Body'];
  const cr = body['ConsultaResponse']['ConsultaResult'];
  return {
    codigoEstatus: cr['a:CodigoEstatus'] || '',
    estado: cr['a:Estado'] || '',
    esCancelable: cr['a:EsCancelable'] || '',
    estatusCancelacion: cr['a:EstatusCancelacion'] || '',
    efos: cr['a:ValidezEFOS'] || ''
  };
}

// ── 1. POST /api/sat/verificar (Consulta rápida SOAP de respaldo) ──
router.post('/verificar', async (req, res) => {
  const { uuid, rfcEmisor, rfcReceptor, total } = req.body;
  if (!uuid || !rfcEmisor || !rfcReceptor || !total) {
    return res.status(400).json({ ok: false, error: 'Faltan campos requeridos' });
  }
  try {
    const soap = buildSoapEnvelope(rfcEmisor, rfcReceptor, total, uuid);
    const response = await axios.post(SAT_SOAP_URL, soap, {
      httpsAgent,
      headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': SOAP_ACTION },
      timeout: 15000
    });
    const satResult = await parseSoapResponse(response.data);
    return res.json({ ok: true, ...satResult });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Helper para extraer estado de sesión y captcha de Consulta por archivo XML
async function extractSatPortalState(html, cookies) {
  const vs = (html.match(/id="__VIEWSTATE"\s+value="([^"]*)"/) || [])[1];
  const vsg = (html.match(/id="__VIEWSTATEGENERATOR"\s+value="([^"]*)"/) || [])[1] || 'CA0B0334';
  const vse = (html.match(/id="__VIEWSTATEENCRYPTED"\s+value="([^"]*)"/) || [])[1] || '';
  const capSrc = (html.match(/id="ctl00_MainContent_ImgCaptchaXml"[^>]*src="([^"]*)"/) || [])[1]
    || (html.match(/id="ctl00_MainContent_ImgCaptcha"[^>]*src="([^"]*)"/) || [])[1];

  if (!vs || !capSrc) {
    throw new Error('No se pudo obtener el Captcha del portal del SAT.');
  }

  const capUrl = SAT_PORTAL_URL + capSrc.replace(/&amp;/g, '&').replace(/^\//, '');
  const rCap = await axios.get(capUrl, {
    httpsAgent,
    headers: {
      Cookie: cookies,
      Referer: SAT_PORTAL_URL,
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
    },
    responseType: 'arraybuffer',
    timeout: 10000
  });

  const captchaBase64 = Buffer.from(rCap.data).toString('base64');
  const satSessionToken = Buffer.from(JSON.stringify({ cookies, vs, vsg, vse })).toString('base64');

  return {
    satSessionToken,
    captchaImage: `data:image/jpeg;base64,${captchaBase64}`,
    rawCaptchaBase64: captchaBase64
  };
}

async function solveCaptchaWithGemini(rawBase64, apiKey) {
  const key = apiKey || process.env.GEMINI_API_KEY;
  if (!key) return null;
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(key)}`;
    const r = await axios.post(url, {
      contents: [{
        parts: [
          { text: 'Lee únicamente los 5 dígitos o caracteres que aparecen en este captcha del SAT. Responde SOLO los 5 caracteres sin espacios ni explicación.' },
          { inline_data: { mime_type: 'image/jpeg', data: rawBase64 } }
        ]
      }]
    }, { timeout: 8000 });
    const text = r.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const clean = text.replace(/[^a-zA-Z0-9]/g, '').trim();
    return clean.length >= 4 ? clean.slice(0, 6) : null;
  } catch (e) {
    return null;
  }
}

// ── 2. POST /api/sat/iniciar-portal (Inicia "Consulta por archivo XML" en verificacfdi.facturaelectronica.sat.gob.mx) ──
router.post('/iniciar-portal', upload.single('xml'), async (req, res) => {
  try {
    const r1 = await axios.get(SAT_PORTAL_URL, {
      httpsAgent,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
      },
      timeout: 12000
    });
    const cookies = (r1.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
    const state = await extractSatPortalState(r1.data, cookies);
    const autoCode = await solveCaptchaWithGemini(state.rawCaptchaBase64, req.body?.geminiKey);

    return res.json({
      ok: true,
      sessionId: state.satSessionToken,
      satSessionToken: state.satSessionToken,
      captchaImage: state.captchaImage,
      autoCode
    });
  } catch (err) {
    console.error('🔥 [SAT Portal Init] Error:', err.message);
    return res.status(500).json({ ok: false, error: 'Error conectando al portal del SAT: ' + err.message });
  }
});

function extractSpanValue(html, id) {
  const re = new RegExp(`id="${id}"[^>]*>([\\s\\S]*?)<\\/span>`, 'i');
  const m = html.match(re);
  if (!m) return '';
  return m[1].replace(/<[^>]+>/g, '').replace(/&#243;/g, 'ó').replace(/&amp;/g, '&').trim();
}

async function generateOfficialSatPdf(datos) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([612, 792]); // Letter
  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const { width, height } = page.getSize();
  let y = height - 45;

  // Logo SHCP / SAT
  const logoBytes = await getSatLogoBytes();
  if (logoBytes) {
    try {
      const jpgImage = await pdfDoc.embedJpg(logoBytes);
      page.drawImage(jpgImage, { x: 40, y: y - 32, width: 220, height: 30 });
    } catch (e) {}
  } else {
    page.drawText('SHCP | SAT - Servicio de Administración Tributaria', {
      x: 40, y: y - 15, size: 12, font: fontBold, color: rgb(0.4, 0.1, 0.15)
    });
  }

  page.drawText('Versión 4.5.1', { x: 40, y: y - 46, size: 8, font: fontRegular, color: rgb(0.35, 0.35, 0.35) });
  y -= 72;

  page.drawText('Verificación de comprobantes fiscales digitales por internet', {
    x: 40, y, size: 13, font: fontBold, color: rgb(0.15, 0.15, 0.15)
  });
  y -= 18;
  page.drawText('Modalidad: Consulta por archivo XML (Portal Oficial verificacfdi.facturaelectronica.sat.gob.mx)', {
    x: 40, y, size: 9, font: fontRegular, color: rgb(0.35, 0.35, 0.35)
  });
  y -= 14;

  // Línea roja institucional
  page.drawRectangle({ x: 40, y, width: width - 80, height: 2, color: rgb(0.62, 0.13, 0.25) });
  y -= 24;

  const colW = (width - 80) / 4;
  const drawTableSection = (headers, values) => {
    // Header row
    page.drawRectangle({ x: 40, y: y - 22, width: width - 80, height: 22, color: rgb(0.93, 0.93, 0.93) });
    headers.forEach((h, i) => {
      page.drawText(h, {
        x: 45 + i * colW,
        y: y - 14,
        size: 7.5,
        font: fontBold,
        color: rgb(0.15, 0.15, 0.15)
      });
    });
    y -= 22;

    // Data row
    const rowH = 34;
    page.drawRectangle({
      x: 40, y: y - rowH, width: width - 80, height: rowH,
      borderColor: rgb(0.85, 0.85, 0.85), borderWidth: 0.75, color: rgb(1, 1, 1)
    });
    values.forEach((val, i) => {
      const text = String(val || '');
      const lines = [];
      for (let pos = 0; pos < text.length; pos += 22) {
        lines.push(text.slice(pos, pos + 22));
      }
      lines.slice(0, 2).forEach((ln, idx) => {
        page.drawText(ln, {
          x: 45 + i * colW,
          y: y - 13 - idx * 10,
          size: 7.5,
          font: i === 2 && headers[2] === 'Estado CFDI' ? fontBold : fontRegular,
          color: i === 2 && headers[2] === 'Estado CFDI' && text.toLowerCase().includes('vigente')
            ? rgb(0.08, 0.5, 0.2)
            : rgb(0.1, 0.1, 0.1)
        });
      });
    });
    y -= rowH + 14;
  };

  drawTableSection(
    ['RFC del emisor', 'Nombre o razón social del emisor', 'RFC del receptor', 'Nombre o razón social del receptor'],
    [datos.rfcEmisor, datos.nombreEmisor, datos.rfcReceptor, datos.nombreReceptor]
  );

  drawTableSection(
    ['Folio fiscal', 'Fecha de expedición', 'Fecha certificación SAT', 'PAC que certificó'],
    [datos.uuid, datos.fechaEmision, datos.fechaCertificacion, datos.rfcPac]
  );

  drawTableSection(
    ['Total del CFDI', 'Efecto del comprobante', 'Estado CFDI', 'Estatus de cancelación'],
    [datos.total, datos.efecto, datos.estado, datos.estatusCancelacion || datos.esCancelable || 'Sin cancelación']
  );

  y -= 10;
  const nowStr = new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' });
  page.drawText(`Comprobante verificado directamente en: https://verificacfdi.facturaelectronica.sat.gob.mx/ (${nowStr})`, {
    x: 40, y, size: 8, font: fontRegular, color: rgb(0.4, 0.4, 0.4)
  });

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes).toString('base64');
}

// ── 3. POST /api/sat/resolver-portal (Envía el XML y el Captcha a Consulta por archivo XML) ──
router.post('/resolver-portal', upload.single('xml'), async (req, res) => {
  try {
    const token = req.body?.sessionId || req.body?.satSessionToken;
    const captchaCode = String(req.body?.captchaCode || '').trim();
    const xmlFile = req.file;

    if (!token || !captchaCode) {
      return res.status(400).json({ ok: false, error: 'Faltan sesión o código Captcha.' });
    }
    if (!xmlFile) {
      return res.status(400).json({ ok: false, error: 'No se recibió el archivo XML para validar en el SAT.' });
    }

    const { cookies, vs, vsg, vse } = JSON.parse(Buffer.from(token, 'base64').toString('utf8'));

    const form = new FormData();
    form.append('__VIEWSTATE', vs);
    form.append('__VIEWSTATEGENERATOR', vsg || 'CA0B0334');
    form.append('__VIEWSTATEENCRYPTED', vse || '');
    form.append('tabs', 'on');
    form.append('ctl00$MainContent$TxtUUID', '');
    form.append('ctl00$MainContent$TxtRfcEmisor', '');
    form.append('ctl00$MainContent$TxtRfcReceptor', '');
    form.append('ctl00$MainContent$TxtCaptchaNumbers', '');
    form.append('ctl00$MainContent$hdnTotal', '');
    form.append('ctl00$MainContent$hdnSello', '');
    form.append('ctl00$MainContent$hdnConsultaFolio', 'false');
    form.append('ctl00$MainContent$fileUploadXML', xmlFile.buffer, {
      filename: xmlFile.originalname || 'factura.xml',
      contentType: 'text/xml'
    });
    form.append('ctl00$MainContent$TxtCaptchaNumbersXml', captchaCode);
    form.append('ctl00$MainContent$BtnBusquedaXml', 'Verificar CFDI');
    form.append('ctl00$MainContent$strBusquedaXml', '');

    const r = await axios.post(SAT_PORTAL_URL, form, {
      httpsAgent,
      headers: {
        ...form.getHeaders(),
        Cookie: cookies,
        Referer: SAT_PORTAL_URL,
        Origin: 'https://verificacfdi.facturaelectronica.sat.gob.mx',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
      },
      timeout: 20000
    });

    const html = r.data || '';
    const estado = extractSpanValue(html, 'ctl00_MainContent_LblEstadoXml');

    if (!estado) {
      // Si el captcha falló, extraer el nuevo captcha de la misma página devuelta por el SAT
      try {
        const newState = await extractSatPortalState(html, cookies);
        return res.json({
          ok: false,
          retryCaptcha: true,
          error: 'El código Captcha fue rechazado por el SAT. Intenta con la nueva imagen.',
          sessionId: newState.satSessionToken,
          satSessionToken: newState.satSessionToken,
          newCaptchaImage: newState.captchaImage
        });
      } catch (e) {
        return res.status(400).json({ ok: false, error: 'El SAT no devolvió resultado. Recarga el Captcha e intenta de nuevo.' });
      }
    }

    const datosPortal = {
      rfcEmisor: extractSpanValue(html, 'ctl00_MainContent_LblRfcEmisorXml'),
      nombreEmisor: extractSpanValue(html, 'ctl00_MainContent_LblNombreEmisorXml'),
      rfcReceptor: extractSpanValue(html, 'ctl00_MainContent_LblRfcReceptorXml'),
      nombreReceptor: extractSpanValue(html, 'ctl00_MainContent_LblNombreReceptorXml'),
      uuid: extractSpanValue(html, 'ctl00_MainContent_LblUuidXml'),
      fechaEmision: extractSpanValue(html, 'ctl00_MainContent_LblFechaEmisionXml'),
      fechaCertificacion: extractSpanValue(html, 'ctl00_MainContent_LblFechaCertificacionXml'),
      rfcPac: extractSpanValue(html, 'ctl00_MainContent_LblRfcPacXml'),
      total: extractSpanValue(html, 'ctl00_MainContent_LblMontoXml'),
      efecto: extractSpanValue(html, 'ctl00_MainContent_LblEfectoComprobanteXml'),
      estado,
      esCancelable: extractSpanValue(html, 'ctl00_MainContent_LblEsCancelableXml'),
      estatusCancelacion: extractSpanValue(html, 'ctl00_MainContent_LblEstatusCancelacionXml')
    };

    const pdfBase64 = await generateOfficialSatPdf(datosPortal);

    return res.json({
      ok: true,
      estado: datosPortal.estado,
      esCancelable: datosPortal.esCancelable,
      estatusCancelacion: datosPortal.estatusCancelacion,
      codigoEstatus: 'S - Comprobante obtenido satisfactoriamente (Consulta por archivo XML).',
      datosPortal,
      pdfBase64: `data:application/pdf;base64,${pdfBase64}`
    });
  } catch (err) {
    console.error('🔥 [SAT Portal Resolve] Error:', err.message);
    return res.status(500).json({ ok: false, error: 'Error al validar XML en el portal del SAT: ' + err.message });
  }
});

module.exports = router;
