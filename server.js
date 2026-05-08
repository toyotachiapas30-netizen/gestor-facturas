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

function getTakataToken(req) {
  const cookies = req.headers.cookie || '';
  const found = cookies.split(';').map(c => c.trim()).find(c => c.startsWith('takata_session='));
  return found ? decodeURIComponent(found.split('=')[1]) : null;
}

function takataAuth(req, res, next) {
  // 1. Permitir siempre la página de login y el endpoint de login
  // req.path aquí es relativo a /takata si se usa en app.use('/takata', ...)
  if (req.path === '/login.html' || req.path === '/login') {
    return next();
  }

  // 2. Verificar token
  const token = getTakataToken(req);
  if (token === TAKATA_SESSION_TOKEN) {
    return next();
  }

  // 3. No autenticado: si es una petición de API o JSON, devolver 401. Si es navegación, redirigir a login.
  if (req.path.endsWith('.json') || req.headers['accept']?.includes('application/json')) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  
  res.redirect('/takata/login.html');
}

// Endpoint de login para Takata
app.post('/takata/login', (req, res) => {
  const { usuario, clave } = req.body || {};
  // Usuario: takata / Clave: toyota2026
  if (usuario === 'takata' && clave === 'toyota2026') {
    res.setHeader('Set-Cookie', `takata_session=${TAKATA_SESSION_TOKEN}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800`);
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: 'Credenciales inválidas' });
  }
});

// Servir la carpeta Takata protegida (páginas HTML/JS/CSS)
app.use('/takata', takataAuth, express.static(path.join(__dirname, 'seguimiento-takata')));

// ── Auth para rutas API de Takata (siempre devuelve 401 JSON, no redirige) ──
function takataApiAuth(req, res, next) {
  const token = getTakataToken(req);
  if (token === TAKATA_SESSION_TOKEN) return next();
  return res.status(401).json({ error: 'No autorizado. Inicia sesión en /takata/' });
}

// ── Rutas ─────────────────────────────────────────────────
app.use('/api/sat',     require('./routes/sat'));
app.use('/api/drive',   require('./routes/drive').router);
app.use('/api/sheets',  require('./routes/sheets'));
app.use('/api/autotec', require('./routes/autotec-buzon'));
app.use('/api/portal',  require('./routes/autotec-portal'));
app.use('/api/mail',    require('./routes/mail'));
app.use('/api/gastos',  require('./routes/gastos'));
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ SERVIDOR ACTUALIZADO`);
  console.log(`🚀 Corriendo en puerto: ${PORT}`);
});
