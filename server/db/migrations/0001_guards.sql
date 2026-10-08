-- Append-only history: events and meter_changes reject UPDATE and DELETE,
-- except when the change arrives through a foreign-key cascade (trigger depth > 1),
-- so deleting a world or faction still cleans up after itself.
CREATE OR REPLACE FUNCTION atlas_append_only() RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER events_append_only BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION atlas_append_only();
--> statement-breakpoint
CREATE TRIGGER meter_changes_append_only BEFORE UPDATE OR DELETE ON meter_changes
  FOR EACH ROW EXECUTE FUNCTION atlas_append_only();
