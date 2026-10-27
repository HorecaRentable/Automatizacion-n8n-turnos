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
