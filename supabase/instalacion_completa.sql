-- ============================================================
-- INSTALACIÓN COMPLETA · todas las migraciones juntas, en orden
-- (12 archivos: 20261020000001_tablas.sql … 20261022000004_fase3_seguridad.sql)
--
-- Pégalo ENTERO en Supabase → SQL Editor y pulsa Run, UNA sola vez, en un proyecto NUEVO.
-- Después ejecuta supabase/seed.sql (datos de ejemplo) cambiando antes admin_email.
-- Si un bloque falla, ese bloque se deshace y el script se detiene: corrige y vuelve a empezar
-- desde un proyecto limpio (o ejecuta solo los bloques que faltan).
-- Generado con: node supabase/generar-instalacion-completa.mjs
-- ============================================================


-- ############################################################
-- ## 20261020000001_tablas.sql
-- ############################################################
begin;
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
commit;


-- ############################################################
-- ## 20261020000002_triggers.sql
-- ############################################################
begin;
-- ============================================================
-- 0002 · TRIGGERS
-- Mantienen coherentes los datos aunque se editen a mano desde el panel.
-- ============================================================

set local search_path = public, extensions;

-- updated_at automático ---------------------------------------
create function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger services_touch_updated_at
  before update on public.services
  for each row execute function public.touch_updated_at();

-- bookings: normaliza datos, calcula fin/ocupación y marca cancelaciones --
create function public.bookings_prepare()
returns trigger
language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare
  v_svc public.services%rowtype;
begin
  new.customer_email := lower(btrim(new.customer_email));
  new.customer_name  := btrim(new.customer_name);
  new.customer_phone := btrim(new.customer_phone);
  new.updated_at     := now();

  select * into v_svc from public.services where id = new.service_id;
  if found then
    -- Alta a mano desde el panel: basta con inicio; el fin sale de la duración.
    if new.ends_at is null and new.starts_at is not null then
      new.ends_at := new.starts_at + make_interval(mins => v_svc.duration_minutes);
    end if;
    -- El descanso del servicio queda "pegado" al turno.
    if new.occupied_until is null
       or (tg_op = 'UPDATE' and (new.ends_at is distinct from old.ends_at
                                 or new.service_id is distinct from old.service_id)) then
      new.occupied_until := new.ends_at + make_interval(mins => v_svc.break_minutes);
    end if;
  end if;

  if new.status = 'cancelled' then
    new.cancelled_at := coalesce(new.cancelled_at, now());
  else
    new.cancelled_at := null;
  end if;

  return new;
end;
$$;

create trigger bookings_prepare_trg
  before insert or update on public.bookings
  for each row execute function public.bookings_prepare();
commit;


-- ############################################################
-- ## 20261020000003_funciones.sql
-- ############################################################
begin;
-- ============================================================
-- 0003 · FUNCIONES (toda la lógica de negocio vive aquí; n8n solo las llama)
-- ============================================================
--  Públicas (solo service_role, ver migración 0004), vía POST /rest/v1/rpc/<nombre>:
--    list_active_services()                   -> jsonb  (desplegable de servicios)
--    get_availability(service, day)           -> jsonb  (horas libres + próximos días)
--    get_available_slots(service, day)        -> tabla  (horas libres)
--    get_next_available_days(service, ...)    -> tabla  (próximos días con huecos)
--    book_slot(...)                           -> jsonb  (reserva transaccional)
--    cancel_booking(code)                     -> jsonb  (cancelación transaccional)
--    log_email(...), get_config()
--  Internas (sin permisos para nadie salvo el propietario; permiten fijar "now"
--  en las pruebas): _available_slots, _next_available_days, _get_availability,
--  _book_slot, _cancel_booking.
-- ============================================================

set local search_path = public, extensions;

-- ------------------------------------------------------------
-- Utilidades
-- ------------------------------------------------------------
create function public.app_timezone()
returns text
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce((select value from public.settings where key = 'timezone'), 'Europe/Madrid');
$$;

create function public.iso_utc(p_ts timestamptz)
returns text
language sql
immutable
as $$
  select to_char(p_ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
$$;

-- Configuración que necesitan los workflows de n8n (nada hardcodeado en los nodos)
create function public.get_config()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'timezone',        coalesce((select value from public.settings where key = 'timezone'), 'Europe/Madrid'),
    'admin_email',     (select value from public.settings where key = 'admin_email'),
    'cancel_form_url', (select value from public.settings where key = 'cancel_form_url'));
$$;

-- ------------------------------------------------------------
-- _available_slots · EL cálculo de disponibilidad (núcleo)
--   horario semanal (hora local -> UTC)
--   - antelación mínima X   - días vista Y
--   - bloqueos (del servicio y globales)
--   - turnos existentes + su descanso
-- Los huecos se generan en tiempo real (UTC), así que en un cambio de hora
-- una franja que cruza las 02:00/03:00 tiene la duración real correcta.
-- ------------------------------------------------------------
create function public._available_slots(p_service_id uuid, p_day date, p_now timestamptz)
returns table (slot_start timestamptz, slot_end timestamptz)
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  with cfg as (
    select s.id,
           s.duration_minutes,
           s.break_minutes,
           s.min_notice_hours,
           s.booking_window_days,
           coalesce(s.slot_step_minutes, s.duration_minutes) as step_minutes,
           app_timezone() as tz
    from public.services s
    where s.id = p_service_id and s.active
  ),
  bands as (
    select c.*,
           (p_day + b.t_start) at time zone c.tz as band_start,
           (p_day + b.t_end)   at time zone c.tz as band_end
    from cfg c
    join public.weekly_schedule w
      on w.service_id = c.id
     and w.weekday = extract(isodow from p_day)::int
    cross join lateral (values (w.morning_start,   w.morning_end),
                               (w.afternoon_start, w.afternoon_end)) as b(t_start, t_end)
    where b.t_start is not null
      and p_day >= (p_now at time zone c.tz)::date
      and p_day <= (p_now at time zone c.tz)::date + c.booking_window_days
  ),
  cand as (
    select b.*, g.s as s_start
    from bands b
    cross join lateral generate_series(
           b.band_start,
           b.band_end - make_interval(mins => b.duration_minutes),
           make_interval(mins => b.step_minutes)) as g(s)
  )
  select cand.s_start,
         cand.s_start + make_interval(mins => cand.duration_minutes)
  from cand
  where cand.s_start >= p_now + make_interval(hours => cand.min_notice_hours)
    and not exists (            -- turnos existentes (con su descanso)
      select 1 from public.bookings k
      where k.service_id = cand.id
        and k.status <> 'cancelled'
        and tstzrange(k.starts_at, k.occupied_until, '[)')
            && tstzrange(cand.s_start,
                         cand.s_start + make_interval(mins => cand.duration_minutes + cand.break_minutes), '[)'))
    and not exists (            -- bloqueos del servicio o globales
      select 1 from public.blocks bl
      where (bl.service_id is null or bl.service_id = cand.id)
        and tstzrange(bl.starts_at, bl.ends_at, '[)')
            && tstzrange(cand.s_start,
                         cand.s_start + make_interval(mins => cand.duration_minutes), '[)'))
  order by cand.s_start;
$$;

create function public.get_available_slots(p_service_id uuid, p_day date)
returns table (slot_start timestamptz, slot_end timestamptz, local_date date, local_time text)
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  select s.slot_start,
         s.slot_end,
         (s.slot_start at time zone app_timezone())::date,
         to_char(s.slot_start at time zone app_timezone(), 'HH24:MI')
  from public._available_slots(p_service_id, p_day, now()) s;
$$;

create function public._next_available_days(p_service_id uuid, p_from date, p_limit int, p_now timestamptz)
returns table (day date, free_slots int)
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  with cfg as (
    select s.booking_window_days as w,
           (p_now at time zone app_timezone())::date as today
    from public.services s
    where s.id = p_service_id and s.active
  ),
  days as (
    select c.today + g.i as d
    from cfg c
    cross join lateral generate_series(greatest(coalesce(p_from, c.today), c.today) - c.today, c.w) as g(i)
  )
  select days.d, count(*)::int
  from days
  cross join lateral public._available_slots(p_service_id, days.d, p_now) s
  group by days.d
  order by days.d
  limit p_limit;
$$;

create function public.get_next_available_days(p_service_id uuid, p_from date default null, p_limit int default 5)
returns table (day date, free_slots int)
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  select * from public._next_available_days(p_service_id, p_from, p_limit, now());
$$;

-- ------------------------------------------------------------
-- Formularios n8n: servicios activos y disponibilidad de un día
-- ------------------------------------------------------------
-- Devuelve un OBJETO {"services": [...]} (n8n separa los arrays en varios ítems, y con 0 servicios
-- el flujo se pararía).
create function public.list_active_services()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object('services', coalesce(jsonb_agg(jsonb_build_object(
           'id', id, 'name', name, 'description', description,
           'duration_minutes', duration_minutes) order by name), '[]'::jsonb))
  from public.services
  where active;
$$;

-- Devuelve las horas libres de p_day. Si no hay ninguna, propone los próximos
-- días con huecos (después de p_day).
create function public._get_availability(p_service_id uuid, p_day date, p_now timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_tz      text := app_timezone();
  v_slots   jsonb;
  v_next    jsonb := '[]'::jsonb;
begin
  -- 'label' es lo que ve la persona en el desplegable. Solo en la noche de un cambio de
  -- hora (octubre) una misma hora local ocurre dos veces: entonces se añade el desfase UTC
  -- para que las etiquetas sigan siendo únicas.
  select coalesce(jsonb_agg(jsonb_build_object(
           'starts_at', iso_utc(x.slot_start),
           'label',     case when x.dup > 1
                             then x.lbl || ' (UTC' || case when x.off_h >= 0 then '+' else '' end || x.off_h::text || ')'
                             else x.lbl end) order by x.slot_start), '[]'::jsonb)
    into v_slots
  from (
    select s.slot_start,
           to_char(s.slot_start at time zone v_tz, 'HH24:MI') as lbl,
           count(*) over (partition by to_char(s.slot_start at time zone v_tz, 'HH24:MI')) as dup,
           trim_scale(round(extract(epoch from (s.slot_start at time zone v_tz) - (s.slot_start at time zone 'UTC')) / 3600, 2)) as off_h
    from public._available_slots(p_service_id, p_day, p_now) s
  ) x;

  if jsonb_array_length(v_slots) = 0 then
    select coalesce(jsonb_agg(jsonb_build_object('day', d.day, 'free_slots', d.free_slots) order by d.day), '[]'::jsonb)
      into v_next
    from public._next_available_days(p_service_id, p_day + 1, 5, p_now) d;
  end if;

  return jsonb_build_object('day', p_day, 'timezone', v_tz, 'slots', v_slots, 'next_days', v_next);
end;
$$;

create function public.get_availability(p_service_id uuid, p_day date)
returns jsonb
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  select public._get_availability(p_service_id, p_day, now());
$$;

-- ------------------------------------------------------------
-- _book_slot / book_slot · reserva transaccional
-- Códigos de error (ok = false):
--   INVALID_INPUT (field) · CONSENT_REQUIRED · SERVICE_NOT_FOUND
--   ALREADY_HAS_BOOKING   · SLOT_TAKEN ("Ese turno acaba de ocuparse")
-- ------------------------------------------------------------
create function public._book_slot(
  p_service_id uuid, p_starts_at timestamptz,
  p_name text, p_email text, p_phone text, p_consent boolean, p_source text,
  p_now timestamptz)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_svc     public.services%rowtype;
  v_email   text := lower(btrim(coalesce(p_email, '')));
  v_name    text := btrim(coalesce(p_name, ''));
  v_phone   text := btrim(coalesce(p_phone, ''));
  v_tz      text := app_timezone();
  v_booking public.bookings%rowtype;
begin
  -- 1) Validación de entradas
  if v_name = '' or length(v_name) > 120 then
    return jsonb_build_object('ok', false, 'error', 'INVALID_INPUT', 'field', 'name');
  end if;
  if length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]{2,}$' then
    return jsonb_build_object('ok', false, 'error', 'INVALID_INPUT', 'field', 'email');
  end if;
  if v_phone !~ '^\+?[0-9][0-9 ().-]{5,24}$'
     or length(regexp_replace(v_phone, '\D', '', 'g')) not between 7 and 15 then
    return jsonb_build_object('ok', false, 'error', 'INVALID_INPUT', 'field', 'phone');
  end if;
  if p_consent is not true then
    return jsonb_build_object('ok', false, 'error', 'CONSENT_REQUIRED');
  end if;
  if p_source is not null and length(p_source) > 100 then
    return jsonb_build_object('ok', false, 'error', 'INVALID_INPUT', 'field', 'source');
  end if;

  select * into v_svc from public.services where id = p_service_id and active;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'SERVICE_NOT_FOUND');
  end if;

  -- 2) Una persona (correo normalizado) = un turno futuro confirmado por servicio.
  --    Un índice único no puede usar now(), así que se serializa por (servicio, correo)
  --    con un bloqueo asesor de transacción y se comprueba dentro de la misma transacción.
  perform pg_advisory_xact_lock(hashtextextended(p_service_id::text || ':' || v_email, 0));

  if exists (select 1 from public.bookings b
             where b.service_id = p_service_id
               and b.customer_email = v_email
               and b.status = 'confirmed'
               and b.starts_at > p_now) then
    return jsonb_build_object('ok', false, 'error', 'ALREADY_HAS_BOOKING');
  end if;

  -- 3) Las reservas de un mismo servicio se hacen de una en una. Sin este bloqueo, dos INSERT
  --    simultáneos sobre una restricción de exclusión GiST pueden acabar en "deadlock detected"
  --    en vez de un rechazo limpio. Orden de bloqueos fijo (persona -> servicio): sin interbloqueos.
  --    La restricción bookings_no_overlap sigue siendo la garantía final.
  perform pg_advisory_xact_lock(hashtextextended('slot:' || p_service_id::text, 0));

  -- 4) La hora pedida debe ser una de las libres (horario, bloqueos, X, Y, descanso)
  if not exists (select 1
                 from public._available_slots(p_service_id, (p_starts_at at time zone v_tz)::date, p_now) s
                 where s.slot_start = p_starts_at) then
    return jsonb_build_object('ok', false, 'error', 'SLOT_TAKEN');
  end if;

  -- 5) Inserción. Si algo ajeno a esta función (p. ej. un alta a mano en el panel) ocupó el
  --    hueco a la vez, bookings_no_overlap lo impide aunque el paso 4 lo hubiera dejado pasar.
  begin
    insert into public.bookings
      (service_id, customer_name, customer_email, customer_phone,
       starts_at, ends_at, consent_given, consent_at, source)
    values
      (p_service_id, v_name, v_email, v_phone,
       p_starts_at, p_starts_at + make_interval(mins => v_svc.duration_minutes),
       true, now(), nullif(btrim(p_source), ''))
    returning * into v_booking;
  exception when exclusion_violation or deadlock_detected then
    return jsonb_build_object('ok', false, 'error', 'SLOT_TAKEN');
  end;

  return jsonb_build_object(
    'ok',              true,
    'booking_id',      v_booking.id,
    'management_code', v_booking.management_code,
    'service_name',    v_svc.name,
    'customer_name',   v_booking.customer_name,
    'customer_email',  v_booking.customer_email,
    'starts_at',       iso_utc(v_booking.starts_at),
    'ends_at',         iso_utc(v_booking.ends_at),
    'local_date',      (v_booking.starts_at at time zone v_tz)::date,
    'local_time',      to_char(v_booking.starts_at at time zone v_tz, 'HH24:MI'),
    'timezone',        v_tz);
end;
$$;

create function public.book_slot(
  p_service_id uuid, p_starts_at timestamptz,
  p_name text, p_email text, p_phone text, p_consent boolean,
  p_source text default null)
returns jsonb
language sql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
  select public._book_slot(p_service_id, p_starts_at, p_name, p_email, p_phone, p_consent, p_source, now());
$$;

-- ------------------------------------------------------------
-- _cancel_booking / cancel_booking · cancelación transaccional
-- Códigos de error (ok = false), sin datos del turno:
--   INVALID_CODE · NOT_CANCELLABLE (ya cancelado / pasado) · TOO_LATE (hours)
-- ------------------------------------------------------------
create function public._cancel_booking(p_code text, p_now timestamptz)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_code  text := lower(btrim(coalesce(p_code, '')));
  v_b     public.bookings%rowtype;
  v_svc   public.services%rowtype;
  v_hours int;
  v_tz    text := app_timezone();
begin
  if v_code !~ '^[0-9a-f]{32,}$' then
    return jsonb_build_object('ok', false, 'error', 'INVALID_CODE');
  end if;

  select * into v_b from public.bookings where management_code = v_code for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'INVALID_CODE');
  end if;

  if v_b.status <> 'confirmed' or v_b.starts_at <= p_now then
    return jsonb_build_object('ok', false, 'error', 'NOT_CANCELLABLE');
  end if;

  select * into v_svc from public.services where id = v_b.service_id;
  v_hours := coalesce(v_svc.cancel_notice_hours, v_svc.min_notice_hours);
  if v_b.starts_at < p_now + make_interval(hours => v_hours) then
    return jsonb_build_object('ok', false, 'error', 'TOO_LATE', 'hours', v_hours);
  end if;

  update public.bookings set status = 'cancelled' where id = v_b.id returning * into v_b;

  return jsonb_build_object(
    'ok',             true,
    'booking_id',     v_b.id,
    'service_name',   v_svc.name,
    'customer_name',  v_b.customer_name,
    'customer_email', v_b.customer_email,
    'starts_at',      iso_utc(v_b.starts_at),
    'ends_at',        iso_utc(v_b.ends_at),
    'local_date',     (v_b.starts_at at time zone v_tz)::date,
    'local_time',     to_char(v_b.starts_at at time zone v_tz, 'HH24:MI'),
    'timezone',       v_tz);
end;
$$;

create function public.cancel_booking(p_code text)
returns jsonb
language sql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
  select public._cancel_booking(p_code, now());
$$;

-- ------------------------------------------------------------
-- log_email · n8n registra aquí cada correo (enviado o fallido)
-- ------------------------------------------------------------
create function public.log_email(
  p_booking_id uuid, p_kind text, p_to text, p_status text, p_error text default null)
returns void
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  insert into public.email_log (booking_id, kind, to_email, status, error)
  values (p_booking_id, p_kind, p_to, p_status, left(p_error, 2000));
$$;
commit;


-- ############################################################
-- ## 20261020000004_seguridad.sql
-- ############################################################
begin;
-- ============================================================
-- 0004 · SEGURIDAD
--   * RLS activado en TODAS las tablas y SIN políticas: anon y authenticated
--     no pueden leer ni escribir nada.
--   * Además se les retiran los permisos de tabla y de ejecución de funciones.
--   * Solo service_role (la clave que guarda n8n en sus credenciales) puede
--     llamar a las funciones. service_role se salta RLS por diseño de Supabase.
-- ============================================================

set local search_path = public, extensions;

alter table public.settings        enable row level security;
alter table public.services        enable row level security;
alter table public.weekly_schedule enable row level security;
alter table public.blocks          enable row level security;
alter table public.bookings        enable row level security;
alter table public.email_log       enable row level security;

revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

grant all on all tables    in schema public to service_role;
grant all on all sequences in schema public to service_role;

-- Funciones futuras: nacen sin permiso para anon/authenticated.
alter default privileges in schema public revoke execute on functions from anon, authenticated;

-- Funciones: fuera para todos (incluido PUBLIC) y dentro solo service_role.
revoke execute on function
  public.app_timezone(),
  public.iso_utc(timestamptz),
  public.get_config(),
  public._available_slots(uuid, date, timestamptz),
  public.get_available_slots(uuid, date),
  public._next_available_days(uuid, date, int, timestamptz),
  public.get_next_available_days(uuid, date, int),
  public.list_active_services(),
  public._get_availability(uuid, date, timestamptz),
  public.get_availability(uuid, date),
  public._book_slot(uuid, timestamptz, text, text, text, boolean, text, timestamptz),
  public.book_slot(uuid, timestamptz, text, text, text, boolean, text),
  public._cancel_booking(text, timestamptz),
  public.cancel_booking(text),
  public.log_email(uuid, text, text, text, text)
from public, anon, authenticated;

grant execute on function
  public.get_config(),
  public.get_available_slots(uuid, date),
  public.get_next_available_days(uuid, date, int),
  public.list_active_services(),
  public.get_availability(uuid, date),
  public.book_slot(uuid, timestamptz, text, text, text, boolean, text),
  public.cancel_booking(text),
  public.log_email(uuid, text, text, text, text)
to service_role;
-- (_available_slots, _book_slot, _cancel_booking, app_timezone e iso_utc quedan
--  sin grant: las usan las funciones públicas por ser SECURITY DEFINER.)
commit;


-- ############################################################
-- ## 20261021000001_fase2_tablas.sql
-- ############################################################
begin;
-- ============================================================
-- FASE 2 · 0001 · COLUMNAS, AJUSTES Y TABLA NUEVA
-- (Las migraciones de la Fase 1 no se tocan: todo lo nuevo va aquí.)
--   * services.reschedule_notice_hours   plazo mínimo para cambiar la hora
--   * bookings.ics_sequence              versión del evento .ics (sube en cada cambio/cancelación)
--   * bookings.rescheduled_at            cuándo se movió el turno (NULL = nunca)
--   * bookings.reminder_*_attempts       intentos de envío de cada recordatorio
--   * settings                           correo de quien atiende, hora del resumen, reintentos...
--   * daily_summary_log                  una fila por día: garantiza un solo resumen diario
-- ============================================================

set local search_path = public, extensions;

-- ------------------------------------------------------------
-- services · plazo mínimo para cambiar la hora
-- ------------------------------------------------------------
alter table public.services
  add column reschedule_notice_hours int check (reschedule_notice_hours >= 0);
comment on column public.services.reschedule_notice_hours is
  'Plazo mínimo para cambiar la hora de un turno (horas antes de su inicio actual). NULL = igual que el plazo de cancelación.';

-- ------------------------------------------------------------
-- bookings · versión del .ics, cambios e intentos de recordatorio
-- ------------------------------------------------------------
alter table public.bookings
  add column ics_sequence          int         not null default 0 check (ics_sequence >= 0),
  add column rescheduled_at        timestamptz,
  add column reminder_24h_attempts smallint    not null default 0 check (reminder_24h_attempts >= 0),
  add column reminder_1h_attempts  smallint    not null default 0 check (reminder_1h_attempts  >= 0);

comment on column public.bookings.ics_sequence is
  'SEQUENCE del evento .ics. 0 = reserva original; cada cambio de hora o la cancelación la incrementa, para que los calendarios sustituyan el evento.';
comment on column public.bookings.rescheduled_at is
  'Cuándo se cambió la hora por última vez (NULL = nunca). La antelación de los recordatorios se mide desde aquí si existe, y si no desde created_at.';
comment on column public.bookings.reminder_24h_sent_at is
  'Marca de RECLAMO del recordatorio de 24 h: se pone (atómicamente) justo antes de enviarlo. Si el envío falla se libera (NULL) para reintentarlo; ver claim_due_reminders().';
comment on column public.bookings.reminder_1h_sent_at is
  'Igual que reminder_24h_sent_at, para el recordatorio de 1 h.';

-- ------------------------------------------------------------
-- bookings_prepare · al cambiar la hora (por la RPC o a mano en el panel) los
-- recordatorios ya enviados dejan de valer: se rearman para la nueva hora.
-- (Es el cuerpo de la Fase 1 más el bloque marcado con FASE 2.)
-- ------------------------------------------------------------
create or replace function public.bookings_prepare()
returns trigger
language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare
  v_svc public.services%rowtype;
begin
  new.customer_email := lower(btrim(new.customer_email));
  new.customer_name  := btrim(new.customer_name);
  new.customer_phone := btrim(new.customer_phone);
  new.updated_at     := now();

  select * into v_svc from public.services where id = new.service_id;
  if found then
    -- Alta a mano desde el panel: basta con inicio; el fin sale de la duración.
    if new.ends_at is null and new.starts_at is not null then
      new.ends_at := new.starts_at + make_interval(mins => v_svc.duration_minutes);
    end if;
    -- El descanso del servicio queda "pegado" al turno.
    if new.occupied_until is null
       or (tg_op = 'UPDATE' and (new.ends_at is distinct from old.ends_at
                                 or new.service_id is distinct from old.service_id)) then
      new.occupied_until := new.ends_at + make_interval(mins => v_svc.break_minutes);
    end if;
  end if;

  if new.status = 'cancelled' then
    new.cancelled_at := coalesce(new.cancelled_at, now());
  else
    new.cancelled_at := null;
  end if;

  -- FASE 2: otra hora = recordatorios nuevos.
  if tg_op = 'UPDATE' and new.starts_at is distinct from old.starts_at then
    new.reminder_24h_sent_at  := null;
    new.reminder_1h_sent_at   := null;
    new.reminder_24h_attempts := 0;
    new.reminder_1h_attempts  := 0;
    if new.rescheduled_at is not distinct from old.rescheduled_at then
      new.rescheduled_at := now();   -- cambio a mano en el panel (la RPC ya fija su propio valor)
    end if;
  end if;

  return new;
end;
$$;

-- ------------------------------------------------------------
-- settings · nuevos parámetros (nada hardcodeado en n8n)
-- ------------------------------------------------------------
insert into public.settings (key, value, description) values
  ('reschedule_form_url',      'https://TU-N8N/form/cambiar-turno',
     'URL pública del formulario de cambio de hora (workflow 03). El enlace del correo añade ?codigo=...'),
  ('staff_email',              '',
     'Correo de quien atiende: recibe el resumen diario y los avisos de reservas, cancelaciones y cambios. Vacío = usar admin_email.'),
  ('daily_summary_time',       '08:00',
     'Hora local (HH:MM, en la zona de "timezone") a partir de la cual se envía el resumen diario.'),
  ('daily_summary_send_empty', 'true',
     'true = si hoy no hay turnos se envía un aviso breve; false = no se envía nada.'),
  ('reminder_max_attempts',    '3',
     'Intentos máximos de envío de cada recordatorio (y del resumen diario) antes de darlo por fallido y avisar al administrador.')
on conflict (key) do nothing;

-- ------------------------------------------------------------
-- daily_summary_log · un resumen por día, aunque el workflow se dispare dos veces
--   claimed = un workflow lo ha reclamado y está enviándolo
--   sent    = enviado               skipped = no había turnos y no se envía vacío
--   retry   = falló, se reintentará failed  = falló demasiadas veces (se avisó al administrador)
-- ------------------------------------------------------------
create table public.daily_summary_log (
  day         date primary key,          -- día LOCAL del resumen
  status      text not null check (status in ('claimed', 'sent', 'skipped', 'retry', 'failed')),
  attempts    smallint not null default 1,
  claimed_at  timestamptz not null default now(),
  sent_at     timestamptz,
  last_error  text
);
comment on table public.daily_summary_log is 'Control del resumen diario: la clave primaria (día) impide enviarlo dos veces.';
commit;


-- ############################################################
-- ## 20261021000002_fase2_cambio_de_hora.sql
-- ############################################################
begin;
-- ============================================================
-- FASE 2 · 0002 · CAMBIO DE HORA
-- ============================================================
--  Públicas (solo service_role, ver 0004), vía POST /rest/v1/rpc/<nombre>:
--    get_reschedule_info(code)                -> jsonb  (¿se puede cambiar? datos del turno actual)
--    get_reschedule_availability(code, day)   -> jsonb  (horas libres de ese día, MISMO formato que get_availability)
--    reschedule_booking(code, starts_at)      -> jsonb  (cambio transaccional)
--  Internas con p_now (para poder probarlas con reloj fijo):
--    _get_reschedule_info, _get_reschedule_availability, _reschedule_booking (+ ayudantes _find_booking, _change_error)
--
--  También aquí:
--    * La disponibilidad (_available_slots, _next_available_days, _get_availability) admite
--      ahora un parámetro opcional "turno que se está moviendo": su hueco actual no cuenta como
--      ocupado (si no, no se podría pasar de 10:00 a 10:30 por culpa del propio descanso) y su
--      hora actual no se vuelve a ofrecer. Las versiones de la Fase 1 delegan en las nuevas con
--      NULL: mismo cálculo, mismo resultado.
--    * _cancel_booking sube la versión del .ics (para que un cambio previo no oculte la
--      cancelación en los calendarios) y devuelve también el teléfono (aviso a quien atiende).
--    * get_config devuelve además staff_email y reschedule_form_url.
--
--  Atomicidad del cambio: es UN UPDATE de la misma fila, protegido por la restricción de
--  exclusión bookings_no_overlap. No hay "borrar el antiguo y crear el nuevo": si el hueco nuevo
--  no se puede ocupar, el UPDATE falla entero y el turno original queda exactamente como estaba.
-- ============================================================

set local search_path = public, extensions;

-- ------------------------------------------------------------
-- _available_slots · núcleo de la disponibilidad (con "turno que se mueve")
-- ------------------------------------------------------------
create function public._available_slots(
  p_service_id uuid, p_day date, p_now timestamptz, p_exclude_booking uuid)
returns table (slot_start timestamptz, slot_end timestamptz)
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  with cfg as (
    select s.id,
           s.duration_minutes,
           s.break_minutes,
           s.min_notice_hours,
           s.booking_window_days,
           coalesce(s.slot_step_minutes, s.duration_minutes) as step_minutes,
           app_timezone() as tz
    from public.services s
    where s.id = p_service_id and s.active
  ),
  bands as (
    select c.*,
           (p_day + b.t_start) at time zone c.tz as band_start,
           (p_day + b.t_end)   at time zone c.tz as band_end
    from cfg c
    join public.weekly_schedule w
      on w.service_id = c.id
     and w.weekday = extract(isodow from p_day)::int
    cross join lateral (values (w.morning_start,   w.morning_end),
                               (w.afternoon_start, w.afternoon_end)) as b(t_start, t_end)
    where b.t_start is not null
      and p_day >= (p_now at time zone c.tz)::date
      and p_day <= (p_now at time zone c.tz)::date + c.booking_window_days
  ),
  cand as (
    select b.*, g.s as s_start
    from bands b
    cross join lateral generate_series(
           b.band_start,
           b.band_end - make_interval(mins => b.duration_minutes),
           make_interval(mins => b.step_minutes)) as g(s)
  )
  select cand.s_start,
         cand.s_start + make_interval(mins => cand.duration_minutes)
  from cand
  where cand.s_start >= p_now + make_interval(hours => cand.min_notice_hours)
    and not exists (            -- turnos existentes (con su descanso), salvo el que se está moviendo
      select 1 from public.bookings k
      where k.service_id = cand.id
        and k.status <> 'cancelled'
        and k.id is distinct from p_exclude_booking
        and tstzrange(k.starts_at, k.occupied_until, '[)')
            && tstzrange(cand.s_start,
                         cand.s_start + make_interval(mins => cand.duration_minutes + cand.break_minutes), '[)'))
    and not exists (            -- bloqueos del servicio o globales
      select 1 from public.blocks bl
      where (bl.service_id is null or bl.service_id = cand.id)
        and tstzrange(bl.starts_at, bl.ends_at, '[)')
            && tstzrange(cand.s_start,
                         cand.s_start + make_interval(mins => cand.duration_minutes), '[)'))
    and (p_exclude_booking is null     -- la hora que ya tiene no se ofrece como "nueva"
         or cand.s_start is distinct from
            (select ex.starts_at from public.bookings ex where ex.id = p_exclude_booking))
  order by cand.s_start;
$$;
comment on function public._available_slots(uuid, date, timestamptz, uuid) is
  'Horas libres de un día. p_exclude_booking = turno que se está moviendo: su hueco actual no bloquea y su hora actual no se ofrece. NULL = comportamiento de la Fase 1.';

-- La versión de la Fase 1 pasa a ser un envoltorio (mismo contrato).
create or replace function public._available_slots(p_service_id uuid, p_day date, p_now timestamptz)
returns table (slot_start timestamptz, slot_end timestamptz)
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  select * from public._available_slots(p_service_id, p_day, p_now, null::uuid);
$$;

-- ------------------------------------------------------------
-- _next_available_days · próximos días con huecos (con "turno que se mueve")
-- ------------------------------------------------------------
create function public._next_available_days(
  p_service_id uuid, p_from date, p_limit int, p_now timestamptz, p_exclude_booking uuid)
returns table (day date, free_slots int)
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  with cfg as (
    select s.booking_window_days as w,
           (p_now at time zone app_timezone())::date as today
    from public.services s
    where s.id = p_service_id and s.active
  ),
  days as (
    select c.today + g.i as d
    from cfg c
    cross join lateral generate_series(greatest(coalesce(p_from, c.today), c.today) - c.today, c.w) as g(i)
  )
  select days.d, count(*)::int
  from days
  cross join lateral public._available_slots(p_service_id, days.d, p_now, p_exclude_booking) s
  group by days.d
  order by days.d
  limit p_limit;
$$;

create or replace function public._next_available_days(p_service_id uuid, p_from date, p_limit int, p_now timestamptz)
returns table (day date, free_slots int)
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  select * from public._next_available_days(p_service_id, p_from, p_limit, p_now, null::uuid);
$$;

-- ------------------------------------------------------------
-- _get_availability · horas libres de un día (+ próximos días si está lleno)
-- ------------------------------------------------------------
create function public._get_availability(
  p_service_id uuid, p_day date, p_now timestamptz, p_exclude_booking uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_tz      text := app_timezone();
  v_slots   jsonb;
  v_next    jsonb := '[]'::jsonb;
begin
  -- Igual que en la Fase 1: 'label' es lo que ve la persona en el desplegable; solo en la noche
  -- del cambio de hora de octubre se añade el desfase UTC para que las etiquetas sigan siendo únicas.
  select coalesce(jsonb_agg(jsonb_build_object(
           'starts_at', iso_utc(x.slot_start),
           'label',     case when x.dup > 1
                             then x.lbl || ' (UTC' || case when x.off_h >= 0 then '+' else '' end || x.off_h::text || ')'
                             else x.lbl end) order by x.slot_start), '[]'::jsonb)
    into v_slots
  from (
    select s.slot_start,
           to_char(s.slot_start at time zone v_tz, 'HH24:MI') as lbl,
           count(*) over (partition by to_char(s.slot_start at time zone v_tz, 'HH24:MI')) as dup,
           trim_scale(round(extract(epoch from (s.slot_start at time zone v_tz) - (s.slot_start at time zone 'UTC')) / 3600, 2)) as off_h
    from public._available_slots(p_service_id, p_day, p_now, p_exclude_booking) s
  ) x;

  if jsonb_array_length(v_slots) = 0 then
    select coalesce(jsonb_agg(jsonb_build_object('day', d.day, 'free_slots', d.free_slots) order by d.day), '[]'::jsonb)
      into v_next
    from public._next_available_days(p_service_id, p_day + 1, 5, p_now, p_exclude_booking) d;
  end if;

  return jsonb_build_object('day', p_day, 'timezone', v_tz, 'slots', v_slots, 'next_days', v_next);
end;
$$;

create or replace function public._get_availability(p_service_id uuid, p_day date, p_now timestamptz)
returns jsonb
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  select public._get_availability(p_service_id, p_day, p_now, null::uuid);
$$;

-- ------------------------------------------------------------
-- _find_booking · localiza el turno por su código (NULL si el código no es válido o no existe)
--   p_lock = true: bloquea primero el servicio (mismo bloqueo que _book_slot) y después la
--   fila del turno. Orden fijo servicio -> fila: sin interbloqueos con reservas ni cancelaciones.
-- _change_error · ¿se puede cambiar este turno? NULL = sí. Si no:
--   INVALID_CODE · NOT_CHANGEABLE (cancelado / pasado / servicio inactivo) · TOO_LATE (hours)
-- ------------------------------------------------------------
create function public._find_booking(p_code text, p_lock boolean)
returns public.bookings
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_code text := lower(btrim(coalesce(p_code, '')));
  v_sid  uuid;
  v_b    public.bookings;
begin
  if v_code !~ '^[0-9a-f]{32,}$' then
    return v_b;                                  -- todo NULL
  end if;
  if p_lock then
    select b.service_id into v_sid from public.bookings b where b.management_code = v_code;
    if v_sid is not null then
      perform pg_advisory_xact_lock(hashtextextended('slot:' || v_sid::text, 0));
    end if;
    select * into v_b from public.bookings b where b.management_code = v_code for update;
  else
    select * into v_b from public.bookings b where b.management_code = v_code;
  end if;
  return v_b;
end;
$$;

create function public._change_error(p_b public.bookings, p_s public.services, p_now timestamptz)
returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_hours int;
begin
  if p_b.id is null then
    return jsonb_build_object('ok', false, 'error', 'INVALID_CODE');
  end if;
  if p_b.status <> 'confirmed' or p_b.starts_at <= p_now or not p_s.active then
    return jsonb_build_object('ok', false, 'error', 'NOT_CHANGEABLE');
  end if;
  v_hours := coalesce(p_s.reschedule_notice_hours, p_s.cancel_notice_hours, p_s.min_notice_hours);
  if p_b.starts_at < p_now + make_interval(hours => v_hours) then
    return jsonb_build_object('ok', false, 'error', 'TOO_LATE', 'hours', v_hours);
  end if;
  return null;
end;
$$;

-- ------------------------------------------------------------
-- get_reschedule_info · el formulario comprueba el código ANTES de pedir nada más
-- ------------------------------------------------------------
create function public._get_reschedule_info(p_code text, p_now timestamptz)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_b   public.bookings;
  v_s   public.services;
  v_err jsonb;
  v_tz  text := app_timezone();
begin
  v_b := public._find_booking(p_code, false);
  select * into v_s from public.services where id = v_b.service_id;
  v_err := public._change_error(v_b, v_s, p_now);
  if v_err is not null then return v_err; end if;

  return jsonb_build_object(
    'ok',                  true,
    'service_id',          v_s.id,
    'service_name',        v_s.name,
    'customer_name',       v_b.customer_name,
    'starts_at',           iso_utc(v_b.starts_at),
    'local_date',          (v_b.starts_at at time zone v_tz)::date,
    'local_time',          to_char(v_b.starts_at at time zone v_tz, 'HH24:MI'),
    'timezone',            v_tz,
    'booking_window_days', v_s.booking_window_days);
end;
$$;

create function public.get_reschedule_info(p_code text)
returns jsonb
language sql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
  select public._get_reschedule_info(p_code, now());
$$;

-- ------------------------------------------------------------
-- get_reschedule_availability · MISMA función de disponibilidad que la reserva
-- ------------------------------------------------------------
create function public._get_reschedule_availability(p_code text, p_day date, p_now timestamptz)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_b   public.bookings;
  v_s   public.services;
  v_err jsonb;
begin
  v_b := public._find_booking(p_code, false);
  select * into v_s from public.services where id = v_b.service_id;
  v_err := public._change_error(v_b, v_s, p_now);
  if v_err is not null then return v_err; end if;
  return jsonb_build_object('ok', true) || public._get_availability(v_s.id, p_day, p_now, v_b.id);
end;
$$;

create function public.get_reschedule_availability(p_code text, p_day date)
returns jsonb
language sql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
  select public._get_reschedule_availability(p_code, p_day, now());
$$;

-- ------------------------------------------------------------
-- _reschedule_booking / reschedule_booking · cambio transaccional
-- Códigos de error (ok = false), sin datos del turno:
--   INVALID_CODE · NOT_CHANGEABLE · TOO_LATE (hours)
--   SAME_SLOT   (pide la hora que ya tiene)
--   SLOT_TAKEN  (la hora nueva no está libre o se ocupó mientras tanto)
-- En TODOS los errores el turno original queda intacto.
-- ------------------------------------------------------------
create function public._reschedule_booking(p_code text, p_new_start timestamptz, p_now timestamptz)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_b     public.bookings;
  v_s     public.services;
  v_err   jsonb;
  v_new   public.bookings;
  v_tz    text := app_timezone();
  v_old   timestamptz;
begin
  v_b := public._find_booking(p_code, true);
  select * into v_s from public.services where id = v_b.service_id;
  v_err := public._change_error(v_b, v_s, p_now);
  if v_err is not null then return v_err; end if;
  v_old := v_b.starts_at;

  if p_new_start is null then
    return jsonb_build_object('ok', false, 'error', 'SLOT_TAKEN');
  end if;
  if p_new_start = v_old then
    return jsonb_build_object('ok', false, 'error', 'SAME_SLOT');
  end if;

  -- La hora nueva debe ser una de las libres: horario, bloqueos, antelación X, días vista Y y
  -- descanso, con el hueco actual del propio turno contado como libre.
  if not exists (select 1
                 from public._available_slots(v_s.id, (p_new_start at time zone v_tz)::date, p_now, v_b.id) a
                 where a.slot_start = p_new_start) then
    return jsonb_build_object('ok', false, 'error', 'SLOT_TAKEN');
  end if;

  -- UN solo UPDATE de la misma fila. Si algo ajeno (p. ej. un alta a mano en el panel) ocupó el hueco
  -- a la vez, bookings_no_overlap lo impide: el subbloque deshace el UPDATE y el turno sigue donde estaba.
  begin
    update public.bookings
       set starts_at      = p_new_start,
           ends_at        = p_new_start + make_interval(mins => v_s.duration_minutes),
           ics_sequence   = ics_sequence + 1,
           rescheduled_at = p_now
     where id = v_b.id
    returning * into v_new;
  exception when exclusion_violation or deadlock_detected then
    return jsonb_build_object('ok', false, 'error', 'SLOT_TAKEN');
  end;

  return jsonb_build_object(
    'ok',              true,
    'booking_id',      v_new.id,
    'management_code', v_new.management_code,
    'service_name',    v_s.name,
    'customer_name',   v_new.customer_name,
    'customer_email',  v_new.customer_email,
    'customer_phone',  v_new.customer_phone,
    'old_starts_at',   iso_utc(v_old),
    'old_local_date',  (v_old at time zone v_tz)::date,
    'old_local_time',  to_char(v_old at time zone v_tz, 'HH24:MI'),
    'starts_at',       iso_utc(v_new.starts_at),
    'ends_at',         iso_utc(v_new.ends_at),
    'local_date',      (v_new.starts_at at time zone v_tz)::date,
    'local_time',      to_char(v_new.starts_at at time zone v_tz, 'HH24:MI'),
    'timezone',        v_tz,
    'ics_sequence',    v_new.ics_sequence);
end;
$$;

create function public.reschedule_booking(p_code text, p_starts_at timestamptz)
returns jsonb
language sql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
  select public._reschedule_booking(p_code, p_starts_at, now());
$$;

-- ------------------------------------------------------------
-- _cancel_booking · igual que en la Fase 1, más:
--   * sube ics_sequence (el .ics de cancelación debe tener un SEQUENCE mayor que el último enviado)
--   * devuelve customer_phone e ics_sequence
-- ------------------------------------------------------------
create or replace function public._cancel_booking(p_code text, p_now timestamptz)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_code  text := lower(btrim(coalesce(p_code, '')));
  v_b     public.bookings%rowtype;
  v_svc   public.services%rowtype;
  v_hours int;
  v_tz    text := app_timezone();
begin
  if v_code !~ '^[0-9a-f]{32,}$' then
    return jsonb_build_object('ok', false, 'error', 'INVALID_CODE');
  end if;

  select * into v_b from public.bookings where management_code = v_code for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'INVALID_CODE');
  end if;

  if v_b.status <> 'confirmed' or v_b.starts_at <= p_now then
    return jsonb_build_object('ok', false, 'error', 'NOT_CANCELLABLE');
  end if;

  select * into v_svc from public.services where id = v_b.service_id;
  v_hours := coalesce(v_svc.cancel_notice_hours, v_svc.min_notice_hours);
  if v_b.starts_at < p_now + make_interval(hours => v_hours) then
    return jsonb_build_object('ok', false, 'error', 'TOO_LATE', 'hours', v_hours);
  end if;

  update public.bookings set status = 'cancelled', ics_sequence = ics_sequence + 1
   where id = v_b.id returning * into v_b;

  return jsonb_build_object(
    'ok',             true,
    'booking_id',     v_b.id,
    'service_name',   v_svc.name,
    'customer_name',  v_b.customer_name,
    'customer_email', v_b.customer_email,
    'customer_phone', v_b.customer_phone,
    'starts_at',      iso_utc(v_b.starts_at),
    'ends_at',        iso_utc(v_b.ends_at),
    'local_date',     (v_b.starts_at at time zone v_tz)::date,
    'local_time',     to_char(v_b.starts_at at time zone v_tz, 'HH24:MI'),
    'timezone',       v_tz,
    'ics_sequence',   v_b.ics_sequence);
end;
$$;

-- ------------------------------------------------------------
-- get_config · + staff_email (si está vacío, el del administrador) y reschedule_form_url
-- ------------------------------------------------------------
create or replace function public.get_config()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'timezone',            coalesce((select value from public.settings where key = 'timezone'), 'Europe/Madrid'),
    'admin_email',         (select value from public.settings where key = 'admin_email'),
    'cancel_form_url',     (select value from public.settings where key = 'cancel_form_url'),
    'reschedule_form_url', (select value from public.settings where key = 'reschedule_form_url'),
    'staff_email',         coalesce(nullif(btrim((select value from public.settings where key = 'staff_email')), ''),
                                    (select value from public.settings where key = 'admin_email')));
$$;
commit;


-- ############################################################
-- ## 20261021000003_fase2_avisos.sql
-- ############################################################
begin;
-- ============================================================
-- FASE 2 · 0003 · RECORDATORIOS Y RESUMEN DIARIO
-- ============================================================
--  Públicas (solo service_role, ver 0004):
--    claim_due_reminders()                                   -> jsonb {"reminders":[...]}
--    report_reminder(booking, kind, claimed_at, ok, error, to) -> jsonb
--    claim_daily_summary()                                   -> jsonb
--    report_daily_summary(day, ok, error, to)                -> jsonb
--  Internas con p_now: _claim_due_reminders, _report_reminder, _claim_daily_summary, _report_daily_summary
--
--  RECORDATORIOS · cada uno sale UNA sola vez
--  ------------------------------------------
--  1. RECLAMO ATÓMICO. claim_due_reminders() hace UPDATE ... SET reminder_*_sent_at = now()
--     ... WHERE reminder_*_sent_at IS NULL ... RETURNING. Solo se envía lo que devuelve el RETURNING.
--     Dos ejecuciones simultáneas no pueden reclamar el mismo turno: FOR UPDATE SKIP LOCKED
--     salta las filas que la otra ya tiene y la condición IS NULL se vuelve a evaluar sobre la
--     fila bloqueada. El reclamo se hace ANTES de enviar: ante la duda se prefiere no enviar a enviar dos veces.
--  2. SI EL ENVÍO FALLA: n8n llama a report_reminder(ok=false). Eso (a) deja constancia en
--     email_log (status = failed + error), (b) LIBERA el reclamo (marca = NULL) solo si sigue
--     siendo el suyo, de modo que la ejecución siguiente (15 min después) lo vuelve a reclamar.
--     Cada reclamo cuenta un intento (reminder_*_attempts); al llegar a reminder_max_attempts
--     (por defecto 3) deja de reintentarse y se avisa al administrador (gave_up = true).
--     Un reintento nunca duplica: solo existe si el intento anterior falló y se liberó.
--  3. VENTANAS. 24 h: desde 24 h antes del turno y hasta 2 h antes (más tarde ya no tiene sentido).
--     1 h: desde 1 h antes y hasta el inicio. Nunca para turnos cancelados (el UPDATE exige
--     status = confirmed) ni para turnos reservados (o cambiados) con menos antelación que el
--     recordatorio: un turno reservado con 20 h de margen no recibe el de 24 h, y uno reservado con
--     30 min de margen no recibe el de 1 h justo después de su confirmación.
--  4. Cambiar la hora de un turno rearma sus recordatorios (trigger bookings_prepare).
--
--  RESUMEN DIARIO · uno por día
--  ----------------------------
--  claim_daily_summary() se puede llamar cada pocos minutos: devuelve due=false hasta que sea la hora
--  (settings.daily_summary_time, hora local) y, una vez reclamado el día, también. La clave primaria
--  de daily_summary_log (día) impide dos resúmenes el mismo día aunque dos ejecuciones coincidan.
--  Si n8n estuvo caído a las 08:00, el resumen sale en cuanto vuelve (el mismo día).
-- ============================================================

set local search_path = public, extensions;

create function public._max_attempts()
returns int
language sql
stable
set search_path = public, pg_temp
as $$
  select greatest(1, coalesce((select value::int from public.settings
                               where key = 'reminder_max_attempts' and value ~ '^[0-9]{1,3}$'), 3));
$$;

-- ------------------------------------------------------------
-- _claim_due_reminders
-- ------------------------------------------------------------
create function public._claim_due_reminders(p_now timestamptz)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_tz  text := app_timezone();
  v_max int  := _max_attempts();
  v_24  jsonb;
  v_1   jsonb;
begin
  -- ---- 24 h antes ----
  with due as (
    select b.id
    from public.bookings b
    where b.status = 'confirmed'
      and b.reminder_24h_sent_at is null
      and b.reminder_24h_attempts < v_max
      and b.starts_at <= p_now + interval '24 hours'
      and b.starts_at >  p_now + interval '2 hours'
      and coalesce(b.rescheduled_at, b.created_at) <= b.starts_at - interval '24 hours'
    order by b.starts_at
    for update skip locked
  ), c as (
    update public.bookings b
       set reminder_24h_sent_at  = p_now,
           reminder_24h_attempts = b.reminder_24h_attempts + 1
      from due
     where b.id = due.id
       and b.status = 'confirmed'
       and b.reminder_24h_sent_at is null
    returning b.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'kind',            '24h',
           'booking_id',      c.id,
           'claimed_at',      to_char(p_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
           'attempt',         c.reminder_24h_attempts,
           'customer_name',   c.customer_name,
           'customer_email',  c.customer_email,
           'management_code', c.management_code,
           'service_name',    s.name,
           'starts_at',       iso_utc(c.starts_at),
           'ends_at',         iso_utc(c.ends_at),
           'local_date',      (c.starts_at at time zone v_tz)::date,
           'local_time',      to_char(c.starts_at at time zone v_tz, 'HH24:MI'),
           'timezone',        v_tz) order by c.starts_at), '[]'::jsonb)
    into v_24
  from c join public.services s on s.id = c.service_id;

  -- ---- 1 h antes ----
  with due as (
    select b.id
    from public.bookings b
    where b.status = 'confirmed'
      and b.reminder_1h_sent_at is null
      and b.reminder_1h_attempts < v_max
      and b.starts_at <= p_now + interval '1 hour'
      and b.starts_at >  p_now
      and coalesce(b.rescheduled_at, b.created_at) <= b.starts_at - interval '1 hour'
    order by b.starts_at
    for update skip locked
  ), c as (
    update public.bookings b
       set reminder_1h_sent_at  = p_now,
           reminder_1h_attempts = b.reminder_1h_attempts + 1
      from due
     where b.id = due.id
       and b.status = 'confirmed'
       and b.reminder_1h_sent_at is null
    returning b.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'kind',            '1h',
           'booking_id',      c.id,
           'claimed_at',      to_char(p_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
           'attempt',         c.reminder_1h_attempts,
           'customer_name',   c.customer_name,
           'customer_email',  c.customer_email,
           'management_code', c.management_code,
           'service_name',    s.name,
           'starts_at',       iso_utc(c.starts_at),
           'ends_at',         iso_utc(c.ends_at),
           'local_date',      (c.starts_at at time zone v_tz)::date,
           'local_time',      to_char(c.starts_at at time zone v_tz, 'HH24:MI'),
           'timezone',        v_tz) order by c.starts_at), '[]'::jsonb)
    into v_1
  from c join public.services s on s.id = c.service_id;

  -- Un OBJETO (no un array): n8n parte los arrays en varios ítems y con 0 recordatorios el flujo se pararía.
  return jsonb_build_object('reminders', v_24 || v_1);
end;
$$;

create function public.claim_due_reminders()
returns jsonb
language sql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
  select public._claim_due_reminders(now());
$$;

-- ------------------------------------------------------------
-- _report_reminder · n8n cuenta aquí cómo fue el envío de un recordatorio reclamado
--   p_claimed_at: el "claimed_at" que devolvió el reclamo (solo libera quien sigue siendo su dueño)
--   Devuelve { ok, will_retry, gave_up }
-- ------------------------------------------------------------
create function public._report_reminder(
  p_booking_id uuid, p_kind text, p_claimed_at timestamptz, p_ok boolean, p_error text, p_to text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_att      int;
  v_released boolean := false;
  v_max      int := _max_attempts();
begin
  if p_kind not in ('24h', '1h') then
    return jsonb_build_object('ok', false, 'error', 'INVALID_KIND');
  end if;

  insert into public.email_log (booking_id, kind, to_email, status, error)
  values (p_booking_id, 'reminder_' || p_kind, coalesce(p_to, '?'),
          case when p_ok then 'sent' else 'failed' end,
          case when p_ok then null else left(coalesce(p_error, 'error desconocido'), 2000) end);

  if p_ok then
    return jsonb_build_object('ok', true, 'will_retry', false, 'gave_up', false);
  end if;

  -- Fallo: se libera el reclamo (si sigue siendo el de esta ejecución) para que se reintente.
  if p_kind = '24h' then
    update public.bookings set reminder_24h_sent_at = null
     where id = p_booking_id and reminder_24h_sent_at = p_claimed_at
    returning reminder_24h_attempts into v_att;
  else
    update public.bookings set reminder_1h_sent_at = null
     where id = p_booking_id and reminder_1h_sent_at = p_claimed_at
    returning reminder_1h_attempts into v_att;
  end if;
  v_released := found;

  return jsonb_build_object('ok', true,
                            'will_retry', v_released and v_att < v_max,
                            'gave_up',    v_released and v_att >= v_max,
                            'attempts',   v_att);
end;
$$;

create function public.report_reminder(
  p_booking_id uuid, p_kind text, p_claimed_at timestamptz, p_ok boolean, p_error text default null, p_to text default null)
returns jsonb
language sql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
  select public._report_reminder(p_booking_id, p_kind, p_claimed_at, p_ok, p_error, p_to);
$$;

-- ------------------------------------------------------------
-- _claim_daily_summary · due=true solo UNA vez al día (y solo a partir de la hora configurada)
--   Devuelve { due: false, reason } o
--           { due: true, send, day, local_date, timezone, count, bookings:[...] }
--   send = false cuando no hay turnos y daily_summary_send_empty = false (el día queda como 'skipped').
-- ------------------------------------------------------------
create function public._claim_daily_summary(p_now timestamptz)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_tz         text := app_timezone();
  v_local      timestamp := p_now at time zone v_tz;
  v_day        date := (p_now at time zone v_tz)::date;
  v_cfg_time   text := (select value from public.settings where key = 'daily_summary_time');
  v_time       time := '08:00';
  v_send_empty boolean := lower(coalesce((select value from public.settings where key = 'daily_summary_send_empty'), 'true'))
                          in ('true', 't', '1', 'yes', 'si', 'sí');
  v_max        int := _max_attempts();
  v_att        smallint;
  v_from       timestamptz;
  v_to         timestamptz;
  v_rows       jsonb;
  v_n          int;
  v_send       boolean;
begin
  if v_cfg_time ~ '^[0-2]?[0-9]:[0-5][0-9]$' then v_time := v_cfg_time::time; end if;

  if v_local::time < v_time then
    return jsonb_build_object('due', false, 'reason', 'TOO_EARLY');
  end if;

  insert into public.daily_summary_log as l (day, status, attempts, claimed_at)
  values (v_day, 'claimed', 1, p_now)
  on conflict (day) do update
     set status = 'claimed', attempts = l.attempts + 1, claimed_at = p_now, last_error = null
   where l.status = 'retry' and l.attempts < v_max
  returning l.attempts into v_att;
  if not found then
    return jsonb_build_object('due', false, 'reason', 'ALREADY_DONE');
  end if;

  v_from := v_day::timestamp at time zone v_tz;           -- 00:00 local de hoy (respeta el cambio de hora)
  v_to   := (v_day + 1)::timestamp at time zone v_tz;     -- 00:00 local de mañana

  select coalesce(jsonb_agg(jsonb_build_object(
           'booking_id',     b.id,
           'starts_at',      iso_utc(b.starts_at),
           'local_time',     to_char(b.starts_at at time zone v_tz, 'HH24:MI'),
           'service_name',   s.name,
           'customer_name',  b.customer_name,
           'customer_phone', b.customer_phone,
           'customer_email', b.customer_email) order by b.starts_at, s.name, b.customer_name), '[]'::jsonb),
         count(*)::int
    into v_rows, v_n
  from public.bookings b
  join public.services s on s.id = b.service_id
  where b.status = 'confirmed'
    and b.starts_at >= v_from and b.starts_at < v_to;

  v_send := v_n > 0 or v_send_empty;
  if not v_send then
    update public.daily_summary_log set status = 'skipped' where day = v_day;
  end if;

  return jsonb_build_object('due', true, 'send', v_send, 'day', v_day, 'local_date', v_day,
                            'timezone', v_tz, 'attempt', v_att, 'count', v_n, 'bookings', v_rows);
end;
$$;

create function public.claim_daily_summary()
returns jsonb
language sql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
  select public._claim_daily_summary(now());
$$;

-- ------------------------------------------------------------
-- _report_daily_summary · resultado del envío. Devuelve { ok, will_retry, gave_up }
-- ------------------------------------------------------------
create function public._report_daily_summary(
  p_day date, p_ok boolean, p_error text, p_to text, p_now timestamptz)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_status text;
begin
  insert into public.email_log (booking_id, kind, to_email, status, error)
  values (null, 'daily_summary', coalesce(p_to, '?'),
          case when p_ok then 'sent' else 'failed' end,
          case when p_ok then null else left(coalesce(p_error, 'error desconocido'), 2000) end);

  if p_ok then
    update public.daily_summary_log set status = 'sent', sent_at = p_now
     where day = p_day and status = 'claimed';
    return jsonb_build_object('ok', true, 'will_retry', false, 'gave_up', false);
  end if;

  update public.daily_summary_log
     set status = case when attempts < _max_attempts() then 'retry' else 'failed' end,
         last_error = left(coalesce(p_error, 'error desconocido'), 2000)
   where day = p_day and status = 'claimed'
  returning status into v_status;

  return jsonb_build_object('ok', true, 'will_retry', v_status = 'retry', 'gave_up', v_status = 'failed');
end;
$$;

create function public.report_daily_summary(p_day date, p_ok boolean, p_error text default null, p_to text default null)
returns jsonb
language sql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
  select public._report_daily_summary(p_day, p_ok, p_error, p_to, now());
$$;
commit;


-- ############################################################
-- ## 20261021000004_fase2_seguridad.sql
-- ############################################################
begin;
-- ============================================================
-- FASE 2 · 0004 · SEGURIDAD de lo nuevo (mismo criterio que la Fase 1)
--   * RLS en la tabla nueva y sin políticas; fuera anon y authenticated.
--   * Funciones nuevas: fuera para todos (incluido PUBLIC) y dentro solo service_role
--     las públicas. Las internas (_algo) solo las usan las públicas (SECURITY DEFINER).
--   (Las funciones REEMPLAZADAS con create or replace conservan los permisos de la Fase 1.)
-- ============================================================

set local search_path = public, extensions;

alter table public.daily_summary_log enable row level security;
revoke all on public.daily_summary_log from anon, authenticated;
grant  all on public.daily_summary_log to service_role;

revoke execute on function
  public._available_slots(uuid, date, timestamptz, uuid),
  public._next_available_days(uuid, date, int, timestamptz, uuid),
  public._get_availability(uuid, date, timestamptz, uuid),
  public._find_booking(text, boolean),
  public._change_error(public.bookings, public.services, timestamptz),
  public._get_reschedule_info(text, timestamptz),
  public.get_reschedule_info(text),
  public._get_reschedule_availability(text, date, timestamptz),
  public.get_reschedule_availability(text, date),
  public._reschedule_booking(text, timestamptz, timestamptz),
  public.reschedule_booking(text, timestamptz),
  public._max_attempts(),
  public._claim_due_reminders(timestamptz),
  public.claim_due_reminders(),
  public._report_reminder(uuid, text, timestamptz, boolean, text, text),
  public.report_reminder(uuid, text, timestamptz, boolean, text, text),
  public._claim_daily_summary(timestamptz),
  public.claim_daily_summary(),
  public._report_daily_summary(date, boolean, text, text, timestamptz),
  public.report_daily_summary(date, boolean, text, text)
from public, anon, authenticated;

grant execute on function
  public.get_reschedule_info(text),
  public.get_reschedule_availability(text, date),
  public.reschedule_booking(text, timestamptz),
  public.claim_due_reminders(),
  public.report_reminder(uuid, text, timestamptz, boolean, text, text),
  public.claim_daily_summary(),
  public.report_daily_summary(date, boolean, text, text)
to service_role;
commit;


-- ############################################################
-- ## 20261022000001_fase3_enlaces_tablas.sql
-- ############################################################
begin;
-- ============================================================
-- FASE 3 · 0001 · ENLACES CORTOS: TABLAS, AJUSTES Y VALIDACIÓN DEL DESTINO
-- (Las migraciones de las Fases 1 y 2 no se tocan: todo lo nuevo va aquí.)
--   * links               un enlace corto = un slug (l.rocketnova.io/<slug>) + su destino
--   * link_clicks_daily   clics por enlace y día (local), para ver la evolución
--   * settings            dominios permitidos, URL del formulario de reserva, página por defecto...
--   * _link_destination_error()   ÚNICO sitio donde se decide si un destino es válido (anti redirección abierta)
--   * bookings.source     se normaliza (minúsculas, mismo formato que un slug) o se descarta
-- ============================================================

set local search_path = public, extensions;

-- ------------------------------------------------------------
-- settings · nuevos parámetros (nada hardcodeado en n8n)
-- ------------------------------------------------------------
insert into public.settings (key, value, description) values
  ('booking_form_url',     'https://TU-N8N/form/reservar-turno',
     'URL pública del formulario de reserva (workflow 01). Es el destino por defecto de un enlace corto; se le añade ?origen=<slug>.'),
  ('link_base_url',        'https://l.rocketnova.io',
     'Dominio de los enlaces cortos, sin barra final. Solo sirve para mostrar el enlace creado y para impedir bucles (un destino no puede ser este mismo dominio).'),
  ('link_default_url',     'https://rocketnova.io',
     'Página a la que se redirige cuando el slug no existe o el enlace está desactivado. También debe estar en un dominio permitido.'),
  ('link_allowed_domains', 'rocketnova.io',
     'Dominios a los que puede redirigir un enlace corto (separados por comas o espacios). Un dominio permite también sus subdominios: "rocketnova.io" permite reservas.rocketnova.io. Añade aquí el dominio de tu n8n. Vacío = no se permite ningún destino. Solo https (http únicamente para localhost, para pruebas).')
on conflict (key) do nothing;

-- ------------------------------------------------------------
-- _link_destination_error · ¿es válido este destino? NULL = sí; si no, el código del motivo.
--   DESTINATION_NOT_ALLOWED  forma rara, esquema no permitido o dominio fuera de la lista
--   DESTINATION_LOOP         apunta al propio dominio de los enlaces cortos (redirección infinita)
--   DESTINATION_HAS_ORIGEN   ya lleva un parámetro origen= (lo añade el sistema)
-- Lo usan el trigger de `links` (altas/ediciones desde el panel), create_link() y resolve_link()
-- (que lo vuelve a comprobar en cada clic por si la lista de dominios se acortó después).
--
-- Qué se rechaza antes de mirar el dominio (así no hay trucos con el "host"):
--   · cualquier carácter que no sea ASCII imprimible (espacios, tabulaciones, saltos de línea, Unicode)
--   · @ (credenciales: https://rocketnova.io@evil.com), \ (https://evil.com\.rocketnova.io), < > " ' ` { } | ^
--   · todo lo que no sea  http(s)://host[:puerto][/ruta][?consulta][#fragmento]  (//evil.com, javascript:, data:...)
-- Y el host debe ser EXACTAMENTE un dominio permitido o terminar en ".<dominio permitido>"
-- (rocketnova.io.evil.com y evilrocketnova.io no pasan).
-- ------------------------------------------------------------
create function public._link_destination_error(p_url text)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_m       text[];
  v_scheme  text;
  v_host    text;
  v_base    text[];
begin
  -- (las repeticiones de una expresión regular de Postgres llegan a 255: la longitud se mide aparte)
  if p_url is null or length(p_url) > 2000 or p_url !~ '^[!-~]+$' then
    return 'DESTINATION_NOT_ALLOWED';
  end if;
  if length(translate(p_url, chr(92) || '@<>"`{}|^' || chr(39), '')) <> length(p_url) then
    return 'DESTINATION_NOT_ALLOWED';
  end if;

  v_m := regexp_match(p_url,
    '^(https?)://([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)(?::[0-9]{1,5})?(?:[/?#].*)?$', 'i');
  if v_m is null then
    return 'DESTINATION_NOT_ALLOWED';
  end if;
  v_scheme := lower(v_m[1]);
  v_host   := lower(v_m[2]);

  -- http solo para pruebas en local
  if v_scheme = 'http' and v_host not in ('localhost', '127.0.0.1') then
    return 'DESTINATION_NOT_ALLOWED';
  end if;

  if not exists (
    select 1
    from regexp_split_to_table(lower(coalesce((select value from public.settings where key = 'link_allowed_domains'), '')),
                               '[\s,;]+') as t(raw)
    cross join lateral (select regexp_replace(t.raw, '^\*?\.', '') as d) x
    where x.d ~ '^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$'
      and (position('.' in x.d) > 0 or x.d = 'localhost')          -- nada de "com" o "io" a secas
      and (v_host = x.d or right(v_host, length(x.d) + 1) = '.' || x.d)
  ) then
    return 'DESTINATION_NOT_ALLOWED';
  end if;

  v_base := regexp_match(coalesce((select value from public.settings where key = 'link_base_url'), ''),
                         '^https?://([^/:?#]+)', 'i');
  if v_base is not null and v_host = lower(v_base[1]) then
    return 'DESTINATION_LOOP';
  end if;

  if p_url ~* '[?&]origen=' then
    return 'DESTINATION_HAS_ORIGEN';
  end if;

  return null;
end;
$$;

-- ------------------------------------------------------------
-- links · un enlace corto
-- ------------------------------------------------------------
create table public.links (
  id           uuid primary key default gen_random_uuid(),
  slug         text not null unique,
  destination  text not null,
  channel      text,                                   -- NULL = el canal es el propio slug
  active       boolean not null default true,
  click_count  bigint not null default 0 check (click_count >= 0),
  last_click_at timestamptz,
  created_at   timestamptz not null default now(),
  constraint links_slug_format    check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 40),
  constraint links_channel_format check (channel is null or (channel ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(channel) <= 40))
);
comment on table  public.links              is 'Enlaces cortos (l.rocketnova.io/<slug>). Se crean con el formulario del equipo (workflow 07) o a mano; el contador solo lo sube el workflow 06 vía register_click().';
comment on column public.links.slug         is 'Minúsculas, números y guiones (sin guion al principio, al final ni dobles), 1-40 caracteres. No se puede cambiar: desactiva el enlace y crea otro.';
comment on column public.links.destination  is 'URL completa a la que se redirige. Debe estar en un dominio de settings.link_allowed_domains. Al redirigir se le añade ?origen=<slug>.';
comment on column public.links.channel      is 'Agrupa varios enlaces en un canal para las estadísticas (p. ej. instagram-bio e instagram-stories -> instagram). NULL = el slug.';
comment on column public.links.active       is 'false = el enlace deja de redirigir al destino (va a la página por defecto) y no cuenta clics. Las estadísticas se conservan.';
comment on column public.links.click_count  is 'Clics contados (incremento atómico). No editar a mano.';

-- ------------------------------------------------------------
-- link_clicks_daily · clics por enlace y día LOCAL
-- ------------------------------------------------------------
create table public.link_clicks_daily (
  link_id  uuid   not null references public.links(id) on delete cascade,
  day      date   not null,
  clicks   bigint not null default 0 check (clicks >= 0),
  primary key (link_id, day)
);
comment on table public.link_clicks_daily is 'Clics por enlace y día local. Sube en la misma sentencia que links.click_count, así que las dos cifras siempre coinciden.';

-- ------------------------------------------------------------
-- links_guard · protege también las altas y ediciones a mano desde el panel
-- ------------------------------------------------------------
create function public.links_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_err text;
begin
  if tg_op = 'UPDATE' and new.slug is distinct from old.slug then
    raise exception 'El slug de un enlace no se puede cambiar: desactiva este enlace y crea otro.'
      using errcode = '23000';
  end if;
  if tg_op = 'INSERT' or new.destination is distinct from old.destination then
    new.destination := btrim(new.destination);
    v_err := public._link_destination_error(new.destination);
    if v_err is not null then
      raise exception 'Destino no permitido (%). Revisa settings.link_allowed_domains y que no lleve origen=.', v_err
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

-- Solo al crear o al tocar slug/destino: el incremento de clics (click_count) no lo dispara.
create trigger links_guard
  before insert or update of slug, destination on public.links
  for each row execute function public.links_guard();

-- ------------------------------------------------------------
-- bookings.source · solo valores con forma de slug
--   La reserva NUNCA falla por un origen raro: se guarda en minúsculas si tiene formato de slug
--   (a-z, 0-9, guiones, hasta 40) y si no, se descarta (NULL). Así nadie ensucia las estadísticas
--   ni bloquea una reserva escribiendo cualquier cosa en ?origen=
-- ------------------------------------------------------------
create function public.bookings_normalize_source()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.source is not null then
    new.source := lower(btrim(new.source));
    if new.source = '' or length(new.source) > 40 or new.source !~ '^[a-z0-9]+(-[a-z0-9]+)*$' then
      new.source := null;
    end if;
  end if;
  return new;
end;
$$;

create trigger bookings_normalize_source
  before insert or update of source on public.bookings
  for each row execute function public.bookings_normalize_source();
commit;


-- ############################################################
-- ## 20261022000002_fase3_enlaces_rpc.sql
-- ############################################################
begin;
-- ============================================================
-- FASE 3 · 0002 · FUNCIONES DE LOS ENLACES CORTOS (toda la lógica vive aquí; n8n solo las llama)
--   Públicas (solo service_role, ver 0004), vía POST /rest/v1/rpc/<nombre>:
--     create_link(slug, destino, canal)  -> jsonb   formulario del equipo (workflow 07)
--     resolve_link(slug)                 -> jsonb   a dónde redirigir (workflow 06). Solo LEE.
--     register_click(slug)               -> jsonb   suma 1 clic, atómico (workflow 06, DESPUÉS de redirigir)
--   Interna: _register_click(slug, ahora)   permite fijar "now" en las pruebas.
--
--   resolve_link y register_click están separadas a propósito: la redirección no espera al recuento.
-- ============================================================

set local search_path = public, extensions;

-- ------------------------------------------------------------
-- create_link · crea un enlace. Códigos de error (ok = false):
--   INVALID_SLUG · INVALID_CHANNEL · SLUG_TAKEN
--   DESTINATION_NOT_ALLOWED · DESTINATION_LOOP · DESTINATION_HAS_ORIGEN
-- Un destino vacío significa "el formulario de reserva" (settings.booking_form_url).
-- El slug NO se corrige en silencio (nada de pasar mayúsculas a minúsculas): si no cumple, se avisa.
-- La unicidad la garantiza el índice único; si dos personas crean el mismo slug a la vez, una recibe SLUG_TAKEN.
-- ------------------------------------------------------------
create function public.create_link(p_slug text, p_destination text default null, p_channel text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_slug text := btrim(coalesce(p_slug, ''));
  v_dest text := nullif(btrim(coalesce(p_destination, '')), '');
  v_chan text := nullif(btrim(coalesce(p_channel, '')), '');
  v_err  text;
  v_link public.links%rowtype;
  v_base text;
begin
  if v_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or length(v_slug) > 40 then
    return jsonb_build_object('ok', false, 'error', 'INVALID_SLUG');
  end if;
  if v_chan is not null and (v_chan !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or length(v_chan) > 40) then
    return jsonb_build_object('ok', false, 'error', 'INVALID_CHANNEL');
  end if;

  if v_dest is null then
    v_dest := (select value from public.settings where key = 'booking_form_url');
  end if;
  v_err := public._link_destination_error(v_dest);
  if v_err is not null then
    return jsonb_build_object('ok', false, 'error', v_err);
  end if;

  begin
    insert into public.links (slug, destination, channel)
    values (v_slug, v_dest, v_chan)
    returning * into v_link;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'error', 'SLUG_TAKEN');
  end;

  v_base := rtrim(coalesce((select value from public.settings where key = 'link_base_url'), ''), '/');
  return jsonb_build_object(
    'ok',          true,
    'link_id',     v_link.id,
    'slug',        v_link.slug,
    'channel',     coalesce(v_link.channel, v_link.slug),
    'destination', v_link.destination,
    'short_url',   v_base || '/' || v_link.slug);
end;
$$;

-- ------------------------------------------------------------
-- resolve_link · ¿a dónde va este slug?  NO modifica nada.
--   {ok, found: true,  slug, url}   enlace activo con destino válido; url = destino + origen=<slug>
--   {ok, found: false, url}         no existe / desactivado / destino ya no permitido -> página por defecto
--                                   (url = null si ni la página por defecto es válida: el workflow responde 404)
-- Cualquier cosa rara en p_slug (mayúsculas, ../, comillas, 10 000 caracteres) simplemente "no existe".
-- El destino se vuelve a validar AQUÍ, en cada clic: si alguien editó la fila a mano saltándose el trigger
-- (p. ej. con disable trigger) o acortó la lista de dominios, no se redirige a un sitio no permitido.
-- ------------------------------------------------------------
create function public.resolve_link(p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_slug text := lower(btrim(coalesce(p_slug, '')));
  v_link public.links%rowtype;
  v_hash int;
  v_base text;
  v_url  text;
  v_def  text;
begin
  if v_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(v_slug) <= 40 then
    select * into v_link from public.links where slug = v_slug and active;
  end if;

  if v_link.id is not null and public._link_destination_error(v_link.destination) is null then
    -- origen=<slug> va antes del #fragmento, si lo hay
    v_hash := position('#' in v_link.destination);
    v_base := case when v_hash > 0 then left(v_link.destination, v_hash - 1) else v_link.destination end;
    v_url  := v_base
              || case when position('?' in v_base) > 0 then '&' else '?' end
              || 'origen=' || v_link.slug
              || case when v_hash > 0 then substr(v_link.destination, v_hash) else '' end;
    return jsonb_build_object('ok', true, 'found', true, 'slug', v_link.slug, 'url', v_url);
  end if;

  v_def := (select value from public.settings where key = 'link_default_url');
  if public._link_destination_error(v_def) is not null then
    v_def := null;
  end if;
  return jsonb_build_object('ok', true, 'found', false, 'url', v_def);
end;
$$;

-- ------------------------------------------------------------
-- _register_click / register_click · UN clic = +1, atómico
--   Una sola sentencia (UPDATE ... RETURNING dentro de un INSERT ... ON CONFLICT): sube click_count y el contador
--   del día en la misma transacción. Dos clics a la vez se ponen en cola sobre la fila (el segundo UPDATE vuelve
--   a leer el valor ya incrementado), así que no se pierde ninguno ni se cuenta uno dos veces.
--   Solo cuenta enlaces que existen y están activos; con cualquier otra cosa devuelve counted = false sin error.
-- ------------------------------------------------------------
create function public._register_click(p_slug text, p_now timestamptz)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_slug text := lower(btrim(coalesce(p_slug, '')));
  v_id   uuid;
begin
  if v_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or length(v_slug) > 40 then
    return jsonb_build_object('ok', true, 'counted', false);
  end if;

  with hit as (
    update public.links
       set click_count = click_count + 1,
           last_click_at = p_now
     where slug = v_slug and active
    returning id
  )
  insert into public.link_clicks_daily (link_id, day, clicks)
  select id, (p_now at time zone app_timezone())::date, 1 from hit
  on conflict (link_id, day) do update set clicks = public.link_clicks_daily.clicks + 1
  returning link_id into v_id;

  return jsonb_build_object('ok', true, 'counted', v_id is not null);
end;
$$;

create function public.register_click(p_slug text)
returns jsonb
language sql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
  select public._register_click(p_slug, now());
$$;
commit;


-- ############################################################
-- ## 20261022000003_fase3_estadisticas_y_bloqueos.sql
-- ############################################################
begin;
-- ============================================================
-- FASE 3 · 0003 · ESTADÍSTICAS Y TURNOS AFECTADOS POR BLOQUEOS
-- Vistas listas para el panel de Supabase (Table Editor / SQL Editor). Son de SOLO LECTURA y nadie salvo
-- service_role (y el propietario, es decir, el panel) puede consultarlas.
--
--   stats_links               clics, reservas y conversión por ENLACE
--   stats_channels            lo mismo agrupado por CANAL (incluye "directo" y orígenes sin enlace)
--   stats_clicks_daily        clics por enlace y día
--   blocks_affected_bookings  turnos confirmados que quedan DENTRO de un bloqueo (hay que avisarles)
--   bookings_affected_by()    lo mismo, ANTES de crear el bloqueo
--
-- Definiciones (importan para interpretar los números):
--   clics        = links.click_count (un clic = una carga del enlace corto por una persona, sin bots ni previsualizaciones)
--   reservas     = turnos creados con bookings.source = slug, en CUALQUIER estado (también los cancelados después)
--   conversión % = reservas / clics × 100 (NULL si aún no hay clics). Aproximada: una misma persona puede hacer clic
--                  varias veces o compartir el enlace del formulario con ?origen=..., por eso puede pasar de 100.
-- ============================================================

set local search_path = public, extensions;

-- ------------------------------------------------------------
-- stats_links · por enlace
-- ------------------------------------------------------------
create view public.stats_links with (security_invoker = true) as
select l.slug,
       coalesce(l.channel, l.slug)                            as channel,
       l.active,
       l.destination,
       l.click_count                                          as clicks,
       count(b.id)                                            as bookings,
       count(b.id) filter (where b.status <> 'cancelled')     as bookings_not_cancelled,
       count(b.id) filter (where b.status = 'cancelled')      as bookings_cancelled,
       count(b.id) filter (where b.status = 'attended')       as bookings_attended,
       count(b.id) filter (where b.status = 'no_show')        as bookings_no_show,
       case when l.click_count > 0
            then round(100.0 * count(b.id) / l.click_count, 1) end  as conversion_pct,
       l.created_at,
       l.last_click_at
from public.links l
left join public.bookings b on b.source = l.slug
group by l.id
order by l.click_count desc, l.slug;
comment on view public.stats_links is 'Clics, reservas y conversión por enlace. conversion_pct = reservas (todas) / clics × 100.';

-- ------------------------------------------------------------
-- stats_channels · por canal
--   canal de un enlace  = links.channel o, si está vacío, su slug
--   canal de una reserva = el del enlace de su source; si el source no es un enlace, el propio source
--                          (p. ej. ?origen=newsletter escrito a mano); sin source = 'directo'
--   Así la suma de reservas de todos los canales = todas las reservas.
-- ------------------------------------------------------------
create view public.stats_channels with (security_invoker = true) as
with clicks as (
  select coalesce(channel, slug) as channel,
         count(*)                as links,
         sum(click_count)::bigint as clicks
  from public.links
  group by 1
),
res as (
  select coalesce(l.channel, l.slug, b.source, 'directo')            as channel,
         count(*)                                                    as bookings,
         count(*) filter (where b.status <> 'cancelled')             as bookings_not_cancelled,
         count(*) filter (where b.status = 'cancelled')              as bookings_cancelled,
         count(*) filter (where b.status = 'attended')               as bookings_attended,
         count(*) filter (where b.status = 'no_show')                as bookings_no_show
  from public.bookings b
  left join public.links l on l.slug = b.source
  group by 1
)
select coalesce(c.channel, r.channel)                  as channel,
       coalesce(c.links, 0)                            as links,
       coalesce(c.clicks, 0)                           as clicks,
       coalesce(r.bookings, 0)                         as bookings,
       coalesce(r.bookings_not_cancelled, 0)           as bookings_not_cancelled,
       coalesce(r.bookings_cancelled, 0)               as bookings_cancelled,
       coalesce(r.bookings_attended, 0)                as bookings_attended,
       coalesce(r.bookings_no_show, 0)                 as bookings_no_show,
       case when coalesce(c.clicks, 0) > 0
            then round(100.0 * coalesce(r.bookings, 0) / c.clicks, 1) end as conversion_pct
from clicks c
full join res r on r.channel = c.channel
order by coalesce(c.clicks, 0) desc, coalesce(r.bookings, 0) desc, 1;
comment on view public.stats_channels is 'Clics, reservas y conversión por canal. Incluye "directo" (sin origen) y orígenes sin enlace corto. Sin clics, conversion_pct es NULL.';

-- ------------------------------------------------------------
-- stats_clicks_daily · clics por enlace y día local
-- ------------------------------------------------------------
create view public.stats_clicks_daily with (security_invoker = true) as
select l.slug, coalesce(l.channel, l.slug) as channel, d.day, d.clicks
from public.link_clicks_daily d
join public.links l on l.id = d.link_id
order by d.day desc, l.slug;
comment on view public.stats_clicks_daily is 'Clics por enlace y día (día local de settings.timezone).';

-- ------------------------------------------------------------
-- blocks_affected_bookings · turnos que un bloqueo deja "por debajo"
--   Un bloqueo (vacaciones, festivo, hueco suelto) quita horas del desplegable, pero NO toca los turnos ya
--   confirmados: esos siguen en pie hasta que alguien los cancele, los cambie o los avise. Esta vista los lista.
--   · solo turnos confirmados que aún no han terminado
--   · solapan el bloqueo si [inicio, fin) se cruza con [inicio, fin) del bloqueo
--     (que el bloqueo empiece justo cuando acaba el turno NO es un solape)
--   · un bloqueo con service_id vacío afecta a los turnos de todos los servicios
--   · booked_before_block = el turno se reservó antes de crear el bloqueo (lo normal); false = alguien lo dio
--     de alta a mano en el panel DESPUÉS del bloqueo
-- ------------------------------------------------------------
create view public.blocks_affected_bookings with (security_invoker = true) as
select bl.id                                                                   as block_id,
       bl.reason                                                               as block_reason,
       bl.service_id                                                           as block_service_id,
       to_char(bl.starts_at at time zone z.tz, 'YYYY-MM-DD HH24:MI') as block_starts_local,
       to_char(bl.ends_at   at time zone z.tz, 'YYYY-MM-DD HH24:MI') as block_ends_local,
       b.id                                                                    as booking_id,
       b.service_id,
       s.name                                                                  as service_name,
       to_char(b.starts_at at time zone z.tz, 'YYYY-MM-DD HH24:MI') as starts_local,
       b.starts_at,
       b.ends_at,
       b.customer_name,
       b.customer_email,
       b.customer_phone,
       (b.created_at < bl.created_at)                                          as booked_before_block
from public.blocks bl
cross join (select coalesce((select value from public.settings where key = 'timezone'), 'Europe/Madrid') as tz) z   -- (sin app_timezone(): service_role no la ejecuta)
join public.bookings b
  on b.status = 'confirmed'
 and b.ends_at > now()
 and (bl.service_id is null or bl.service_id = b.service_id)
 and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(bl.starts_at, bl.ends_at, '[)')
join public.services s on s.id = b.service_id
order by b.starts_at, bl.starts_at;
comment on view public.blocks_affected_bookings is 'Turnos confirmados y futuros que caen dentro de un bloqueo. Contáctalos para cancelarlos o cambiarles la hora: el bloqueo no los toca.';

-- ------------------------------------------------------------
-- bookings_affected_by · los mismos turnos, ANTES de crear el bloqueo
--   select * from bookings_affected_by(null, '2026-12-24 00:00+01', '2026-12-26 00:00+01');   -- null = todos los servicios
-- ------------------------------------------------------------
create function public.bookings_affected_by(p_service_id uuid, p_starts_at timestamptz, p_ends_at timestamptz)
returns table (booking_id uuid, service_id uuid, service_name text, starts_local text, starts_at timestamptz,
               ends_at timestamptz, customer_name text, customer_email text, customer_phone text)
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  select b.id, b.service_id, s.name,
         to_char(b.starts_at at time zone app_timezone(), 'YYYY-MM-DD HH24:MI'),
         b.starts_at, b.ends_at, b.customer_name, b.customer_email, b.customer_phone
  from public.bookings b
  join public.services s on s.id = b.service_id
  where b.status = 'confirmed'
    and b.ends_at > now()
    and (p_service_id is null or b.service_id = p_service_id)
    and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(p_starts_at, p_ends_at, '[)')
  order by b.starts_at;
$$;
commit;


-- ############################################################
-- ## 20261022000004_fase3_seguridad.sql
-- ############################################################
begin;
-- ============================================================
-- FASE 3 · 0004 · SEGURIDAD de lo nuevo (mismo criterio que las Fases 1 y 2)
--   * RLS en las tablas nuevas y sin políticas; fuera anon y authenticated (también de las vistas).
--   * Funciones nuevas: fuera para todos (incluido PUBLIC) y dentro solo service_role las públicas.
--     Las internas y los triggers solo los usan las públicas o las propias tablas (SECURITY DEFINER).
--   Consecuencia para el contador de clics: desde fuera de n8n NO hay forma de tocarlo (ni por la API de
--   Supabase con la clave anon, ni con un usuario autenticado). Solo quien tiene la clave service_role
--   (las credenciales de n8n) ejecuta register_click(); y el workflow 06 solo la llama tras una visita real.
-- ============================================================

set local search_path = public, extensions;

alter table public.links             enable row level security;
alter table public.link_clicks_daily enable row level security;

revoke all on public.links, public.link_clicks_daily from anon, authenticated;
grant  all on public.links, public.link_clicks_daily to service_role;

revoke all on public.stats_links, public.stats_channels, public.stats_clicks_daily, public.blocks_affected_bookings
  from anon, authenticated;
grant select on public.stats_links, public.stats_channels, public.stats_clicks_daily, public.blocks_affected_bookings
  to service_role;

revoke execute on function
  public._link_destination_error(text),
  public.links_guard(),
  public.bookings_normalize_source(),
  public.create_link(text, text, text),
  public.resolve_link(text),
  public._register_click(text, timestamptz),
  public.register_click(text),
  public.bookings_affected_by(uuid, timestamptz, timestamptz)
from public, anon, authenticated;

grant execute on function
  public.create_link(text, text, text),
  public.resolve_link(text),
  public.register_click(text),
  public.bookings_affected_by(uuid, timestamptz, timestamptz)
to service_role;
commit;
