-- ============================================================
-- FASE 1: tablas base del sistema de turnos
-- Ejecutar esto en Supabase: panel izquierdo -> SQL Editor -> Run
-- ============================================================

-- Necesitamos esta extensión para poder usar la restricción
-- "no se pueden solapar dos turnos" más abajo.
create extension if not exists btree_gist;

-- ------------------------------------------------------------
-- 1) SERVICIOS
-- Cada fila es un tipo de servicio que se puede reservar
-- (ej: "Corte de pelo", "Consulta general"...)
-- ------------------------------------------------------------
create table servicios (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  duracion_minutos int not null,              -- cuánto dura el turno
  descanso_minutos int not null default 0,     -- hueco libre entre un turno y el siguiente
  antelacion_minima_horas int not null default 1,  -- no se puede reservar con menos de X horas de margen
  dias_vista int not null default 30,          -- hasta cuántos días por delante se puede reservar
  activo boolean not null default true,
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 2) HORARIOS
-- El horario semanal de cada servicio. Puede haber varias filas
-- para el mismo día (una para la mañana, otra para la tarde).
-- dia_semana: 0 = domingo, 1 = lunes, 2 = martes ... 6 = sábado
-- ------------------------------------------------------------
create table horarios (
  id uuid primary key default gen_random_uuid(),
  servicio_id uuid not null references servicios(id) on delete cascade,
  dia_semana smallint not null check (dia_semana between 0 and 6),
  hora_inicio time not null,
  hora_fin time not null,
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 3) TURNOS
-- Las reservas. Incluye ya columnas que usaremos en fases
-- posteriores (origen, recordatorios) para no tener que
-- rehacer la tabla más adelante.
-- ------------------------------------------------------------
create table turnos (
  id uuid primary key default gen_random_uuid(),
  servicio_id uuid not null references servicios(id),
  fecha_hora_inicio timestamptz not null,
  fecha_hora_fin timestamptz not null,
  nombre_cliente text not null,
  email_cliente text not null,
  telefono_cliente text,
  estado text not null default 'confirmado'
    check (estado in ('confirmado', 'cancelado', 'asistio', 'no_asistio')),
  codigo_gestion text not null unique,   -- código secreto para cancelar/cambiar el turno
  origen text,                            -- de qué enlace corto vino (fase 3, de momento vacío)
  recordatorio_24h_enviado boolean not null default false,  -- (fase 2)
  recordatorio_1h_enviado boolean not null default false,   -- (fase 2)
  created_at timestamptz not null default now(),

  -- Esta es LA regla anti-duplicados: para el mismo servicio,
  -- no puede haber dos turnos "confirmado" cuyos rangos de
  -- tiempo se solapen. Si lo intentan, Postgres lo rechaza solo.
  constraint no_solapamiento
    exclude using gist (
      servicio_id with =,
      tsrange(fecha_hora_inicio, fecha_hora_fin) with &&
    ) where (estado = 'confirmado')
);

-- ------------------------------------------------------------
-- SEGURIDAD: nadie puede leer ni escribir estas tablas
-- directamente desde fuera. Solo n8n podrá, usando una
-- clave especial (service role) que nunca se expone al público.
-- ------------------------------------------------------------
alter table servicios enable row level security;
alter table horarios enable row level security;
alter table turnos enable row level security;
