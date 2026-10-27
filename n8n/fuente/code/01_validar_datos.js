// Valida la página 1. (La base de datos vuelve a validar todo al reservar: esto es solo para
// dar un mensaje claro y dejar al usuario corregir sin perder lo escrito.)
const s = $input.first().json;
// Si la persona abandonó la página, al vencer la espera n8n continúa SIN datos del formulario: se termina aquí.
if (s['Servicio'] === undefined && s['Correo electrónico'] === undefined) return [{ json: { ok: false, abandoned: true } }];
const services = $('Preparar página 1').last().json.services ?? [];

const serviceName = String(s['Servicio'] ?? '');
const day = String(s['Día deseado'] ?? '').trim();
const name = String(s['Nombre y apellidos'] ?? '').trim();
const email = String(s['Correo electrónico'] ?? '').trim().toLowerCase();
const phone = String(s['Teléfono'] ?? '').trim();
const privacy = Array.isArray(s['Privacidad']) ? s['Privacidad'].length > 0 : Boolean(s['Privacidad']);

const prefill = { servicio: serviceName, dia: day, nombre: name, email, telefono: phone };
const digits = phone.replace(/\D/g, '').length;
const svc = services.find((x) => x.name === serviceName);

let error = null;
if (!svc) error = 'Elige un servicio de la lista.';
else if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) error = 'Elige un día válido.';
else if (!name || name.length > 120) error = 'Escribe tu nombre.';
else if (email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)) error = 'El correo electrónico no parece válido.';
else if (!/^\+?[0-9][0-9 ().-]{5,24}$/.test(phone) || digits < 7 || digits > 15) error = 'El teléfono no es válido (usa números, espacios y, si quieres, el prefijo +34).';
else if (!privacy) error = 'Para reservar debes aceptar la política de privacidad.';

return [{ json: error
  ? { ok: false, error, prefill }
  : { ok: true, prefill, data: { service_id: svc.id, service_name: svc.name, day, name, email, phone } } }];
