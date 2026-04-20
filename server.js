const fs = require('fs');
require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = 3001; // Regresamos al puerto estándar

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Servir archivos estáticos de forma estándar (ahora que estamos en un disco rápido)
app.use(express.static(path.join(__dirname, 'public')));

// ── Rutas ─────────────────────────────────────────────────
app.use('/api/sat',     require('./routes/sat'));
app.use('/api/drive',   require('./routes/drive').router);
app.use('/api/sheets',  require('./routes/sheets'));
app.use('/api/autotec', require('./routes/autotec-buzon'));
app.use('/api/portal',  require('./routes/autotec-portal'));
app.use('/api/mail',    require('./routes/mail'));
app.use('/api/gastos',  require('./routes/gastos'));

// ── Fallback para el Frontend ──────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ PROYECTO ESTABILIZADO Y LISTO`);
  console.log(`🚀 Servidor corriendo en: http://localhost:${PORT}`);
  console.log(`📂 Nueva ubicación local: ${__dirname}\n`);
});
