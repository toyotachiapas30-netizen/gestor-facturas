-- Crea la tabla de gastos en Supabase (Editor SQL)
CREATE TABLE IF NOT EXISTS gastos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  uuid TEXT, -- SAT UUID (Folio Fiscal)
  proveedor TEXT NOT NULL,
  folio TEXT,
  fecha_factura DATE,
  monto NUMERIC(15, 2) DEFAULT 0,
  concepto TEXT,
  fecha_solicitud DATE,
  estatus TEXT DEFAULT 'en_proceso',
  categoria TEXT DEFAULT 'OTROS',
  mes TEXT, -- Formato YYYY-MM
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Indices para búsqueda rápida
CREATE INDEX idx_gastos_uuid ON gastos(uuid);
CREATE INDEX idx_gastos_mes ON gastos(mes);
CREATE INDEX idx_gastos_estatus ON gastos(estatus);
