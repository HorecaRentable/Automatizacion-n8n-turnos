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
