# Configurar el dominio de los enlaces cortos (l.rocketnova.io)

Objetivo: que `https://l.rocketnova.io/instagram` llegue al workflow **06 · Enlaces cortos** de n8n y la persona acabe en el formulario de reserva.
Qué hace cada pieza: [FASE3.md](FASE3.md) · Instalación general: [INSTALACION.md](INSTALACION.md).

## 1. Por qué hace falta algo más que un registro DNS

n8n publica el webhook en una ruta larga, no en `/instagram`:

```
https://TU-N8N/webhook/6f1d2c4e-0a7b-4c1e-9d55-7a3e5b9c1f06/instagram
                         └────────── identificador fijo del workflow 06 ──────────┘ └ slug
```

Un DNS (CNAME o A) solo apunta el nombre `l.rocketnova.io` a un servidor: **no cambia la ruta**. Entre el dominio corto y n8n tiene que haber algo que **traduzca `/<slug>` a `/webhook/<id>/<slug>`**: un proxy inverso (Nginx, Caddy…) o una regla/worker de Cloudflare. Tampoco sirve «dominio personalizado de n8n Cloud»: n8n Cloud no deja poner otro dominio a los webhooks, así que allí la opción es Cloudflare (sección 4).

```
persona ──https──▶ l.rocketnova.io/instagram
                      │  DNS: l → proxy (o CDN)          1. DNS
                      ▼
                   proxy: reescribe /instagram → /webhook/<id>/instagram   2. proxy
                      │  solo deja pasar GET /<slug>; limita peticiones
                      ▼
                   n8n (workflow 06) ──302──▶ https://…/form/reservar-turno?origen=instagram
```

> **Qué NO hacer:** reenviar *todo* `l.rocketnova.io` a n8n. Expondría `/form/…`, `/rest/…` y el editor en el dominio corto. El proxy debe aceptar **solo** rutas con forma de slug y devolver 404 al resto.

## 2. Antes de empezar

1. **Workflow 06 publicado (Active)** y workflow 07 si vas a crear enlaces desde el formulario.
2. **`WEBHOOK_URL`** de n8n = su URL pública (`https://n8n.rocketnova.io/`). Sin ella, los formularios de n8n apuntan a la URL equivocada.
3. **El identificador del webhook.** Va fijo en el JSON del workflow (`6f1d2c4e-0a7b-4c1e-9d55-7a3e5b9c1f06`). Compruébalo en n8n: abre el workflow 06 → nodo **Enlace corto** → *Production URL*: debe terminar en `/webhook/<id>/:slug`. Si tu n8n muestra otro `<id>` (a veces pasa al importar por la interfaz), usa **ese** en los ejemplos de abajo.
4. En Supabase, tabla `settings`:

| Clave | Qué poner |
|---|---|
| `link_base_url` | `https://l.rocketnova.io` (para mostrar el enlace creado y evitar bucles) |
| `link_allowed_domains` | `rocketnova.io` (permite también sus subdominios: el dominio de tu n8n y tu web) |
| `link_default_url` | página a la que va quien abre un slug que no existe (p. ej. `https://rocketnova.io`) |
| `booking_form_url` | `https://TU-N8N/form/reservar-turno` (destino por defecto de un enlace nuevo) |

5. En el nodo **Configuración** del workflow 06: `url_respaldo` = adónde redirigir **solo si Supabase no responde** (por defecto `https://rocketnova.io`).

## 3. DNS

Un registro para el subdominio, en el panel de DNS de `rocketnova.io`:

| Tipo | Nombre | Valor | Cuándo |
|---|---|---|---|
| `A` | `l` | IP del servidor del proxy | proxy propio (Nginx/Caddy) en una IP fija |
| `CNAME` | `l` | `proxy.rocketnova.io.` (o el host del proxy) | el proxy ya tiene nombre |
| `CNAME`/`A` **con proxy activado (nube naranja)** | `l` | cualquier valor válido (p. ej. el de `n8n.rocketnova.io`) | Cloudflare (sección 4) |

Después, el **certificado HTTPS** para `l.rocketnova.io` (Caddy lo saca solo; con Nginx: `certbot --nginx -d l.rocketnova.io`; en Cloudflare, el que ofrece). **Sin HTTPS no se debe usar**: las redirecciones sin cifrar se pueden manipular por el camino.

## 4. El proxy: tres opciones (elige una)

> En esta entrega **se probó el webhook al que traducen estas reglas** (`/webhook/<id>/<slug>`: redirección, cuenta, bots, slugs raros…, ver [PRUEBAS.md](PRUEBAS.md)). **No se probaron** estas configuraciones de Nginx/Caddy/Cloudflare contra un dominio real: revisa el resultado con la lista de la sección 5.

### Opción A · Nginx (n8n en el mismo servidor)

En el bloque `http {}` (una vez):

```nginx
limit_req_zone $binary_remote_addr zone=enlaces:10m rate=10r/s;
```

Un `server` nuevo (ajusta rutas del certificado):

```nginx
server {
    listen 443 ssl http2;
    server_name l.rocketnova.io;
    ssl_certificate     /etc/letsencrypt/live/l.rocketnova.io/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/l.rocketnova.io/privkey.pem;

    # l.rocketnova.io/  → tu web
    location = / { return 302 https://rocketnova.io; }

    # l.rocketnova.io/<slug>  → webhook del workflow 06 (solo letras, números y guiones, hasta 40)
    location ~ "^/(?<slug>[A-Za-z0-9-]{1,40})$" {
        limit_req zone=enlaces burst=20 nodelay;       # frena a quien machaca el enlace (infla clics)
        limit_except GET { deny all; }
        proxy_pass http://127.0.0.1:5678/webhook/6f1d2c4e-0a7b-4c1e-9d55-7a3e5b9c1f06/$slug;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-For   $remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_redirect off;                            # el Location que devuelve n8n pasa tal cual
    }

    # todo lo demás (/form, /rest, /healthz…) NO existe en este dominio
    location / { return 404; }
}
```

Si n8n está en **otro servidor** con HTTPS, cambia el `proxy_pass` por `https://n8n.rocketnova.io/webhook/<id>/$slug`, y añade `resolver 1.1.1.1;` y `proxy_ssl_server_name on;` (con variable en el `proxy_pass`, Nginx necesita resolver el nombre él mismo).

### Opción B · Caddy (HTTPS automático)

```caddy
l.rocketnova.io {
    @slug path_regexp slug ^/([A-Za-z0-9-]{1,40})$
    handle @slug {
        rewrite * /webhook/6f1d2c4e-0a7b-4c1e-9d55-7a3e5b9c1f06/{re.slug.1}
        reverse_proxy 127.0.0.1:5678
    }
    handle / {
        redir https://rocketnova.io 302
    }
    handle {
        respond "No encontrado" 404
    }
}
```
(Para limitar peticiones por IP en Caddy hace falta el módulo `caddy-ratelimit` o hacerlo en el cortafuegos/Cloudflare.)

### Opción C · Cloudflare (sirve también con n8n Cloud)

1. DNS: registro `l` **con el proxy activado** (nube naranja).
2. *Workers & Pages → Create Worker*, con este código, y en *Settings → Variables* define `N8N_HOST` (`n8n.rocketnova.io` o el `xxx.app.n8n.cloud`) y `WEBHOOK_ID` (`6f1d2c4e-0a7b-4c1e-9d55-7a3e5b9c1f06`):

```js
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/') return Response.redirect('https://rocketnova.io', 302);
    const m = url.pathname.match(/^\/([A-Za-z0-9-]{1,40})$/);
    if (!m) return new Response('No encontrado', { status: 404 });
    if (request.method !== 'GET') return new Response('Método no permitido', { status: 405 });
    return fetch(`https://${env.N8N_HOST}/webhook/${env.WEBHOOK_ID}/${m[1]}`, {
      method: 'GET',
      headers: { 'user-agent': request.headers.get('user-agent') ?? '' },   // n8n lo usa para no contar bots
      redirect: 'manual',                                                   // deja pasar el 302 tal cual
    });
  },
};
```
3. *Workers Routes*: ruta `l.rocketnova.io/*` → ese Worker.
4. *Security → WAF → Rate limiting rules*: p. ej. 30 peticiones por minuto por IP a `l.rocketnova.io`.

## 5. Comprobar que funciona (2 minutos)

```bash
# (curl -I hace una petición HEAD, que el webhook no atiende: usa GET y muestra solo las cabeceras)

# 1) un enlace que existe: 302 al formulario, con ?origen= y sin caché  (¡esta visita SÍ suma un clic: lleva un User-Agent de móvil!)
curl -s -o /dev/null -D - -A "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1" https://l.rocketnova.io/instagram
#   HTTP/2 302
#   location: https://TU-N8N/form/reservar-turno?origen=instagram
#   cache-control: no-store

# 2) un slug que no existe: 302 a la página por defecto (link_default_url) y no suma nada
curl -s -o /dev/null -D - -A "Mozilla/5.0 (iPhone) Safari/604.1" https://l.rocketnova.io/no-existe

# 3) rutas que no son un slug: 404 del proxy (no llegan a n8n)
curl -s -o /dev/null -w "%{http_code}
" https://l.rocketnova.io/form/reservar-turno      # 404
curl -s -o /dev/null -w "%{http_code}
" https://l.rocketnova.io/rest/v1/links             # 404
```

Y en Supabase, tras la visita 1 (o tras abrir el enlace con tu navegador; las peticiones con User-Agent de `curl`, bots o previsualizadores **no suman**):

```sql
select slug, clicks, last_click_at from stats_links where slug = 'instagram';   -- clics +1, una sola vez
```

## 6. Si algo no va

| Síntoma | Causa probable |
|---|---|
| 404 de n8n («webhook … is not registered») | el workflow 06 no está publicado, o el `<id>` del proxy no es el de tu n8n (ver 2.3) |
| El proxy devuelve 404 para un slug válido | el slug tiene más de 40 caracteres o lleva algo distinto de letras, números y guiones |
| Redirige siempre a la página por defecto | el slug no existe o está desactivado (`links.active`), o su destino ya no está en `link_allowed_domains` |
| Redirige al «respaldo» (`url_respaldo`) | n8n no pudo hablar con Supabase en ese momento: mira *Executions* del workflow 06 |
| No suma ningún clic | pruebas con `curl`/navegador sin interfaz (se descartan como bots); o `resolve_link` falla (mira *Executions*) |
| Cuenta de más | revisa el límite de peticiones del proxy; las visitas repetidas de una misma persona sí suman |
| Los formularios de n8n apuntan a `localhost` o a otra URL | falta `WEBHOOK_URL` en n8n |
