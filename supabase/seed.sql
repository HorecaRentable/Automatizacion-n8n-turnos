-- ============================================================
-- DATOS DE EJEMPLO · 1 servicio, su horario semanal y 1 bloqueo
-- Ejecutar DESPUÉS de las migraciones. Se puede relanzar sin duplicar.
-- ============================================================

-- Ajusta el correo del administrador y la URL del formulario de cancelación.
update public.settings set value = 'alexandra@rocketnova.io' where key = 'admin_email';
-- update public.settings set value = 'https://TU-N8N/form/cancelar-turno' where key = 'cancel_form_url';
-- Fase 2: formulario de cambio de hora y correo de quien atiende (resumen diario y avisos; vacío = usa admin_email)
-- update public.settings set value = 'https://TU-N8N/form/cambiar-turno' where key = 'reschedule_form_url';
-- update public.settings set value = 'atencion@example.com' where key = 'staff_email';
-- Fase 3: enlaces cortos. El destino de un enlace solo puede estar en estos dominios (y sus subdominios); añade el de tu n8n si es otro.
-- update public.settings set value = 'https://TU-N8N/form/reservar-turno' where key = 'booking_form_url';   -- destino por defecto de un enlace; debe estar en un dominio permitido
-- update public.settings set value = 'rocketnova.io'                      where key = 'link_allowed_domains';
-- update public.settings set value = 'https://l.rocketnova.io'            where key = 'link_base_url';
-- update public.settings set value = 'https://rocketnova.io'              where key = 'link_default_url';

-- Servicio: consulta de 30 min, 10 min de descanso, X = 2 h, Y = 30 días
insert into public.services
  (id, name, description, duration_minutes, break_minutes, min_notice_hours, booking_window_days)
values
  ('11111111-1111-4111-8111-111111111111',
   'Consulta de 30 minutos', 'Consulta individual', 30, 10, 2, 30)
on conflict (id) do nothing;

-- Horario (hora local de Madrid; weekday 1 = lunes ... 7 = domingo)
--   Lunes a jueves: 09:00-14:00 y 16:00-19:00 · Viernes: solo 09:00-14:00 · Fin de semana: cerrado
insert into public.weekly_schedule
  (service_id, weekday, morning_start, morning_end, afternoon_start, afternoon_end)
values
  ('11111111-1111-4111-8111-111111111111', 1, '09:00', '14:00', '16:00', '19:00'),
  ('11111111-1111-4111-8111-111111111111', 2, '09:00', '14:00', '16:00', '19:00'),
  ('11111111-1111-4111-8111-111111111111', 3, '09:00', '14:00', '16:00', '19:00'),
  ('11111111-1111-4111-8111-111111111111', 4, '09:00', '14:00', '16:00', '19:00'),
  ('11111111-1111-4111-8111-111111111111', 5, '09:00', '14:00', null,    null)
on conflict (service_id, weekday) do nothing;

-- Bloqueo global de ejemplo: el próximo miércoles (entre dentro de 2 y 8 días), de 12:00 a 13:00 hora de Madrid
insert into public.blocks (id, service_id, starts_at, ends_at, reason)
select
  '22222222-2222-4222-8222-222222222222',
  null,
  (d + time '12:00') at time zone 'Europe/Madrid',
  (d + time '13:00') at time zone 'Europe/Madrid',
  'Reunión interna (ejemplo)'
from (
  select ((now() at time zone 'Europe/Madrid')::date + g) as d
  from generate_series(2, 8) g
  where extract(isodow from ((now() at time zone 'Europe/Madrid')::date + g)) = 3
) w
on conflict (id) do nothing;
