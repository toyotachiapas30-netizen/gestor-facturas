const http = require('http');
const https = require('https');
http.globalAgent.keepAlive = false;
https.globalAgent.keepAlive = false;

const fs = require('fs');
require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3001; 

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Ruta de diagnóstico para verificar que el servidor responde
app.get('/debug-servidor', (req, res) => {
  res.json({ status: 'OK', puerto: PORT, folder: __dirname });
});
app.get('/ping', (req, res) => {
  res.send('pong');
});

// Servir archivos estáticos de forma estándar
app.use(express.static(path.join(__dirname, 'public')));

// ── Token de sesión para Takata ──
const TAKATA_SESSION_TOKEN = 'takata_2026_toyota_secure_session';
const TAKATA_READONLY_TOKEN = 'takata_readonly_session_token';

function getTakataToken(req) {
  const cookies = req.headers.cookie || '';
  const found = cookies.split(';').map(c => c.trim()).find(c => c.startsWith('takata_session='));
  return found ? decodeURIComponent(found.split('=')[1]) : null;
}

function takataAuth(req, res, next) {
  if (req.path === '/login.html' || req.path === '/login') {
    return next();
  }

  const token = getTakataToken(req);
  if (token === TAKATA_SESSION_TOKEN || token === TAKATA_READONLY_TOKEN) {
    return next();
  }

  if (req.path.endsWith('.json') || req.headers['accept']?.includes('application/json')) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  
  res.redirect('/takata/login.html');
}

app.post('/takata/login', (req, res) => {
  const { usuario, clave } = req.body || {};
  if (usuario === 'takata' && clave === 'toyota2026') {
    res.setHeader('Set-Cookie', [
      `takata_session=${TAKATA_SESSION_TOKEN}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800`,
      `takata_role=admin; Path=/; SameSite=Strict; Max-Age=604800`
    ]);
    res.json({ ok: true, role: 'admin' });
  } else if (usuario === 'visor' && clave === 'toyota2026') {
    res.setHeader('Set-Cookie', [
      `takata_session=${TAKATA_READONLY_TOKEN}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800`,
      `takata_role=readonly; Path=/; SameSite=Strict; Max-Age=604800`
    ]);
    res.json({ ok: true, role: 'readonly' });
  } else {
    res.status(401).json({ error: 'Credenciales inválidas' });
  }
});

app.use('/takata', takataAuth, express.static(path.join(__dirname, 'seguimiento-takata')));

function takataApiAuth(req, res, next) {
  const token = getTakataToken(req);
  if (!token || (token !== TAKATA_SESSION_TOKEN && token !== TAKATA_READONLY_TOKEN)) {
    return res.status(401).json({ error: 'No autorizado. Inicia sesión en /takata/' });
  }
  
  // Bloquear métodos de escritura si es visor
  if (token === TAKATA_READONLY_TOKEN && req.method !== 'GET') {
    return res.status(403).json({ error: 'Usuario de solo lectura. No tienes permisos para modificar.' });
  }
  
  return next();
}

// ── Rutas ─────────────────────────────────────────────────
app.use('/api/sat',     require('./routes/sat'));
app.use('/api/drive',   require('./routes/drive').router);
app.use('/api/sheets',  require('./routes/sheets'));
app.use('/api/autotec', require('./routes/autotec-buzon'));
app.use('/api/portal',  require('./routes/autotec-portal'));
app.use('/api/mail',    require('./routes/mail'));
app.use('/api/gastos',  require('./routes/gastos').router);
app.use('/api/takata',  takataApiAuth, require('./routes/takata')); // ← Protegida

// ── Fallback para el Frontend ──────────────────────────────
app.get('*', (req, res) => {
  const index = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(index)) {
    res.sendFile(index);
  } else {
    res.status(404).send('Frontend no encontrado en el servidor.');
  }
});

async function startServer() {
  // 1. Restaurar base de datos SQLite desde Google Drive
  try {
    const { restoreDatabaseFromDrive } = require('./routes/gastos');
    await restoreDatabaseFromDrive();
  } catch (err) {
    console.error('⚠️ Error al restaurar base de datos desde Google Drive:', err.message);
  }

  app.listen(PORT, '0.0.0.0', async () => {
    console.log(`\n✅ SERVIDOR ACTUALIZADO`);
    console.log(`🚀 Corriendo en puerto: ${PORT}`);

    // 2. Restaurar tokens de Google desde la base de datos en el arranque del servidor
    try {
      const { restoreTokensFromDatabase } = require('./routes/drive');
      await restoreTokensFromDatabase();
    } catch (err) {
      console.error('⚠️ Error al iniciar restauración de tokens:', err.message);
    }
  });
}

startServer();
