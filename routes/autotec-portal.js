const express = require('express');
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const launchBrowser = () => require('puppeteer').launch({
  headless: false,
  executablePath: CHROME_PATH,
  defaultViewport: null,
  args: ['--ignore-certificate-errors', '--disable-web-security', '--start-maximized']
});
const fs = require('fs');
const os = require('os');
const path = require('path');
const router = express.Router();

const URL_PORTAL = 'https://autotec.farrera.net/EnvioFacturasGastos/Account/Login?ReturnUrl=%2FEnvioFacturasGastos%2Fhome%2Findex';

// ── POST /api/portal/enviar ─────────────────────────────
// Body: { uuid, rfcEmisor, noFactura }
router.post('/enviar', async (req, res) => {
  const { uuid, rfcEmisor, noFactura } = req.body;
  const user = process.env.AUTOTEC_USER;
  const pass = process.env.AUTOTEC_PASS;

  if (!user || !pass)
    return res.status(400).json({ ok: false, error: 'Faltan las credenciales de Autotec en el archivo .env' });

  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();

    // ── 1. Login ──────────────────────────────────────────
    await page.goto(URL_PORTAL, { waitUntil: 'networkidle2', timeout: 30000 });

    // Look for username and password inputs
    await page.waitForSelector('input', { timeout: 10000 });
    const inputs = await page.$$('input[type="text"], input[type="email"], input:not([type="password"]):not([type="submit"]):not([type="hidden"])');
    if (inputs.length > 0) await inputs[0].type(user, { delay: 50 });
    const passInput = await page.$('input[type="password"]');
    if (passInput) await passInput.type(pass, { delay: 50 });

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {}),
      page.click('input[type="submit"], button[type="submit"]').catch(() => {})
    ]);

    // ── 2. Search for invoice ─────────────────────────────
    // Try to find a search input and enter the invoice identifier
    const searchTerm = noFactura || uuid || rfcEmisor;
    const searchInput = await page.$('input[type="search"], input[placeholder*="busca" i], input[placeholder*="factura" i], input[name*="search" i]').catch(() => null);
    if (searchInput && searchTerm) {
      await searchInput.type(searchTerm, { delay: 50 });
      await page.keyboard.press('Enter');
      await page.waitForTimeout(2000);
    }

    // ── 3. Screenshot before action ───────────────────────
    const screenshotBefore = path.join(os.tmpdir(), 'portal-before.png');
    await page.screenshot({ path: screenshotBefore, fullPage: true });

    // ── 4. Click "Enviar" button ──────────────────────────
    const enviarBtn = await page.$x('//button[contains(text(),"Enviar")] | //a[contains(text(),"Enviar")] | //input[@value="Enviar"]').catch(() => []);
    if (enviarBtn.length > 0) {
      await enviarBtn[0].click();
      await page.waitForTimeout(2000);
    }

    // ── 5. Print the page ─────────────────────────────────
    await page.evaluate(() => window.print());
    await page.waitForTimeout(1500);

    // ── 6. Final screenshot ────────────────────────────────
    const screenshotAfter = path.join(os.tmpdir(), 'portal-after.png');
    await page.screenshot({ path: screenshotAfter, fullPage: true });
    const screenshotB64 = fs.readFileSync(screenshotAfter).toString('base64');

    await browser.close();

    return res.json({
      ok: true,
      mensaje: 'Factura enviada en el portal y pantalla mandada a imprimir.',
      screenshot: `data:image/png;base64,${screenshotB64}`
    });

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('Portal Autotec error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
