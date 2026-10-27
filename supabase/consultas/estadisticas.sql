-- ============================================================
-- ESTADÍSTICAS DE ENLACES CORTOS · listas para pegar en el SQL Editor de Supabase
--   Requieren las migraciones de la Fase 3 (crean las vistas stats_links, stats_channels y stats_clicks_daily).
--   Son de SOLO LECTURA. Cada consulta es independiente: ejecútalas por separado (seleccionándola) o todas juntas.
--
--   clics         = veces que una PERSONA abrió el enlace corto (no cuentan bots, previsualizaciones de WhatsApp/Slack, etc.)
--   reservas      = turnos creados desde ese enlace, en cualquier estado (también los que se cancelaron después)
--   conversión %  = reservas / clics × 100 (vacío si aún no hay clics)
-- ============================================================

-- 1) CLICS, RESERVAS Y CONVERSIÓN POR ENLACE (todo el histórico)
select slug, channel, active, clicks, bookings, bookings_not_cancelled, bookings_cancelled,
       bookings_attended, bookings_no_show, conversion_pct, last_click_at
from public.stats_links;

-- 2) CONVERSIÓN POR CANAL (todo el histórico)
--    «directo» = reservas sin origen; un canal sin enlace corto (p. ej. ?origen=newsletter escrito a mano) sale con links = 0 y sin conversión
select channel, links, clicks, bookings, bookings_not_cancelled, bookings_cancelled, conversion_pct
from public.stats_channels;

-- 3) CONVERSIÓN POR CANAL EN UN PERIODO (por defecto, los últimos 30 días; cambia «30 as dias»)
--    Los clics se cuentan por día local (link_clicks_daily) y las reservas por el día en que se hicieron (created_at).
--    Una reserva puede ser de un clic de hace unos días: en periodos cortos la tasa es aproximada.
with p as (
  select (now() at time zone coalesce((select value from public.settings where key = 'timezone'), 'Europe/Madrid'))::date as hoy,
         coalesce((select value from public.settings where key = 'timezone'), 'Europe/Madrid')                          as tz,
         30                                                                                                             as dias
),
clics as (
  select coalesce(l.channel, l.slug) as channel, sum(d.clicks)::bigint as clicks
  from public.link_clicks_daily d
  join public.links l on l.id = d.link_id
  cross join p
  where d.day > p.hoy - p.dias
  group by 1
),
reservas as (
  select coalesce(l.channel, l.slug, b.source, 'directo')    as channel,
         count(*)                                            as bookings,
         count(*) filter (where b.status <> 'cancelled')     as bookings_not_cancelled
  from public.bookings b
  left join public.links l on l.slug = b.source
  cross join p
  where (b.created_at at time zone p.tz)::date > p.hoy - p.dias
  group by 1
)
select coalesce(c.channel, r.channel)                         as channel,
       coalesce(c.clicks, 0)                                  as clicks,
       coalesce(r.bookings, 0)                                as bookings,
       coalesce(r.bookings_not_cancelled, 0)                  as bookings_not_cancelled,
       case when coalesce(c.clicks, 0) > 0
            then round(100.0 * coalesce(r.bookings, 0) / c.clicks, 1) end as conversion_pct
from clics c
full join reservas r on r.channel = c.channel
order by coalesce(c.clicks, 0) desc, coalesce(r.bookings, 0) desc, 1;

-- 4) EVOLUCIÓN DIARIA DE CLICS (las 60 filas más recientes)
select day, slug, channel, clicks
from public.stats_clicks_daily
order by day desc, clicks desc
limit 60;

-- 5) RESERVAS POR ORIGEN Y ESTADO (útil para ver cuántas se cancelan o no se presentan por canal)
select coalesce(l.channel, l.slug, b.source, 'directo') as channel, b.status, count(*) as bookings
from public.bookings b
left join public.links l on l.slug = b.source
group by 1, 2
order by 1, 2;

-- 6) ENLACES SIN ACTIVIDAD (creados hace más de 7 días y sin ningún clic)
select slug, channel, created_at
from public.stats_links
where clicks = 0 and created_at < now() - interval '7 days'
order by created_at;

-- 7) COMPROBACIÓN DE INTEGRIDAD (debe devolver 0 filas): el total de un enlace es la suma de sus días
--    (si alguien edita click_count a mano en el panel, aquí saldrá la diferencia)
select l.slug, l.click_count as total, coalesce(sum(d.clicks), 0) as suma_por_dias
from public.links l
left join public.link_clicks_daily d on d.link_id = l.id
group by l.id
having l.click_count <> coalesce(sum(d.clicks), 0);

-- 8) COMPROBACIÓN DE COHERENCIA (debe devolver una fila con diferencia = 0): la suma de reservas de todos los canales = todas las reservas
select (select sum(bookings) from public.stats_channels) as reservas_en_canales,
       (select count(*)     from public.bookings)        as reservas_totales,
       (select sum(bookings) from public.stats_channels) - (select count(*) from public.bookings) as diferencia;
