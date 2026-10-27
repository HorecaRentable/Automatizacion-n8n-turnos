-- ============================================================
-- BLOQUEOS (vacaciones, festivos, huecos sueltos) · consultas para el SQL Editor de Supabase
--   Un bloqueo quita horas del desplegable de reserva. NO toca los turnos que ya estaban confirmados dentro de él:
--   siguen en pie hasta que alguien los cancele o los cambie. Estas consultas sirven para encontrarlos.
--   Requieren las migraciones de la Fase 3. Son de solo lectura (salvo el INSERT comentado del punto 4).
-- ============================================================

-- 1) TURNOS AFECTADOS POR ALGÚN BLOQUEO (confirmados y todavía no terminados). Si devuelve filas, hay gente a la que avisar.
select block_reason, block_starts_local, block_ends_local, service_name, starts_local,
       customer_name, customer_email, customer_phone, booked_before_block
from public.blocks_affected_bookings;

-- 2) LO MISMO, PERO ANTES DE CREAR EL BLOQUEO: ¿a quién afectaría?
--    null = todos los servicios; o el id de un servicio. Las horas son de Madrid (cambia el texto de las fechas).
select * from public.bookings_affected_by(
  null,
  '2026-12-24 00:00 Europe/Madrid'::timestamptz,
  '2026-12-27 00:00 Europe/Madrid'::timestamptz);

-- 3) BLOQUEOS VIGENTES O FUTUROS (qué servicio afectan y cuántos turnos confirmados tienen debajo)
select b.id,
       coalesce(s.name, '(todos los servicios)')                              as servicio,
       to_char(b.starts_at at time zone 'Europe/Madrid', 'YYYY-MM-DD HH24:MI') as desde_madrid,
       to_char(b.ends_at   at time zone 'Europe/Madrid', 'YYYY-MM-DD HH24:MI') as hasta_madrid,
       b.reason,
       (select count(*) from public.blocks_affected_bookings a where a.block_id = b.id) as turnos_afectados
from public.blocks b
left join public.services s on s.id = b.service_id
where b.ends_at > now()
order by b.starts_at;

-- 4) CREAR UN BLOQUEO CON HORA DE MADRID (descomenta y adapta; el rango es [desde, hasta): «hasta» ya no está bloqueado)
--    · Un día entero (festivo):   desde las 00:00 de ese día hasta las 00:00 del siguiente
--    · Vacaciones:                desde las 00:00 del primer día hasta las 00:00 del día DESPUÉS del último
--    · Hueco suelto:              con horas, p. ej. de 11:15 a 12:05
--    · service_id vacío = afecta a todos los servicios
-- insert into public.blocks (service_id, starts_at, ends_at, reason) values
--   (null, ('2026-12-24'::date + time '00:00') at time zone 'Europe/Madrid', ('2026-12-27'::date + time '00:00') at time zone 'Europe/Madrid', 'Navidad');

-- 5) COMPROBAR QUE EL BLOQUEO FUNCIONA: horas libres de un día para un servicio (las que verá la persona en el desplegable)
select local_time
from public.get_available_slots((select id from public.services where active order by name limit 1), (current_date + 7))
order by slot_start;
