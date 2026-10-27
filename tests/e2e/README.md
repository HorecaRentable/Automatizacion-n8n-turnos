# Pruebas de extremo a extremo

Recorren los formularios de n8n con un navegador real, contra la API (PostgREST), la base de datos y un SMTP de captura.
Resultado de la última ejecución: [RESULTADOS-E2E.md](RESULTADOS-E2E.md).

## Montaje (una vez)

1. `cd tests && npm install`
2. Descarga el binario de **PostgREST** de https://github.com/PostgREST/postgrest/releases (probado con 16.5).
   En Windows copia junto a `postgrest.exe` las DLL de `node_modules/@embedded-postgres/windows-x64/native/bin/` (necesita `libpq`).
3. Necesitas Chrome o Edge instalado (variable `BROWSER` para indicar otro ejecutable).
4. n8n 2.x instalado en una carpeta aparte (`npm install n8n@2.44.4`). `n8n-local.mjs` (abajo) monta solo las credenciales, el propietario y los workflows.

## Cada ejecución

```bash
# Terminal 1 · Postgres + migraciones + seed + PostgREST + SMTP de captura (siempre FRESCO: las pruebas usan fechas fijas)
node e2e/stack.mjs ./e2e-work /ruta/a/postgrest        # imprime "STACK LISTO" y escribe e2e-work/stack.json

# Workflows con los valores locales y, SOLO para estas pruebas:
#   --fallback-url http://localhost:5678/respaldo   adónde redirige el workflow 06 si Supabase no responde (E28)
#   --wait-minutes 0.5   esperas cortas de los formularios (E14)
#   --cron "* * * * *"   recordatorios y resumen cada MINUTO en vez de cada 15 (E23-E25)
#   --twins              añade 04b/05b: copias del 04 y el 05 con otro id, que se disparan en el MISMO segundo (E23, E25)
#   --save-success       n8n guarda las ejecuciones correctas de 04/05, para contar que las dos copias corrieron a la vez (E23)
node ../n8n/fuente/build.mjs --out ./e2e-work/wf --supabase-url http://127.0.0.1:54331 \
     --from turnos@local.test --admin admin@local.test --wait-minutes 0.5 --cron "* * * * *" --twins --save-success

# Terminal 2 · n8n propio (carpeta de datos aislada en ./e2e-work/n8n-home): crea el propietario, importa credenciales
# y workflows, los publica y arranca n8n en http://localhost:5678 (no toca ningún n8n que tengas instalado)
node --disable-warning=ExperimentalWarning e2e/n8n-local.mjs ./e2e-work /ruta/donde/hiciste/npm-install-n8n

# Terminal 3
N8N_DB=./e2e-work/n8n-home/.n8n/database.sqlite node --disable-warning=ExperimentalWarning e2e/run-e2e.mjs ./e2e-work
# ONLY=E20,E23 ... para repetir solo algunas (E22 depende de E18)
```

`N8N_DB` lo usan E14 (las ejecuciones abandonadas terminan) y E23 (las dos copias del workflow de recordatorios se dispararon a la vez); sin él E14 falla con un mensaje claro y E23 omite esa comprobación.
La suite completa tarda unos **25 min** (E23–E25 esperan a los workflows programados: ~2, ~4 y ~8 min).
Las pruebas E01/E02 usan fechas de octubre de 2026 y se saltan solas si ya han pasado.

Para simular un fallo de correo basta con crear el archivo `e2e-work/smtp-fail` (E13 lo hace sola). Vacío o con `1`: fallan **todos** los correos; con líneas de texto: fallan solo los correos cuyo destinatario contiene alguna (así E24 hace fallar a un cliente pero deja pasar el aviso al administrador).

**Fase 3:** `stack.mjs` pone `localhost` entre los dominios permitidos (`link_allowed_domains`) para que los enlaces de prueba puedan apuntar a `http://localhost:5678/form/reservar-turno`, y `n8n-local.mjs` crea la credencial *Formulario del equipo* (usuario `equipo`, contraseña `clave-de-prueba-123`). Los enlaces cortos se prueban contra la URL real del webhook (`/webhook/<id>/<slug>`), que es a donde traduce el proxy del dominio corto. **Lanza n8n desde una carpeta sin `.env`** (`n8n-local.mjs` ya lo hace): n8n carga el `.env` del directorio desde el que se lanza; lanzado desde la raíz de este proyecto, las URL de los formularios dejaron de apuntar a `localhost` y las pruebas fallaban.

**Nota para Windows:** si `stack.mjs` no consigue dejar PostgREST en marcha (su log solo dice «Starting PostgREST»), lánzalo tú aparte con `postgrest e2e-work/postgrest.conf`; el resto del entorno funciona igual. E16 lo tumba a propósito: vuelve a lanzarlo antes de otra ejecución, y empieza siempre con la base de datos limpia (reinicia `stack.mjs`).
