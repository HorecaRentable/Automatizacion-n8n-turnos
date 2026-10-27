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
