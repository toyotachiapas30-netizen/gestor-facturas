const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

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

const launchBrowser = async (extraArgs = []) => {
  const executablePath = getExecutablePath();

  const baseArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--ignore-certificate-errors',
    '--disable-blink-features=AutomationControlled',
    '--lang=es-MX,es;q=0.9',
    '--no-first-run',
    '--no-default-browser-check',
    ...extraArgs
  ];

  return puppeteer.launch({
    headless: 'new',
    executablePath,
    defaultViewport: { width: 1280, height: 960 },
    args: baseArgs
  });
};

module.exports = {
  launchBrowser,
  IS_CLOUD
};
