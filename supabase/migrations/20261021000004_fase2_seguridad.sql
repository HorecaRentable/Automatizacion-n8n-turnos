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
