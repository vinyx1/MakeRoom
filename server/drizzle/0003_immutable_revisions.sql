-- Revisions are immutable once created, apart from their status and validation bookkeeping: an approval is
-- a click on that exact revision, so its terms must never change underneath it (docs/conflict-model.md §4).
-- The app never updates these; the triggers catch bugs. Deletes stay allowed so a shop reset can cascade.

CREATE FUNCTION "revisions_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - '{status,validated_at,fingerprint}'::text[])
     IS DISTINCT FROM (to_jsonb(OLD) - '{status,validated_at,fingerprint}'::text[]) THEN
    RAISE EXCEPTION 'revision % is immutable; create a new revision instead', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "revisions_immutable"
  BEFORE UPDATE ON "revisions"
  FOR EACH ROW EXECUTE FUNCTION "revisions_immutable"();
--> statement-breakpoint

CREATE FUNCTION "revision_changes_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'revision changes are immutable; create a new revision instead'
    USING ERRCODE = 'check_violation';
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "revision_changes_immutable"
  BEFORE UPDATE ON "revision_changes"
  FOR EACH ROW EXECUTE FUNCTION "revision_changes_immutable"();
