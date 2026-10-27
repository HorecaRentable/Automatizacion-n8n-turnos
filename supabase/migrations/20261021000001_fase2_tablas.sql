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
