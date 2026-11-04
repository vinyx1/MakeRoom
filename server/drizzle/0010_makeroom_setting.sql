-- The product is now MakeRoom, so the app sets makeroom.owner_shorten (see allowOwnerShorten in src/db/lock.ts).
-- 0001 created this guard with the old setting name; applied migrations aren't edited, so it's replaced here.
CREATE OR REPLACE FUNCTION "bookings_picked_up_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'picked_up' THEN
    IF NEW.unit_id IS DISTINCT FROM OLD.unit_id THEN
      RAISE EXCEPTION 'picked-up booking % cannot change unit', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.ends_at < OLD.ends_at
       AND coalesce(current_setting('makeroom.owner_shorten', true), '') <> 'on' THEN
      RAISE EXCEPTION 'picked-up booking % can only be shortened by the owner', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
