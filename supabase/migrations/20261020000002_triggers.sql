-- ============================================================
-- 0002 · TRIGGERS
-- Mantienen coherentes los datos aunque se editen a mano desde el panel.
-- ============================================================

set local search_path = public, extensions;

-- updated_at automático ---------------------------------------
create function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger services_touch_updated_at
  before update on public.services
  for each row execute function public.touch_updated_at();

-- bookings: normaliza datos, calcula fin/ocupación y marca cancelaciones --
create function public.bookings_prepare()
returns trigger
language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare
  v_svc public.services%rowtype;
begin
  new.customer_email := lower(btrim(new.customer_email));
  new.customer_name  := btrim(new.customer_name);
  new.customer_phone := btrim(new.customer_phone);
  new.updated_at     := now();

  select * into v_svc from public.services where id = new.service_id;
  if found then
    -- Alta a mano desde el panel: basta con inicio; el fin sale de la duración.
    if new.ends_at is null and new.starts_at is not null then
      new.ends_at := new.starts_at + make_interval(mins => v_svc.duration_minutes);
    end if;
    -- El descanso del servicio queda "pegado" al turno.
    if new.occupied_until is null
       or (tg_op = 'UPDATE' and (new.ends_at is distinct from old.ends_at
                                 or new.service_id is distinct from old.service_id)) then
      new.occupied_until := new.ends_at + make_interval(mins => v_svc.break_minutes);
    end if;
  end if;

  if new.status = 'cancelled' then
    new.cancelled_at := coalesce(new.cancelled_at, now());
  else
    new.cancelled_at := null;
  end if;

  return new;
end;
$$;

create trigger bookings_prepare_trg
  before insert or update on public.bookings
  for each row execute function public.bookings_prepare();
