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

// ── Token de sesión para Gestor ──
const GESTOR_SESSION_TOKEN = 'gestor_2026_toyota_secure_session';

function getGestorToken(req) {
  const cookies = req.headers.cookie || '';
  const found = cookies.split(';').map(c => c.trim()).find(c => c.startsWith('gestor_session='));
  return found ? decodeURIComponent(found.split('=')[1]) : null;
}

function gestorAuth(req, res, next) {
  const p = req.path;
  
  // Si la ruta es para Takata, permitir continuar (Takata tiene su propio login)
  if (p.startsWith('/takata')) {
    return next();
  }
  
  // Recursos permitidos sin iniciar sesión
  const allowed = [
    '/login.html', 
    '/styles.css', 
    '/hero_bg.jpg', 
    '/toyota-chiapas.png', 
    '/farrera-poniente.png', 
    '/api/auth/login'
  ];
  
  if (allowed.includes(p) || p === '/login') {
    return next();
  }
  
  const token = getGestorToken(req);
  if (token === GESTOR_SESSION_TOKEN) {
    return next();
  }
  
  if (p.startsWith('/api/') || req.headers['accept']?.includes('application/json')) {
    return res.status(401).json({ error: 'No autorizado. Inicia sesión.' });
  }
  
  res.redirect('/login.html');
}

// Aplicar middleware de autenticación antes de servir archivos estáticos
app.use(gestorAuth);

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

// ── Rutas de Autenticación del Gestor ────────────────────────
app.post('/api/auth/login', (req, res) => {
  const { usuario, clave } = req.body || {};
  const lowerUser = (usuario || '').trim().toLowerCase();
  
  if (clave === 'toyota2026' && (lowerUser === 'admin' || lowerUser === 'oriente' || lowerUser === 'poniente')) {
    res.setHeader('Set-Cookie', [
      `gestor_session=${GESTOR_SESSION_TOKEN}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800`,
      `gestor_role=${lowerUser}; Path=/; SameSite=Strict; Max-Age=604800`
    ]);
    res.json({ ok: true, role: lowerUser });
  } else {
    res.status(401).json({ ok: false, error: 'Usuario o contraseña incorrectos.' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', [
    'gestor_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0',
    'gestor_role=; Path=/; SameSite=Strict; Max-Age=0'
  ]);
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const token = getGestorToken(req);
  if (token !== GESTOR_SESSION_TOKEN) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  
  const cookies = req.headers.cookie || '';
  const foundRole = cookies.split(';').map(c => c.trim()).find(c => c.startsWith('gestor_role='));
  const role = foundRole ? decodeURIComponent(foundRole.split('=')[1]) : 'guest';
  
  res.json({ ok: true, role });
});

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

// ── Manejadores de Apagado Seguro (Graceful Shutdown) ──────
async function handleShutdown(signal) {
  console.log(`\n🛑 Servidor recibiendo señal ${signal}. Guardando respaldo final en Google Drive...`);
  try {
    const { backupDatabaseToDrive } = require('./routes/gastos');
    await backupDatabaseToDrive();
    console.log('✅ Respaldo final completado.');
  } catch (e) {
    console.error('⚠️ Error en respaldo final:', e.message);
  }
  process.exit(0);
}

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));
