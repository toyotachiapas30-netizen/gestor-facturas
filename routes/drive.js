const express = require('express');
// const { google } = require('googleapis'); // moved to lazy load
const getGoogle = () => require('googleapis').google;
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const router = express.Router();

// ── Config ────────────────────────────────────
const TOKENS_FILE = path.join(__dirname, '..', '.google-tokens.json');

// Dynamic Redirect URI (Cloud vs Local)
function getRedirectUri(req) {
  if (process.env.GOOGLE_REDIRECT_URI) return process.env.GOOGLE_REDIRECT_URI;
  const host = req ? req.get('host') : 'localhost:3001';
  const protocol = host.includes('localhost') ? 'http' : 'https';
  return `${protocol}://${host}/api/drive/callback`;
}

const SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/spreadsheets'
];

function getOAuthClient(req) {
  const { google } = require('googleapis');
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    getRedirectUri(req)
  );
}

function getAuthorizedClient() {
  const client = getOAuthClient();
  
  // 1. Try Refresh Token from Env (Cloud Mode)
  if (process.env.GOOGLE_REFRESH_TOKEN) {
    console.log('Using GOOGLE_REFRESH_TOKEN from environment');
    client.setCredentials({
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET
    });
    return client;
  }

  // 2. Try Local File (Local Mode)
  if (fs.existsSync(TOKENS_FILE)) {
    console.log('Using tokens from local file:', TOKENS_FILE);
    const tokens = JSON.parse(fs.readFileSync(TOKENS_FILE));
    client.setCredentials(tokens);
    return client;
  }

  return null;
}

const upload = multer({ storage: multer.memoryStorage() });

// ── GET /api/drive/auth-url  →  Returns Google auth URL ───
router.get('/auth-url', (req, res) => {
  const client = getOAuthClient(req);
  const url = client.generateAuthUrl({ access_type: 'offline', scope: SCOPES, prompt: 'consent' });
  res.json({ ok: true, url });
});

// ── GET /api/drive/callback  →  Handles OAuth callback ───
router.get('/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Falta el código de autorización');
  try {
    const client = getOAuthClient(req);
    const { tokens } = await client.getToken(code);
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens));

    const refreshToken = tokens.refresh_token;
    
    let extraMsg = '';
    if (refreshToken) {
        extraMsg = `
            <div style="margin-top:20px;padding:15px;background:#1a2234;border-radius:8px;border:1px solid #303f5f;text-align:left;">
                <p style="color:#a0aec0;font-size:14px;margin-top:0;"><b>Atención (Usuarios de Render/Cloud):</b></p>
                <p style="font-size:13px;margin-bottom:10px;">Si estás usando la app en la nube, debes actualizar tu variable de entorno <b>GOOGLE_REFRESH_TOKEN</b> con este valor:</p>
                <code style="display:block;background:#000;padding:10px;border-radius:4px;word-break:break-all;color:#00ff00;font-family:monospace;">${refreshToken}</code>
            </div>
        `;
    }

    res.send(`
        <html>
        <body style="font-family:sans-serif;text-align:center;padding:40px;background:#0a0f1e;color:#f0f4ff;max-width:600px;margin:auto;">
            <h2 style="color:#48bb78">✅ Google autorizado correctamente</h2>
            <p>Se han guardado los tokens localmente.</p>
            ${extraMsg}
            <p style="margin-top:30px;"><a href="/" style="color:#63b3ed;text-decoration:none;">← Regresar a la app</a></p>
        </body>
        </html>
    `);
  } catch (err) {
    res.status(500).send('Error al obtener tokens: ' + err.message);
  }
});

// ── POST /api/drive/logout  →  Clear tokens ───
router.post('/logout', (req, res) => {
  try {
    if (fs.existsSync(TOKENS_FILE)) {
      fs.unlinkSync(TOKENS_FILE);
    }
    res.json({ ok: true, message: 'Tokens eliminados. Por favor actualiza la página.' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/drive/status  →  Check if authorized ───
router.get('/status', (req, res) => {
  const isAuth = fs.existsSync(TOKENS_FILE);
  res.json({ ok: true, authorized: isAuth });
});

// ── POST /api/drive/upload  →  Upload XML + PDF to Drive ───
// Body: multipart form with fields xml, pdf, proveedorNombre
router.post('/upload', upload.fields([{ name: 'xml' }, { name: 'pdf' }]), async (req, res) => {
  const client = getAuthorizedClient();
  if (!client) return res.status(401).json({ ok: false, error: 'No autorizado con Google. Ve a Configuración.' });

  const { proveedorNombre, parentFolderId } = req.body;
  if (!proveedorNombre) return res.status(400).json({ ok: false, error: 'Falta el nombre del proveedor' });

  const drive = getGoogle().drive({ version: 'v3', auth: client });
  const rootFolderId = parentFolderId || process.env.GOOGLE_DRIVE_FOLDER_ID;

  try {
    // 1. Search or create subfolder with provider name
    const searchRes = await drive.files.list({
      q: `'${rootFolderId}' in parents and name='${proveedorNombre}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id, name)'
    });

    let folderId;
    if (searchRes.data.files.length > 0) {
      folderId = searchRes.data.files[0].id;
    } else {
      // Create new folder
      const newFolder = await drive.files.create({
        requestBody: { name: proveedorNombre, mimeType: 'application/vnd.google-apps.folder', parents: [rootFolderId] },
        fields: 'id'
      });
      folderId = newFolder.data.id;
    }

    const uploaded = [];

    // 2. Upload XML
    if (req.files['xml']) {
      const xmlFile = req.files['xml'][0];
      const xmlRes = await drive.files.create({
        requestBody: { name: xmlFile.originalname, parents: [folderId] },
        media: { mimeType: 'application/xml', body: require('stream').Readable.from(xmlFile.buffer) },
        fields: 'id, name, webViewLink'
      });
      uploaded.push({ tipo: 'XML', nombre: xmlRes.data.name, link: xmlRes.data.webViewLink });
    }

    // 3. Upload PDF
    if (req.files['pdf']) {
      const pdfFile = req.files['pdf'][0];
      const pdfRes = await drive.files.create({
        requestBody: { name: pdfFile.originalname, parents: [folderId] },
        media: { mimeType: 'application/pdf', body: require('stream').Readable.from(pdfFile.buffer) },
        fields: 'id, name, webViewLink'
      });
      uploaded.push({ tipo: 'PDF', nombre: pdfRes.data.name, link: pdfRes.data.webViewLink });
    }

    const folderLink = `https://drive.google.com/drive/folders/${folderId}`;
    return res.json({ ok: true, carpeta: proveedorNombre, folderId, folderLink, archivos: uploaded });

  } catch (err) {
    console.error('Drive error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = {
  router,
  getAuthorizedClient,
  getGoogle
};
