const express = require('express');
// const { google } = require('googleapis'); // moved to lazy load
const getGoogle = () => require('googleapis').google;
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const router = express.Router();

// ── Config ────────────────────────────────────
const os = require('os');
const TOKENS_FILE = process.env.VERCEL
  ? path.join(os.tmpdir(), '.google-tokens.json')
  : path.join(__dirname, '..', '.google-tokens.json');
const BUNDLED_TOKENS_FILE = path.join(__dirname, '..', '.google-tokens.json');

const DEFAULT_DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID || '1i0gZJ2kSI6_7pt9fIWrDkk-s3EIWOxVc';

// Dynamic Redirect URI (Cloud vs Local)
function getRedirectUri(req) {
  if (process.env.GOOGLE_REDIRECT_URI) return process.env.GOOGLE_REDIRECT_URI;
  const host = req ? req.get('host') : 'control.pagos.toyoter.com';
  const protocol = host.includes('localhost') ? 'http' : 'https';
  return `${protocol}://${host}/api/drive/callback`;
}

const SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/gmail.readonly'
];

function getOAuthClient(req) {
  const { google } = require('googleapis');
  const https = require('https');
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    getRedirectUri(req)
  );
  // Desactivar keep-alive para evitar error "Premature close" en Node.js
  client.transporter.instance.defaults.agent = new https.Agent({ keepAlive: false });
  return client;
}

function getAuthorizedClient() {
  const client = getOAuthClient();
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  // 0. Preferir archivo local en /tmp o en proyecto si ya cuenta con permiso de Gmail
  for (const tf of [TOKENS_FILE, BUNDLED_TOKENS_FILE]) {
    if (fs.existsSync(tf)) {
      try {
        const localTokens = JSON.parse(fs.readFileSync(tf, 'utf8'));
        if (localTokens && localTokens.refresh_token && localTokens.scope && localTokens.scope.includes('gmail')) {
          client.setCredentials({
            ...localTokens,
            client_id: clientId,
            client_secret: clientSecret
          });
          return client;
        }
      } catch (e) {}
    }
  }
  
  // 1. Usar Refresh Token permanente verificado (toyotachiapas30@gmail.com con Drive + Sheets + Gmail)
  const activeRefreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  if (activeRefreshToken) {
    client.setCredentials({
      refresh_token: activeRefreshToken,
      client_id: clientId,
      client_secret: clientSecret
    });
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
    if (!tokens.refresh_token && fs.existsSync(TOKENS_FILE)) {
      try {
        const prev = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
        if (prev.refresh_token) tokens.refresh_token = prev.refresh_token;
      } catch (e) {}
    }
    if (!tokens.refresh_token && process.env.GOOGLE_REFRESH_TOKEN) {
      tokens.refresh_token = process.env.GOOGLE_REFRESH_TOKEN;
    }
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens));

    // Guardar copia de seguridad en SQLite + Google Drive para persistencia automática en Render
    try {
      const { getDB, backupDatabaseToDrive } = require('./gastos');
      const db = getDB();
      db.prepare(`
        INSERT INTO bandeja_config (clave, valor, updated_at)
        VALUES ('google_tokens', ?, datetime('now','localtime'))
        ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, updated_at = excluded.updated_at
      `).run(JSON.stringify(tokens));
      await backupDatabaseToDrive();
      console.log('✅ Google tokens respaldados en SQLite y Google Drive.');
    } catch (sqlErr) {
      console.error('⚠️ Error al respaldar tokens en SQLite:', sqlErr.message);
    }

    // Guardar copia de seguridad en Supabase
    if (process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
      try {
        const { createClient } = require('@supabase/supabase-js');
        const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
        await supabase.from('gastos').upsert({
          id: '00000000-0000-0000-0000-000000000000',
          proveedor: 'SYSTEM_CONFIG',
          concepto: JSON.stringify(tokens),
          monto: 0,
          mes: 'SYSTEM',
          fecha_factura: new Date().toISOString().split('T')[0]
        });
        console.log('✅ Google tokens respaldados en Supabase.');
      } catch (dbErr) {
        console.error('⚠️ Error al respaldar tokens en Supabase:', dbErr.message);
      }
    }

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
router.post('/logout', async (req, res) => {
  try {
    if (fs.existsSync(TOKENS_FILE)) {
      fs.unlinkSync(TOKENS_FILE);
    }
    // Eliminar también de Supabase
    if (process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
      try {
        const { createClient } = require('@supabase/supabase-js');
        const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
        await supabase.from('gastos').delete().eq('id', '00000000-0000-0000-0000-000000000000');
        console.log('🗑️ Tokens de Google eliminados de Supabase.');
      } catch (dbErr) {
        console.error('⚠️ Error al eliminar tokens en Supabase:', dbErr.message);
      }
    }
    res.json({ ok: true, message: 'Tokens eliminados. Por favor actualiza la página.' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/drive/status  →  Check if authorized ───
router.get('/status', (req, res) => {
  const isAuth = Boolean(getAuthorizedClient());
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
  const rootFolderId = parentFolderId || DEFAULT_DRIVE_FOLDER_ID;

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

async function restoreTokensFromDatabase() {
  // 1. Intentar restaurar desde SQLite (respaldado en Google Drive) si tiene el permiso de Gmail
  try {
    const { getDB } = require('./gastos');
    const db = getDB();
    const row = db.prepare("SELECT valor FROM bandeja_config WHERE clave = 'google_tokens'").get();
    if (row && row.valor) {
      fs.writeFileSync(TOKENS_FILE, row.valor);
      console.log('✅ Tokens de Google (con Gmail) restaurados desde SQLite.');
      return;
    }
  } catch (err) {
    console.warn('⚠️ Aviso al verificar tokens en SQLite:', err.message);
  }

  if (fs.existsSync(TOKENS_FILE)) return;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    console.log('ℹ️ Supabase no configurado, omitiendo restauración de tokens de Google.');
    return;
  }
  
  try {
    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
    const { data, error } = await supabase.from('gastos').select('concepto').eq('id', '00000000-0000-0000-0000-000000000000').maybeSingle();
    if (error) throw error;
    if (data && data.concepto) {
      console.log('📦 Restaurando tokens de Google desde Supabase...');
      fs.writeFileSync(TOKENS_FILE, data.concepto);
      console.log('✅ Tokens de Google restaurados en el disco local.');
    } else {
      console.log('ℹ️ No se encontraron tokens de Google en Supabase.');
    }
  } catch (err) {
    console.error('❌ Error al restaurar tokens de Google desde Supabase:', err.message);
  }
}

module.exports = {
  router,
  getAuthorizedClient,
  getGoogle,
  restoreTokensFromDatabase
};

