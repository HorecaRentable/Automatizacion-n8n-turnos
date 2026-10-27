const c = $('Generar correo de cancelación').last().json;
return [{ json: { mensaje: `Tu turno de ${c.service_name} del ${c.fecha} a las ${c.local_time} ha quedado cancelado y el hueco está libre. Te lo hemos confirmado por correo.` } }];
