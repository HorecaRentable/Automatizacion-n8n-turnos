-- ============================================================
-- FASE 3 · 0001 · ENLACES CORTOS: TABLAS, AJUSTES Y VALIDACIÓN DEL DESTINO
-- (Las migraciones de las Fases 1 y 2 no se tocan: todo lo nuevo va aquí.)
--   * links               un enlace corto = un slug (l.rocketnova.io/<slug>) + su destino
--   * link_clicks_daily   clics por enlace y día (local), para ver la evolución
--   * settings            dominios permitidos, URL del formulario de reserva, página por defecto...
--   * _link_destination_error()   ÚNICO sitio donde se decide si un destino es válido (anti redirección abierta)
--   * bookings.source     se normaliza (minúsculas, mismo formato que un slug) o se descarta
-- ============================================================

set local search_path = public, extensions;

-- ------------------------------------------------------------
-- settings · nuevos parámetros (nada hardcodeado en n8n)
-- ------------------------------------------------------------
insert into public.settings (key, value, description) values
  ('booking_form_url',     'https://TU-N8N/form/reservar-turno',
     'URL pública del formulario de reserva (workflow 01). Es el destino por defecto de un enlace corto; se le añade ?origen=<slug>.'),
  ('link_base_url',        'https://l.rocketnova.io',
     'Dominio de los enlaces cortos, sin barra final. Solo sirve para mostrar el enlace creado y para impedir bucles (un destino no puede ser este mismo dominio).'),
  ('link_default_url',     'https://rocketnova.io',
     'Página a la que se redirige cuando el slug no existe o el enlace está desactivado. También debe estar en un dominio permitido.'),
  ('link_allowed_domains', 'rocketnova.io',
     'Dominios a los que puede redirigir un enlace corto (separados por comas o espacios). Un dominio permite también sus subdominios: "rocketnova.io" permite reservas.rocketnova.io. Añade aquí el dominio de tu n8n. Vacío = no se permite ningún destino. Solo https (http únicamente para localhost, para pruebas).')
on conflict (key) do nothing;

-- ------------------------------------------------------------
-- _link_destination_error · ¿es válido este destino? NULL = sí; si no, el código del motivo.
--   DESTINATION_NOT_ALLOWED  forma rara, esquema no permitido o dominio fuera de la lista
--   DESTINATION_LOOP         apunta al propio dominio de los enlaces cortos (redirección infinita)
--   DESTINATION_HAS_ORIGEN   ya lleva un parámetro origen= (lo añade el sistema)
-- Lo usan el trigger de `links` (altas/ediciones desde el panel), create_link() y resolve_link()
-- (que lo vuelve a comprobar en cada clic por si la lista de dominios se acortó después).
--
-- Qué se rechaza antes de mirar el dominio (así no hay trucos con el "host"):
--   · cualquier carácter que no sea ASCII imprimible (espacios, tabulaciones, saltos de línea, Unicode)
--   · @ (credenciales: https://rocketnova.io@evil.com), \ (https://evil.com\.rocketnova.io), < > " ' ` { } | ^
--   · todo lo que no sea  http(s)://host[:puerto][/ruta][?consulta][#fragmento]  (//evil.com, javascript:, data:...)
-- Y el host debe ser EXACTAMENTE un dominio permitido o terminar en ".<dominio permitido>"
-- (rocketnova.io.evil.com y evilrocketnova.io no pasan).
-- ------------------------------------------------------------
create function public._link_destination_error(p_url text)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_m       text[];
  v_scheme  text;
  v_host    text;
  v_base    text[];
begin
  -- (las repeticiones de una expresión regular de Postgres llegan a 255: la longitud se mide aparte)
  if p_url is null or length(p_url) > 2000 or p_url !~ '^[!-~]+$' then
    return 'DESTINATION_NOT_ALLOWED';
  end if;
  if length(translate(p_url, chr(92) || '@<>"`{}|^' || chr(39), '')) <> length(p_url) then
    return 'DESTINATION_NOT_ALLOWED';
  end if;

  v_m := regexp_match(p_url,
    '^(https?)://([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)(?::[0-9]{1,5})?(?:[/?#].*)?$', 'i');
  if v_m is null then
    return 'DESTINATION_NOT_ALLOWED';
  end if;
  v_scheme := lower(v_m[1]);
  v_host   := lower(v_m[2]);

  -- http solo para pruebas en local
  if v_scheme = 'http' and v_host not in ('localhost', '127.0.0.1') then
    return 'DESTINATION_NOT_ALLOWED';
  end if;

  if not exists (
    select 1
    from regexp_split_to_table(lower(coalesce((select value from public.settings where key = 'link_allowed_domains'), '')),
                               '[\s,;]+') as t(raw)
    cross join lateral (select regexp_replace(t.raw, '^\*?\.', '') as d) x
    where x.d ~ '^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$'
      and (position('.' in x.d) > 0 or x.d = 'localhost')          -- nada de "com" o "io" a secas
      and (v_host = x.d or right(v_host, length(x.d) + 1) = '.' || x.d)
  ) then
    return 'DESTINATION_NOT_ALLOWED';
  end if;

  v_base := regexp_match(coalesce((select value from public.settings where key = 'link_base_url'), ''),
                         '^https?://([^/:?#]+)', 'i');
  if v_base is not null and v_host = lower(v_base[1]) then
    return 'DESTINATION_LOOP';
  end if;

  if p_url ~* '[?&]origen=' then
    return 'DESTINATION_HAS_ORIGEN';
  end if;

  return null;
end;
$$;

-- ------------------------------------------------------------
-- links · un enlace corto
-- ------------------------------------------------------------
create table public.links (
  id           uuid primary key default gen_random_uuid(),
  slug         text not null unique,
  destination  text not null,
  channel      text,                                   -- NULL = el canal es el propio slug
  active       boolean not null default true,
  click_count  bigint not null default 0 check (click_count >= 0),
  last_click_at timestamptz,
  created_at   timestamptz not null default now(),
  constraint links_slug_format    check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 40),
  constraint links_channel_format check (channel is null or (channel ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(channel) <= 40))
);
comment on table  public.links              is 'Enlaces cortos (l.rocketnova.io/<slug>). Se crean con el formulario del equipo (workflow 07) o a mano; el contador solo lo sube el workflow 06 vía register_click().';
comment on column public.links.slug         is 'Minúsculas, números y guiones (sin guion al principio, al final ni dobles), 1-40 caracteres. No se puede cambiar: desactiva el enlace y crea otro.';
comment on column public.links.destination  is 'URL completa a la que se redirige. Debe estar en un dominio de settings.link_allowed_domains. Al redirigir se le añade ?origen=<slug>.';
comment on column public.links.channel      is 'Agrupa varios enlaces en un canal para las estadísticas (p. ej. instagram-bio e instagram-stories -> instagram). NULL = el slug.';
comment on column public.links.active       is 'false = el enlace deja de redirigir al destino (va a la página por defecto) y no cuenta clics. Las estadísticas se conservan.';
comment on column public.links.click_count  is 'Clics contados (incremento atómico). No editar a mano.';

-- ------------------------------------------------------------
-- link_clicks_daily · clics por enlace y día LOCAL
-- ------------------------------------------------------------
create table public.link_clicks_daily (
  link_id  uuid   not null references public.links(id) on delete cascade,
  day      date   not null,
  clicks   bigint not null default 0 check (clicks >= 0),
  primary key (link_id, day)
);
comment on table public.link_clicks_daily is 'Clics por enlace y día local. Sube en la misma sentencia que links.click_count, así que las dos cifras siempre coinciden.';

-- ------------------------------------------------------------
-- links_guard · protege también las altas y ediciones a mano desde el panel
-- ------------------------------------------------------------
create function public.links_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_err text;
begin
  if tg_op = 'UPDATE' and new.slug is distinct from old.slug then
    raise exception 'El slug de un enlace no se puede cambiar: desactiva este enlace y crea otro.'
      using errcode = '23000';
  end if;
  if tg_op = 'INSERT' or new.destination is distinct from old.destination then
    new.destination := btrim(new.destination);
    v_err := public._link_destination_error(new.destination);
    if v_err is not null then
      raise exception 'Destino no permitido (%). Revisa settings.link_allowed_domains y que no lleve origen=.', v_err
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

-- Solo al crear o al tocar slug/destino: el incremento de clics (click_count) no lo dispara.
create trigger links_guard
  before insert or update of slug, destination on public.links
  for each row execute function public.links_guard();

-- ------------------------------------------------------------
-- bookings.source · solo valores con forma de slug
--   La reserva NUNCA falla por un origen raro: se guarda en minúsculas si tiene formato de slug
--   (a-z, 0-9, guiones, hasta 40) y si no, se descarta (NULL). Así nadie ensucia las estadísticas
--   ni bloquea una reserva escribiendo cualquier cosa en ?origen=
-- ------------------------------------------------------------
create function public.bookings_normalize_source()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.source is not null then
    new.source := lower(btrim(new.source));
    if new.source = '' or length(new.source) > 40 or new.source !~ '^[a-z0-9]+(-[a-z0-9]+)*$' then
      new.source := null;
    end if;
  end if;
  return new;
end;
$$;

create trigger bookings_normalize_source
  before insert or update of source on public.bookings
  for each row execute function public.bookings_normalize_source();
