// Prepara la página 1 del formulario: servicios activos (desde Supabase) y, si venimos de un
// reintento por datos no válidos, los datos ya escritos para no perderlos.
const services = $('Cargar servicios').first().json.services ?? [];

let retry = {};
try { if ($('Reintento datos').isExecuted) retry = $('Reintento datos').last().json; } catch (e) { /* primera vez */ }
const p = retry.prefill ?? {};

const fields = [
  { fieldLabel: 'Servicio', fieldType: 'dropdown', requiredField: true,
    defaultValue: p.servicio ?? '',
    fieldOptions: { values: services.map((s) => ({ option: s.name })) } },
  { fieldLabel: 'Día deseado', fieldType: 'date', requiredField: true, defaultValue: p.dia ?? '' },
  { fieldLabel: 'Nombre y apellidos', fieldType: 'text', requiredField: true, placeholder: 'Ana Pérez', defaultValue: p.nombre ?? '' },
  { fieldLabel: 'Correo electrónico', fieldType: 'email', requiredField: true, placeholder: 'ana@ejemplo.com', defaultValue: p.email ?? '' },
  { fieldLabel: 'Teléfono', fieldType: 'text', requiredField: true, placeholder: '+34 600 123 456', defaultValue: p.telefono ?? '' },
  { fieldLabel: 'Privacidad', fieldType: 'checkbox', requiredField: true,
    fieldOptions: { values: [{ option: 'He leído y acepto la política de privacidad' }] } },
];

const description = (retry.error ? `⚠️ ${retry.error}\n\n` : '')
  + 'Usaremos tus datos solo para gestionar tu turno. En el siguiente paso verás las horas libres del día elegido.';

return [{ json: { services, fields, description, hasServices: services.length > 0 } }];
