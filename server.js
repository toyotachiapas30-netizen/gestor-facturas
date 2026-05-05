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

// Servir archivos estáticos de forma estándar
app.use(express.static(path.join(__dirname, 'public')));

// ── Token de sesión para Takata ──
const TAKATA_SESSION_TOKEN = 'takata_2026_toyota_secure_session';

function getCookie(req, name) {
  const cookies = req.headers.cookie || '';
  const found = cookies.split(';').map(c => c.trim()).find(c => c.startsWith(name + '='));
  return found ? decodeURIComponent(found.substring(name.length + 1)) : null;
}

function takataAuth(req, res, next) {
  // Permitir la página de login y el endpoint de login sin autenticación
  if (req.path === '/login.html' || req.path === '/login') return next();

  const token = getCookie(req, 'takata_session');
  if (token === TAKATA_SESSION_TOKEN) return next();

  // No autenticado: redirigir a login
  res.redirect('/takata/login.html');
}

// Endpoint de login para Takata (debe ir ANTES del middleware estático)
app.post('/takata/login', (req, res) => {
  const { usuario, clave } = req.body || {};
  if (usuario === 'takata' && clave === 'toyota2026') {
    res.setHeader('Set-Cookie', `takata_session=${TAKATA_SESSION_TOKEN}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800`);
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  }
});

app.use('/takata', takataAuth, express.static(path.join(__dirname, 'seguimiento-takata'), { redirect: true }));

// ── Rutas ─────────────────────────────────────────────────
app.use('/api/sat',     require('./routes/sat'));
app.use('/api/drive',   require('./routes/drive').router);
app.use('/api/sheets',  require('./routes/sheets'));
app.use('/api/autotec', require('./routes/autotec-buzon'));
app.use('/api/portal',  require('./routes/autotec-portal'));
app.use('/api/mail',    require('./routes/mail'));
app.use('/api/gastos',  require('./routes/gastos'));
app.use('/api/takata',  require('./routes/takata'));

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
