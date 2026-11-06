-- Capture the confirmed ledger as submitted. A marker distinguishes an empty
-- capture from submissions made before this trigger existed.
CREATE TABLE carbon.case_submission_activity_capture (
    tenant_id uuid NOT NULL,
    org_id uuid NOT NULL,
    case_id uuid NOT NULL,
    submission_revision integer NOT NULL,
    PRIMARY KEY (tenant_id, org_id, case_id, submission_revision),
    FOREIGN KEY (tenant_id, org_id, case_id, submission_revision)
        REFERENCES carbon.case_submission(tenant_id, org_id, case_id, revision)
);

CREATE TABLE carbon.case_submission_activity (
    tenant_id uuid NOT NULL,
    org_id uuid NOT NULL,
    case_id uuid NOT NULL,
    submission_revision integer NOT NULL,
    period date NOT NULL,
    source text NOT NULL,
    activity_revision integer NOT NULL,
    quantity numeric NOT NULL,
    unit text NOT NULL,
    batch_id uuid NOT NULL,
    preview_revision integer NOT NULL,
    source_row integer NOT NULL,
    source_type text NOT NULL,
    conversion_version text NOT NULL,
    original_quantity text NOT NULL,
    original_unit text NOT NULL,
    PRIMARY KEY (tenant_id, org_id, case_id, submission_revision, period, source),
    FOREIGN KEY (tenant_id, org_id, case_id, submission_revision)
        REFERENCES carbon.case_submission_activity_capture(tenant_id, org_id, case_id, submission_revision),
    FOREIGN KEY (tenant_id, org_id, case_id, period, source, activity_revision)
        REFERENCES carbon.activity_record_revision(tenant_id, org_id, case_id, period, source, revision)
);

ALTER TABLE carbon.case_submission_activity_capture ENABLE ROW LEVEL SECURITY;
ALTER TABLE carbon.case_submission_activity_capture FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON carbon.case_submission_activity_capture
    USING (tenant_id = (SELECT carbon.tenant_context()))
    WITH CHECK (tenant_id = (SELECT carbon.tenant_context()));
CREATE POLICY actor_activity_capture_read ON carbon.case_submission_activity_capture
    AS RESTRICTIVE FOR SELECT TO carbon_app
    USING (
        EXISTS (
            SELECT 1 FROM carbon.case_intake AS intake
            WHERE intake.tenant_id = case_submission_activity_capture.tenant_id
              AND intake.org_id = case_submission_activity_capture.org_id
              AND intake.id = case_submission_activity_capture.case_id
              AND (
                  carbon.has_org_role(intake.tenant_id, intake.org_id, 'reviewer')
                  OR (
                      intake.created_by = (SELECT carbon.actor_context())
                      AND carbon.has_org_role(intake.tenant_id, intake.org_id, 'customer')
                  )
              )
        )
    );

ALTER TABLE carbon.case_submission_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE carbon.case_submission_activity FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON carbon.case_submission_activity
    USING (tenant_id = (SELECT carbon.tenant_context()))
    WITH CHECK (tenant_id = (SELECT carbon.tenant_context()));
CREATE POLICY actor_submitted_activity_read ON carbon.case_submission_activity
    AS RESTRICTIVE FOR SELECT TO carbon_app
    USING (
        EXISTS (
            SELECT 1 FROM carbon.case_submission_activity_capture AS capture
            WHERE capture.tenant_id = case_submission_activity.tenant_id
              AND capture.org_id = case_submission_activity.org_id
              AND capture.case_id = case_submission_activity.case_id
              AND capture.submission_revision = case_submission_activity.submission_revision
        )
    );

CREATE TRIGGER immutable_activity_capture
    BEFORE UPDATE OR DELETE ON carbon.case_submission_activity_capture
    FOR EACH ROW EXECUTE FUNCTION carbon.reject_mutation();
CREATE TRIGGER immutable_submitted_activity
    BEFORE UPDATE OR DELETE ON carbon.case_submission_activity
    FOR EACH ROW EXECUTE FUNCTION carbon.reject_mutation();

CREATE FUNCTION carbon.capture_submission_activity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
BEGIN
    -- Import confirmation and submission already serialize on case_intake.
    INSERT INTO carbon.case_submission_activity_capture (tenant_id, org_id, case_id, submission_revision)
    VALUES (NEW.tenant_id, NEW.org_id, NEW.case_id, NEW.revision);

    INSERT INTO carbon.case_submission_activity (
        tenant_id, org_id, case_id, submission_revision, period, source, activity_revision,
        quantity, unit, batch_id, preview_revision, source_row, source_type, conversion_version,
        original_quantity, original_unit
    )
    SELECT DISTINCT ON (entry.period, entry.source)
        entry.tenant_id, entry.org_id, entry.case_id, NEW.revision, entry.period, entry.source, entry.revision,
        entry.quantity, entry.unit, entry.batch_id, entry.preview_revision, entry.source_row,
        entry.source_type, entry.conversion_version, entry.original_quantity, entry.original_unit
    FROM carbon.activity_record_revision AS entry
    WHERE entry.tenant_id = NEW.tenant_id AND entry.org_id = NEW.org_id AND entry.case_id = NEW.case_id
    ORDER BY entry.period, entry.source, entry.revision DESC;
    RETURN NULL;
END;
$$;

CREATE TRIGGER capture_submission_activity
    AFTER INSERT ON carbon.case_submission
    FOR EACH ROW EXECUTE FUNCTION carbon.capture_submission_activity();

REVOKE ALL ON FUNCTION carbon.capture_submission_activity() FROM PUBLIC;
GRANT SELECT ON carbon.case_submission_activity_capture, carbon.case_submission_activity TO carbon_app;
