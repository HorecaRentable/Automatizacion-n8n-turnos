-- ============================================================
-- 0001 · TABLAS (Fases 1-3 ya contempladas)
-- ============================================================
-- Convenciones:
--   * Todas las horas absolutas son timestamptz (se guardan en UTC).
--   * Los horarios semanales son "hora local" (tipo time) y se interpretan
--     en la zona horaria de la tabla settings (por defecto Europe/Madrid).
--   * Pensado para editarse a mano desde el panel de Supabase:
--     nombres claros, restricciones y valores por defecto.
-- ============================================================

set local search_path = public, extensions;

create schema if not exists extensions;
create extension if not exists pgcrypto  with schema extensions;  -- gen_random_bytes
create extension if not exists btree_gist with schema extensions; -- exclusión por rangos

-- ------------------------------------------------------------
-- settings · parámetros globales (nada hardcodeado en n8n)
-- ------------------------------------------------------------
create table public.settings (
  key         text primary key,
  value       text not null,
  description text
);
comment on table public.settings is 'Parámetros globales clave/valor. Editable desde el panel.';

insert into public.settings (key, value, description) values
  ('timezone',        'Europe/Madrid',            'Zona horaria en la que se interpretan los horarios y se muestran las horas.'),
  ('admin_email',     'admin@example.com',        'Correo del administrador: recibe avisos de errores y de correos fallidos.'),
  ('cancel_form_url', 'https://TU-N8N/form/cancelar-turno', 'URL pública del formulario de cancelación (workflow 02). El enlace del correo añade ?codigo=...');

-- ------------------------------------------------------------
-- services · qué se puede reservar
-- ------------------------------------------------------------
create table public.services (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null unique check (btrim(name) <> ''),
  description          text,
  duration_minutes     int  not null check (duration_minutes > 0),
  break_minutes        int  not null default 0  check (break_minutes >= 0),
  min_notice_hours     int  not null default 2  check (min_notice_hours >= 0),   -- X
  booking_window_days  int  not null default 30 check (booking_window_days > 0), -- Y
  cancel_notice_hours  int  check (cancel_notice_hours >= 0),                    -- NULL = usar X
  slot_step_minutes    int  check (slot_step_minutes > 0),                       -- NULL = duración
  active               boolean not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
comment on column public.services.break_minutes       is 'Descanso tras cada turno; ese tiempo también queda bloqueado.';
comment on column public.services.min_notice_hours    is 'X: antelación mínima para reservar (horas).';
comment on column public.services.booking_window_days is 'Y: días vista; se puede reservar hasta hoy+Y (día local) inclusive.';
comment on column public.services.cancel_notice_hours is 'Plazo mínimo para cancelar (horas). NULL = igual que la antelación mínima X.';
comment on column public.services.slot_step_minutes   is 'Separación entre horas ofrecidas. NULL = igual a la duración.';

-- ------------------------------------------------------------
-- weekly_schedule · horario semanal por servicio (hora local)
-- Una fila por servicio y día. Un día sin fila = cerrado.
-- ------------------------------------------------------------
create table public.weekly_schedule (
  id               uuid primary key default gen_random_uuid(),
  service_id       uuid not null references public.services(id) on delete cascade,
  weekday          smallint not null check (weekday between 1 and 7),
  morning_start    time,
  morning_end      time,
  afternoon_start  time,
  afternoon_end    time,
  created_at       timestamptz not null default now(),
  constraint weekly_schedule_one_row_per_day unique (service_id, weekday),
  constraint morning_pair_complete   check ((morning_start   is null) = (morning_end   is null)),
  constraint afternoon_pair_complete check ((afternoon_start is null) = (afternoon_end is null)),
  constraint morning_order           check (morning_start   < morning_end),
  constraint afternoon_order         check (afternoon_start < afternoon_end),
  constraint morning_before_afternoon check (morning_end <= afternoon_start),
  constraint at_least_one_band       check (morning_start is not null or afternoon_start is not null)
);
comment on table  public.weekly_schedule         is 'Horario semanal en HORA LOCAL (settings.timezone). Sin fila = cerrado ese día.';
comment on column public.weekly_schedule.weekday is 'ISO: 1 = lunes ... 7 = domingo.';

-- ------------------------------------------------------------
-- blocks · cierres puntuales (vacaciones, festivos, reuniones...)
-- ------------------------------------------------------------
create table public.blocks (
  id          uuid primary key default gen_random_uuid(),
  service_id  uuid references public.services(id) on delete cascade, -- NULL = afecta a todos los servicios
  starts_at   timestamptz not null,
  ends_at     timestamptz not null,
  reason      text,
  created_at  timestamptz not null default now(),
  constraint blocks_valid_range check (ends_at > starts_at)
);
comment on column public.blocks.service_id is 'NULL = bloqueo global (todos los servicios).';
create index blocks_service_range_idx on public.blocks (service_id, starts_at, ends_at);

-- ------------------------------------------------------------
-- bookings · los turnos
-- ------------------------------------------------------------
create table public.bookings (
  id                   uuid primary key default gen_random_uuid(),
  service_id           uuid not null references public.services(id) on delete restrict,
  customer_name        text not null check (btrim(customer_name) <> ''),
  customer_email       text not null,
  customer_phone       text not null,
  starts_at            timestamptz not null,
  ends_at              timestamptz not null,
  occupied_until       timestamptz not null,  -- ends_at + descanso (lo rellena un trigger)
  status               text not null default 'confirmed'
                         check (status in ('confirmed', 'cancelled', 'attended', 'no_show')),
  management_code      text not null unique
                         default encode(extensions.gen_random_bytes(32), 'hex'),  -- 256 bits
  source               text,                  -- Fase 3: de qué enlace corto vino
  reminder_24h_sent_at timestamptz,           -- Fase 2
  reminder_1h_sent_at  timestamptz,           -- Fase 2
  consent_given        boolean not null default false,
  consent_at           timestamptz not null default now(),
  cancelled_at         timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint bookings_valid_range      check (ends_at > starts_at),
  constraint bookings_valid_occupied   check (occupied_until >= ends_at),
  constraint bookings_email_normalized check (customer_email = lower(btrim(customer_email))),
  constraint bookings_email_format     check (customer_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]{2,}$'),
  constraint bookings_phone_format     check (customer_phone ~ '^\+?[0-9][0-9 ().-]{5,24}$'),
  constraint bookings_consent_required check (consent_given),
  constraint bookings_code_strength    check (management_code ~ '^[0-9a-f]{32,}$'),  -- >= 128 bits

  -- REGLA ANTI-SOLAPES (la garantiza Postgres, no n8n):
  -- para un mismo servicio no pueden coexistir dos turnos no cancelados cuyo
  -- rango [inicio, fin + descanso) se pise.
  constraint bookings_no_overlap exclude using gist (
    service_id with =,
    tstzrange(starts_at, occupied_until, '[)') with &&
  ) where (status <> 'cancelled')
);
comment on column public.bookings.starts_at       is 'UTC. Se muestra en settings.timezone.';
comment on column public.bookings.occupied_until  is 'Fin real de ocupación = ends_at + descanso del servicio. Lo calcula un trigger; no hace falta rellenarlo.';
comment on column public.bookings.management_code is 'Secreto de 256 bits que va en el enlace del correo. No compartir.';
comment on column public.bookings.source          is 'Fase 3: origen (enlace corto/campaña). NULL si reserva directa.';

create index bookings_service_start_idx   on public.bookings (service_id, starts_at);
create index bookings_email_idx           on public.bookings (customer_email, service_id) where status = 'confirmed';
create index bookings_reminders_idx       on public.bookings (starts_at) where status = 'confirmed';

-- ------------------------------------------------------------
-- email_log · registro de correos (si el envío falla, la reserva NO se pierde)
-- ------------------------------------------------------------
create table public.email_log (
  id          bigint generated always as identity primary key,
  booking_id  uuid references public.bookings(id) on delete set null,
  kind        text not null,  -- confirmation | cancellation | admin_alert | reminder_24h ...
  to_email    text not null,
  status      text not null check (status in ('sent', 'failed')),
  error       text,
  created_at  timestamptz not null default now()
);
create index email_log_failed_idx on public.email_log (created_at) where status = 'failed';
