const express = require('express');
const axios = require('axios');
const xml2js = require('xml2js');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const path = require('path');

// Detect if running in cloud (Linux/Docker) or Local (Mac)
const IS_CLOUD = process.env.NODE_ENV === 'production' || process.env.PUPPETEER_EXECUTABLE_PATH;

const CHROME_PATH_MAC = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CHROME_PATH_CLOUD = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome-stable';

const USER_DATA_DIR = path.join(__dirname, '../chrome-data');

const launchBrowser = () => puppeteer.launch({
  headless: IS_CLOUD ? 'new' : false, // Headless in cloud, windowed locally
  executablePath: IS_CLOUD ? CHROME_PATH_CLOUD : CHROME_PATH_MAC,
  defaultViewport: IS_CLOUD ? { width: 1280, height: 800 } : null,
  ignoreDefaultArgs: IS_CLOUD ? false : true, // Use defaults in cloud for stability, persistent in local for bypass
  args: IS_CLOUD ? [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--lang=es-MX,es;q=0.9'
  ] : [
    '--remote-debugging-port=0',
    `--user-data-dir=${USER_DATA_DIR}`,
    '--start-maximized',
    '--lang=es-MX,es;q=0.9',
    '--no-first-run',
    '--no-default-browser-check'
  ]
});
const router = express.Router();

const SAT_URL = 'https://consultaqr.facturaelectronica.sat.gob.mx/ConsultaCFDIService.svc';
const SOAP_ACTION = 'http://tempuri.org/IConsultaCFDIService/Consulta';

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

// POST /api/sat/verificar
router.post('/verificar', async (req, res) => {
  console.log('📡 [SAT] Recibida solicitud de verificación:', req.body.uuid);
  const { uuid, rfcEmisor, rfcReceptor, total } = req.body;
  
  if (!uuid || !rfcEmisor || !rfcReceptor || !total) {
    console.error('❌ [SAT] Faltan campos:', req.body);
    return res.status(400).json({ ok: false, error: 'Faltan campos requeridos' });
  }

  try {
    const soap = buildSoapEnvelope(rfcEmisor, rfcReceptor, total, uuid);
    console.log('📤 [SAT] Enviando SOAP a:', SAT_URL);
    
    const response = await axios.post(SAT_URL, soap, {
      headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': SOAP_ACTION },
      timeout: 15000
    });
    
    console.log('📥 [SAT] Respuesta SOAP recibida');
    const satResult = await parseSoapResponse(response.data);
    console.log('✅ [SAT] Resultado:', satResult.estado);
    
    return res.json({ ok: true, ...satResult });
  } catch (err) {
    console.error('🔥 [SAT] Error en verificación:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/sat/imprimir-sat
// Opens the real SAT verification page, auto-fills all fields,
// waits for the user to solve CAPTCHA, then prints the result page.
router.post('/imprimir-sat', async (req, res) => {
  const { uuid, rfcEmisor, rfcReceptor, total } = req.body;
  if (!uuid || !rfcEmisor || !rfcReceptor || !total)
    return res.status(400).json({ ok: false, error: 'Faltan campos requeridos' });

  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();

    // Set a realistic User-Agent and Extra Headers
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'es-MX,es;q=0.9,en-US;q=0.8,en;q=0.7'
    });

    // Navigate to SAT verification page
    console.log('🌐 Navegando al portal oficial del SAT...');
    await page.goto('https://verificacfdi.facturaelectronica.sat.gob.mx/default.aspx', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    // Wait for the form to load
    await page.waitForSelector('#ctl00_MainContent_TxtUUID', { timeout: 15000 });

    // Fill in all the fields
    await page.type('#ctl00_MainContent_TxtUUID', uuid, { delay: 30 });
    await page.type('#ctl00_MainContent_TxtRfcEmisor', rfcEmisor, { delay: 30 });
    await page.type('#ctl00_MainContent_TxtRfcReceptor', rfcReceptor, { delay: 30 });

    // Note: The 'Monto' field was removed by SAT from this form.
    
    // Now we wait for the user to solve the CAPTCHA and click "Verificar"
    console.log('\n🔐 CAPTCHA: Resuelve el CAPTCHA en el navegador y haz clic en "Verificar CFDI"...\n');

    // Wait for the result to appear (user solves captcha and clicks verify)
    await page.waitForFunction(() => {
      const resultEl = document.querySelector('#ctl00_MainContent_PnlResultados');
      const table = document.querySelector('table');
      const bgText = document.body.innerText;
      return (resultEl && resultEl.offsetHeight > 0) || 
             (table && (table.innerText.includes('Vigente') || table.innerText.includes('Cancelado'))) ||
             bgText.includes('Efecto del comprobante') || 
             bgText.includes('Estado CFDI');
    }, { timeout: 300000 }); // 5 min timeout for user to solve CAPTCHA

    // Small wait for rendering to complete
    await new Promise(r => setTimeout(r, 2000));

    // Generate PDF natively
    const os = require('os');
    const path = require('path');
    const { exec } = require('child_process');
    const pdfPath = path.join(os.tmpdir(), `SAT_${uuid.replace(/-/g, '')}.pdf`);
    
    await page.pdf({ path: pdfPath, format: 'A4', printBackground: true });
    
    // Open the PDF using Preview
    exec(`open "${pdfPath}"`);

    // Take screenshot for the app
    const screenshot = await page.screenshot({ fullPage: true, encoding: 'base64' });

    // Close the browser
    await browser.close();

    return res.json({
      ok: true,
      mensaje: 'Portal oficial del SAT abierto y procesado.',
      screenshot: `data:image/png;base64,${screenshot}`
    });
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('SAT print error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
