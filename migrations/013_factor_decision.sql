-- A selection belongs to one submitted revision and records professional judgment only.
CREATE TABLE carbon.case_factor_decision (
    tenant_id uuid NOT NULL,
    org_id uuid NOT NULL,
    case_id uuid NOT NULL,
    submission_revision integer NOT NULL,
    factor_id text NOT NULL,
    factor_version integer NOT NULL,
    decided_by uuid NOT NULL,
    request_id text NOT NULL CHECK (length(request_id) <= 200 AND request_id ~ '[^[:space:]]'),
    method_reference text NOT NULL CHECK (length(method_reference) <= 500 AND method_reference ~ '[^[:space:]]'),
    rationale text NOT NULL CHECK (length(rationale) <= 500 AND rationale ~ '[^[:space:]]'),
    decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, org_id, case_id, submission_revision),
    FOREIGN KEY (tenant_id, org_id, case_id, submission_revision)
        REFERENCES carbon.case_submission(tenant_id, org_id, case_id, revision),
    FOREIGN KEY (factor_id, factor_version)
        REFERENCES catalog.factor_reference_version(factor_id, version)
);

ALTER TABLE carbon.case_factor_decision ENABLE ROW LEVEL SECURITY;
ALTER TABLE carbon.case_factor_decision FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON carbon.case_factor_decision
    USING (tenant_id = (SELECT carbon.tenant_context()))
    WITH CHECK (tenant_id = (SELECT carbon.tenant_context()));

CREATE POLICY actor_factor_decision_read ON carbon.case_factor_decision
    AS RESTRICTIVE FOR SELECT TO carbon_app
    USING (
        EXISTS (
            SELECT 1 FROM carbon.case_intake AS intake
            WHERE intake.tenant_id = case_factor_decision.tenant_id
              AND intake.org_id = case_factor_decision.org_id
              AND intake.id = case_factor_decision.case_id
              AND (
                  carbon.has_org_role(intake.tenant_id, intake.org_id, 'reviewer')
                  OR (
                      intake.created_by = (SELECT carbon.actor_context())
                      AND carbon.has_org_role(intake.tenant_id, intake.org_id, 'customer')
                  )
              )
        )
    );

CREATE FUNCTION carbon.guard_factor_decision() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
DECLARE
    actor uuid := carbon.actor_context();
    intake record;
BEGIN
    IF actor IS NULL OR NEW.tenant_id IS DISTINCT FROM carbon.tenant_context()
       OR NEW.decided_by IS DISTINCT FROM actor
       OR NEW.request_id IS DISTINCT FROM current_setting('carbon.request_id', true)
       OR NOT carbon.has_org_role(NEW.tenant_id, NEW.org_id, 'reviewer') THEN
        RAISE EXCEPTION 'Only the organization reviewer can record a factor decision as themselves'
            USING ERRCODE = '42501';
    END IF;

    SELECT task.created_by, task.status, task.revision INTO intake
    FROM carbon.case_intake AS task
    WHERE task.tenant_id = NEW.tenant_id
      AND task.org_id = NEW.org_id
      AND task.id = NEW.case_id
    FOR SHARE;

    IF NOT FOUND OR intake.created_by = actor THEN
        RAISE EXCEPTION 'A factor decision requires an independent reviewer for the intake'
            USING ERRCODE = '42501';
    END IF;
    IF intake.status <> 'submitted' OR intake.revision <> NEW.submission_revision THEN
        RAISE EXCEPTION 'A factor decision requires the current submitted revision'
            USING ERRCODE = '23514', CONSTRAINT = 'case_factor_decision_submission_state';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER guard_factor_decision
    BEFORE INSERT ON carbon.case_factor_decision
    FOR EACH ROW EXECUTE FUNCTION carbon.guard_factor_decision();
CREATE TRIGGER immutable_factor_decision
    BEFORE UPDATE OR DELETE ON carbon.case_factor_decision
    FOR EACH ROW EXECUTE FUNCTION carbon.reject_mutation();

REVOKE ALL ON FUNCTION carbon.guard_factor_decision() FROM PUBLIC;
GRANT SELECT ON carbon.case_factor_decision TO carbon_app;
GRANT INSERT (
    tenant_id, org_id, case_id, submission_revision, factor_id, factor_version,
    decided_by, request_id, method_reference, rationale
) ON carbon.case_factor_decision TO carbon_app;
