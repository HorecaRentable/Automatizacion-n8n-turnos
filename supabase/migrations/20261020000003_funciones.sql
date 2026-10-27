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
