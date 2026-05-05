-- ================================================================
-- TABLAS PARA EL PORTAL DE SEGUIMIENTO TAKATA
-- Ejecutar en el SQL Editor de tu proyecto Supabase
-- ================================================================

-- 1. Ediciones a la base matriz (contacto, cita, observación)
CREATE TABLE IF NOT EXISTS takata_edits (
  vin TEXT PRIMARY KEY,
  contactado TEXT DEFAULT 'NO CONTACTADO',
  cita TEXT DEFAULT '',
  observacion TEXT DEFAULT '',
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 2. Ediciones a VINs en Proceso (estado, acciones, agente, comentario, fechas)
CREATE TABLE IF NOT EXISTS takata_proceso_edits (
  vin TEXT PRIMARY KEY,
  cliente TEXT DEFAULT '',
  proceso TEXT DEFAULT '',
  cita TEXT DEFAULT '',
  actualizacion TEXT DEFAULT '',
  unidad TEXT DEFAULT '',
  acciones TEXT DEFAULT '',
  agente TEXT DEFAULT '',
  comentario TEXT DEFAULT '',
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 3. VINs registrados manualmente (no vienen del JSON base)
CREATE TABLE IF NOT EXISTS takata_custom_vins (
  vin TEXT PRIMARY KEY,
  descripcion TEXT DEFAULT '',
  modelo TEXT DEFAULT '',
  cliente TEXT DEFAULT '',
  direccion TEXT DEFAULT '',
  colonia TEXT DEFAULT '',
  ciudad TEXT DEFAULT '',
  estado TEXT DEFAULT '',
  cp TEXT DEFAULT '',
  email TEXT DEFAULT '',
  telcel TEXT DEFAULT '',
  telcasa TEXT DEFAULT '',
  contactado TEXT DEFAULT 'NO CONTACTADO',
  cita TEXT DEFAULT '',
  observacion TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 4. Ediciones a los reclamos por campaña (tabla de KPIs)
CREATE TABLE IF NOT EXISTS takata_camp_edits (
  id TEXT PRIMARY KEY, -- formato: "Enero|Matriz|23TA15"
  mes TEXT NOT NULL,
  dealer TEXT NOT NULL,
  camp TEXT NOT NULL,
  valor INTEGER DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Índices para búsqueda rápida
CREATE INDEX IF NOT EXISTS idx_takata_edits_vin ON takata_edits(vin);
CREATE INDEX IF NOT EXISTS idx_takata_proceso_vin ON takata_proceso_edits(vin);
CREATE INDEX IF NOT EXISTS idx_takata_camp_mes ON takata_camp_edits(mes);
