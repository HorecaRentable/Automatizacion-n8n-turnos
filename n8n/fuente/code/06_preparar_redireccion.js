// Decide a dónde redirigir y si este clic cuenta. La redirección NUNCA espera al recuento (va después, ver workflow 06).
//   · resolve_link ya devuelve un destino VALIDADO (dominio permitido + origen=<slug>); aquí no se construye ni se toca ninguna URL.
//   · Si Supabase no responde, se redirige a la página de respaldo de «Configuración»: nadie se queda sin redirección.
//   · Si resolve_link responde pero no hay ni página por defecto válida (url = null), no hay Location: se responde 404.
//   · Cuenta solo si el enlace existe (found) y la visita parece de una persona: a los previsualizadores de enlaces,
//     rastreadores, monitores y herramientas de línea de comandos se les redirige igual (la vista previa funciona), pero no suman.
const r = $input.first().json;
const conf = $('Configuración').first().json;
const req = $('Enlace corto').first().json;
const ua = String(req.headers?.['user-agent'] ?? '');

const BOT = /bot\b|crawler|spider|slurp|preview|facebookexternalhit|facebot|embedly|bitlybot|whatsapp\/|telegrambot|skypeuripreview|discordbot|slackbot|twitterbot|linkedinbot|pinterest|vkshare|headlesschrome|phantomjs|lighthouse|curl\/|wget\/|python-requests|python-urllib|go-http-client|java\/|okhttp\/|libwww|httpclient|axios\/|node-fetch|undici|^node$|monitor|uptime|pingdom|statuscake/i;
const human = ua.length > 0 && !BOT.test(ua);

const respondio = r && r.ok === true && !r.error;       // false = Supabase caído / error de red
let location = respondio ? (r.url ?? null) : conf.url_respaldo;
// Última barrera (el SQL ya lo garantiza): solo http(s) y caracteres imprimibles, nunca saltos de línea en la cabecera
if (location !== null && !/^https?:\/\/[!-~]+$/.test(String(location))) location = null;

return [{ json: {
  location,
  slug: respondio && r.found === true ? r.slug : null,
  count: respondio && r.found === true && human && location !== null,
  human,
} }];
