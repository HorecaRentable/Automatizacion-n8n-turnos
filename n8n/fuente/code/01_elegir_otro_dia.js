if ($input.first().json['Otro día'] === undefined) return [];   // formulario abandonado (venció la espera): fin
const prep = $('Preparar página de días').last().json;
const elegido = prep.opciones.find((o) => o.label === $input.first().json['Otro día']) ?? prep.opciones[0];
return [{ json: { data: { ...prep.data, day: elegido.day }, notice: null } }];
