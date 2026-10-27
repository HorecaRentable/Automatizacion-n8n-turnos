// Mensaje de «Enlace creado». Todo viene de create_link (destino ya validado), no del formulario.
const r = $input.first().json;
const mensaje = [
  `Tu enlace corto ya funciona:`,
  ``,
  `${r.short_url}`,
  ``,
  `Redirige a: ${r.destination}`,
  `Canal en las estadísticas: ${r.channel}`,
  ``,
  `Las reservas hechas desde este enlace se guardan con origen «${r.slug}».`,
].join('\n');
return [{ json: { mensaje } }];
