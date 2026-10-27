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
