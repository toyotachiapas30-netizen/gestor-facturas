const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const os = require('os');

const IS_CLOUD = process.env.NODE_ENV === 'production' || Boolean(process.env.PUPPETEER_EXECUTABLE_PATH) || Boolean(process.env.RENDER);
const CHROME_PATH_MAC = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function getExecutablePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  const candidates = IS_CLOUD
    ? [
        '/usr/bin/google-chrome-stable',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium'
      ]
    : [CHROME_PATH_MAC];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

function cleanupStaleTempProfiles() {
  try {
    const tmp = os.tmpdir();
    const entries = fs.readdirSync(tmp);
    const now = Date.now();
    for (const name of entries) {
      if (name.startsWith('chr_prof_') || name.startsWith('puppeteer_dev_chrome_profile-')) {
        const full = path.join(tmp, name);
        try {
          const st = fs.statSync(full);
          if (now - st.mtimeMs > 120000) {
            fs.rmSync(full, { recursive: true, force: true });
          }
        } catch (e) {}
      }
    }
  } catch (e) {}
}

const launchBrowser = async (extraArgs = []) => {
  cleanupStaleTempProfiles();
  const executablePath = getExecutablePath();
  const userDataDir = path.join(os.tmpdir(), `chr_prof_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);

  const baseArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-default-apps',
    '--disable-sync',
    '--disable-translate',
    '--mute-audio',
    '--no-zygote',
    '--disk-cache-size=1',
    '--media-cache-size=1',
    '--ignore-certificate-errors',
    '--disable-blink-features=AutomationControlled',
    '--lang=es-MX,es;q=0.9',
    '--no-first-run',
    '--no-default-browser-check',
    ...extraArgs.filter(a => a !== '--disable-web-security')
  ];

  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath,
    userDataDir,
    defaultViewport: { width: 1280, height: 960 },
    args: baseArgs
  });

  const origClose = browser.close.bind(browser);
  browser.close = async () => {
    try {
      const pages = await browser.pages().catch(() => []);
      for (const p of pages) {
        await p.close().catch(() => {});
      }
    } catch (e) {}
    try {
      await origClose();
    } catch (e) {}
    try {
      const proc = browser.process();
      if (proc && !proc.killed) proc.kill('SIGKILL');
    } catch (e) {}
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch (e) {}
  };

  return browser;
};

module.exports = {
  launchBrowser,
  IS_CLOUD
};
