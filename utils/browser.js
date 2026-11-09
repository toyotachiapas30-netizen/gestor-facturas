const path = require('path');
const fs = require('fs');

const IS_CLOUD = Boolean(process.env.NODE_ENV === 'production' || process.env.PUPPETEER_EXECUTABLE_PATH || process.env.VERCEL || process.env.RENDER);
const CHROME_PATH_MAC = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const USER_DATA_DIR = path.join(__dirname, '../chrome-data');

function getCloudChromePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  const paths = [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome'
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const launchBrowser = async (extraArgs = []) => {
  const puppeteer = require('puppeteer');
  const executablePath = IS_CLOUD ? getCloudChromePath() : CHROME_PATH_MAC;
  return puppeteer.launch({
    headless: 'new',
    executablePath: executablePath || undefined,
    defaultViewport: { width: 1280, height: 800 },
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--ignore-certificate-errors',
      '--lang=es-MX,es;q=0.9',
      ...extraArgs
    ]
  });
};

module.exports = {
  launchBrowser,
  IS_CLOUD
};
