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
