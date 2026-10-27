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
