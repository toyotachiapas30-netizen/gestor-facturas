const https = require('https');
const http = require('http');
const { URL } = require('url');
const { getAuthorizedClient } = require('../routes/drive');

const ANTIGRAVITY_FOLDER_ID = '1KaGywtG0CnKVKJE5wL8cVSq48U7tvl0F';
const BRIDGE_FILENAME = 'puente_buzon_farrera.json';
const DIRECT_ORIGIN = 'https://autotec.farrera.net:60002';

let cachedBridge = null;
let lastFetchTime = 0;

async function getBridgeConfig(forceRefresh = false) {
  if (!forceRefresh && cachedBridge && Date.now() - lastFetchTime < 30000) {
    return cachedBridge;
  }
  try {
    const auth = getAuthorizedClient();
    if (!auth) return cachedBridge;
    const { google } = require('googleapis');
    const drive = google.drive({ version: 'v3', auth });
    const res = await drive.files.list({
      q: `'${ANTIGRAVITY_FOLDER_ID}' in parents and name = '${BRIDGE_FILENAME}' and trashed = false`,
      fields: 'files(id, name)'
    });
    if (res.data.files && res.data.files.length > 0) {
      const fileId = res.data.files[0].id;
      const content = await drive.files.get({ fileId, alt: 'media' });
      cachedBridge = typeof content.data === 'string' ? JSON.parse(content.data) : content.data;
      lastFetchTime = Date.now();
      return cachedBridge;
    }
  } catch (e) {
    console.warn('⚠️ [BuzonBridge] Error leyendo config de Drive:', e.message);
  }
  return cachedBridge;
}

async function saveBridgeConfig(config) {
  const payload = {
    url: String(config.url || '').replace(/\/+$/, ''),
    hostname: config.hostname || 'Windows-Oficina',
    updatedAt: new Date().toISOString()
  };
  cachedBridge = payload;
  lastFetchTime = Date.now();

  try {
    const auth = getAuthorizedClient();
    if (!auth) return payload;
    const { google } = require('googleapis');
    const drive = google.drive({ version: 'v3', auth });
    const res = await drive.files.list({
      q: `'${ANTIGRAVITY_FOLDER_ID}' in parents and name = '${BRIDGE_FILENAME}' and trashed = false`,
      fields: 'files(id, name)'
    });
    const media = {
      mimeType: 'application/json',
      body: JSON.stringify(payload, null, 2)
    };
    if (res.data.files && res.data.files.length > 0) {
      await drive.files.update({ fileId: res.data.files[0].id, media });
    } else {
      await drive.files.create({
        resource: { name: BRIDGE_FILENAME, parents: [ANTIGRAVITY_FOLDER_ID] },
        media
      });
    }
  } catch (e) {
    console.warn('⚠️ [BuzonBridge] Error guardando config en Drive:', e.message);
  }
  return payload;
}

function forwardHttpRequest(targetBaseUrl, req, bodyBuffer, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const parsedTarget = new URL(req.originalUrl, targetBaseUrl);
    const isHttps = parsedTarget.protocol === 'https:';
    const lib = isHttps ? https : http;

    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const lower = k.toLowerCase();
      if (['host', 'connection', 'content-length', 'accept-encoding', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-vercel-id'].includes(lower)) {
        continue;
      }
      headers[k] = v;
    }
    // Preservar cookies de ASP.NET_SessionId y enviar host esperado por IIS de Farrera
    headers['Host'] = parsedTarget.hostname === 'autotec.farrera.net'
      ? 'autotec.farrera.net:60002'
      : parsedTarget.host;
    headers['User-Agent'] = req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
    if (bodyBuffer && bodyBuffer.length > 0) {
      headers['Content-Length'] = bodyBuffer.length;
    }

    const options = {
      protocol: parsedTarget.protocol,
      hostname: parsedTarget.hostname,
      port: parsedTarget.port || (isHttps ? 443 : 80),
      path: parsedTarget.pathname + parsedTarget.search,
      method: req.method,
      headers,
      rejectUnauthorized: false,
      timeout: timeoutMs
    };

    const proxyReq = lib.request(options, (proxyRes) => {
      const chunks = [];
      proxyRes.on('data', (c) => chunks.push(c));
      proxyRes.on('end', () => {
        resolve({
          statusCode: proxyRes.statusCode || 200,
          headers: proxyRes.headers,
          body: Buffer.concat(chunks)
        });
      });
    });

    proxyReq.on('timeout', () => {
      proxyReq.destroy(new Error(`Timeout (${timeoutMs}ms) conectando a ${targetBaseUrl}`));
    });
    proxyReq.on('error', (err) => reject(err));

    if (bodyBuffer && bodyBuffer.length > 0) {
      proxyReq.write(bodyBuffer);
    }
    proxyReq.end();
  });
}

async function handleBuzonProxy(req, res) {
  try {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const bodyBuffer = Buffer.concat(chunks);

    // 1. Verificar si hay un puente de oficina Windows registrado en Antigravity
    const bridge = await getBridgeConfig();
    let result = null;

    if (bridge && bridge.url) {
      try {
        result = await forwardHttpRequest(bridge.url, req, bodyBuffer, 20000);
      } catch (bridgeErr) {
        console.warn('⚠️ [BuzonBridge] Falló puente Windows, probando conexión directa:', bridgeErr.message);
      }
    }

    // 2. Si no hay puente o falló, intentar conexión directa a autotec.farrera.net:60002
    if (!result) {
      result = await forwardHttpRequest(DIRECT_ORIGIN, req, bodyBuffer, 10000);
    }

    // 3. Reenviar cabeceras (especialmente Set-Cookie de ASP.NET_SessionId)
    if (result.headers['set-cookie']) {
      const cleanedCookies = result.headers['set-cookie'].map(c =>
        c.replace(/;\s*domain=[^;]+/gi, '').replace(/;\s*secure/gi, '')
      );
      res.setHeader('Set-Cookie', cleanedCookies);
    }

    const contentType = result.headers['content-type'] || 'application/octet-stream';
    res.setHeader('Content-Type', contentType);

    if (contentType.includes('text/html')) {
      let html = result.body.toString('utf8');
      html = html.replace(/http:\/\/ajax\.googleapis\.com/g, 'https://ajax.googleapis.com');
      return res.status(result.statusCode).send(html);
    }

    return res.status(result.statusCode).send(result.body);
  } catch (err) {
    const bridge = cachedBridge;
    return res.status(502).send(`<!DOCTYPE html>
<html lang="es">
<head><meta charset="utf-8"><title>Puente Buzón Farrera</title>
<style>body{font-family:system-ui,sans-serif;max-width:680px;margin:40px auto;padding:24px;background:#f8fafc;color:#1e293b}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:24px;box-shadow:0 4px 12px rgba(0,0,0,0.05)}
.btn{display:inline-block;background:#dc2626;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600;margin-top:12px}</style>
</head>
<body>
  <div class="card">
    <h2>⚠️ El Buzón de Grupo Farrera requiere el Puente de Oficina Windows encendido</h2>
    <p>El firewall de Grupo Farrera (<code>autotec.farrera.net:60002</code>) bloqueó la conexión desde EE.UU. (${err.message}).</p>
    <p><strong>Estado del Puente Windows:</strong> ${bridge && bridge.url ? `Última conexión: ${bridge.url} (${bridge.updatedAt})` : 'Aún no iniciado en la PC de la oficina'}</p>
    <p>En la computadora Windows de la oficina, descarga y ejecuta con doble clic el instalador automático:</p>
    <a class="btn" href="/Instalar_Puente_Buzon_Farrera_Windows.bat" download>⬇️ Descargar Instalar_Puente_Buzon_Farrera_Windows.bat</a>
  </div>
</body></html>`);
  }
}

module.exports = {
  getBridgeConfig,
  saveBridgeConfig,
  handleBuzonProxy
};
