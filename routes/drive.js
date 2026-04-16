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
    client.setCredentials({
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET
    });
    return client;
  }

  // 2. Try Local File (Local Mode)
  if (fs.existsSync(TOKENS_FILE)) {
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
    res.send('<html><body style="font-family:sans-serif;text-align:center;padding:80px;background:#0a0f1e;color:#f0f4ff"><h2>✅ Google autorizado correctamente</h2><p>Puedes cerrar esta ventana y regresar a la app.</p></body></html>');
  } catch (err) {
    res.status(500).send('Error al obtener tokens: ' + err.message);
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

module.exports = router;
