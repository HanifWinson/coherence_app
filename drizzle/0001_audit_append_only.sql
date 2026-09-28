-- PRD §8: the audit log is append-only. The API has no update or delete path;
-- this makes the database refuse one too, whoever is connected.
CREATE FUNCTION audit_log_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % is not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER audit_log_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
--> statement-breakpoint
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only();
--> statement-breakpoint
-- The server never receives pixel data, so this is always true. Enforced here
-- rather than trusted to a comment (PRD §8, notes on `cases`).
ALTER TABLE cases ADD CONSTRAINT cases_pixel_data_deleted CHECK (pixel_data_deleted);
