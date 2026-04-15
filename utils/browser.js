const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const path = require('path');
const fs = require('fs');

const IS_CLOUD = process.env.NODE_ENV === 'production' || process.env.PUPPETEER_EXECUTABLE_PATH;
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
  const executablePath = IS_CLOUD ? getCloudChromePath() : CHROME_PATH_MAC;
  
  const launchOptions = {
    headless: IS_CLOUD ? 'new' : false,
    executablePath: executablePath || undefined,
    defaultViewport: IS_CLOUD ? { width: 1280, height: 800 } : null,
    ignoreDefaultArgs: IS_CLOUD ? false : true,
    args: IS_CLOUD ? [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--lang=es-MX,es;q=0.9',
      ...extraArgs
    ] : [
      '--remote-debugging-port=0',
      `--user-data-dir=${USER_DATA_DIR}`,
      '--start-maximized',
      '--lang=es-MX,es;q=0.9',
      '--no-first-run',
      '--no-default-browser-check',
      ...extraArgs
    ]
  };
  
  return puppeteer.launch(launchOptions);
};

module.exports = {
  launchBrowser,
  IS_CLOUD
};
