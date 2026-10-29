-- Constraints Drizzle can't express. See docs/data-model.md §3–4.

CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint

-- Invariant 7: no double-booking. Half-open ranges, so a booking may start exactly when the previous
-- buffer ends. Deferred to commit: a plan's updates can overlap midway (an extension before a shift,
-- or a swap of two bookings).
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_no_overlap"
  EXCLUDE USING gist ("unit_id" WITH =, tstzrange("starts_at", "buffer_ends_at") WITH &&)
  WHERE ("unit_id" IS NOT NULL AND "status" IN ('confirmed', 'picked_up'))
  DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint

-- Invariant 8: a booking, or a slot of unit capacity, belongs to at most one active proposal.
-- Overlaps within one proposal (its options) are allowed.
ALTER TABLE "claims" ADD CONSTRAINT "claims_one_proposal_per_booking"
  EXCLUDE USING gist ("booking_id" WITH =, "proposal_id" WITH <>)
  WHERE ("released_at" IS NULL AND "booking_id" IS NOT NULL);
--> statement-breakpoint

ALTER TABLE "claims" ADD CONSTRAINT "claims_one_proposal_per_capacity"
  EXCLUDE USING gist ("unit_id" WITH =, "period" WITH &&, "proposal_id" WITH <>)
  WHERE ("released_at" IS NULL AND "unit_id" IS NOT NULL);
--> statement-breakpoint

-- Invariant 3 backstop: a picked-up rental never changes unit, and only the owner may shorten it
-- (the app sets rentflow.owner_shorten for that transaction; see allowOwnerShorten in src/db/lock.ts).
-- The validator enforces both first; this catches bugs.
CREATE FUNCTION "bookings_picked_up_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'picked_up' THEN
    IF NEW.unit_id IS DISTINCT FROM OLD.unit_id THEN
      RAISE EXCEPTION 'picked-up booking % cannot change unit', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.ends_at < OLD.ends_at
       AND coalesce(current_setting('rentflow.owner_shorten', true), '') <> 'on' THEN
      RAISE EXCEPTION 'picked-up booking % can only be shortened by the owner', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "bookings_picked_up_guard"
  BEFORE UPDATE ON "bookings"
  FOR EACH ROW EXECUTE FUNCTION "bookings_picked_up_guard"();
