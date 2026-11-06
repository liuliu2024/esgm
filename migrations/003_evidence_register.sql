-- This register records expected materials, without files or verification.
CREATE TABLE carbon.case_evidence (
    tenant_id uuid NOT NULL,
    org_id uuid NOT NULL,
    case_id uuid NOT NULL,
    id uuid NOT NULL,
    registered_by uuid NOT NULL,
    title text NOT NULL CHECK (length(title) <= 200 AND title ~ '[^[:space:]]'),
    source_description text NOT NULL CHECK (
        length(source_description) <= 1000 AND source_description ~ '[^[:space:]]'
    ),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, org_id, case_id) REFERENCES carbon.case_intake(tenant_id, org_id, id)
);
CREATE INDEX case_evidence_by_case ON carbon.case_evidence (tenant_id, org_id, case_id, created_at, id);

ALTER TABLE carbon.case_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE carbon.case_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON carbon.case_evidence
    USING (tenant_id = (SELECT carbon.tenant_context()))
    WITH CHECK (tenant_id = (SELECT carbon.tenant_context()));

CREATE POLICY actor_evidence_read ON carbon.case_evidence AS RESTRICTIVE FOR SELECT TO carbon_app
    USING (
        EXISTS (
            SELECT 1 FROM carbon.case_intake AS intake
            WHERE intake.tenant_id = case_evidence.tenant_id
              AND intake.org_id = case_evidence.org_id
              AND intake.id = case_evidence.case_id
        )
    );

CREATE FUNCTION carbon.guard_evidence_registration() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
DECLARE
    actor uuid := carbon.actor_context();
    intake_status text;
BEGIN
    IF actor IS NULL OR NEW.tenant_id IS DISTINCT FROM carbon.tenant_context()
       OR NEW.registered_by IS DISTINCT FROM actor
       OR NOT carbon.has_org_role(NEW.tenant_id, NEW.org_id, 'customer') THEN
        RAISE EXCEPTION 'Only an organization customer can register materials as themselves'
            USING ERRCODE = '42501';
    END IF;

    -- Registration and submission use the same intake row, so a material
    -- cannot slip into the register after the intake leaves its writable state.
    SELECT intake.status INTO intake_status
    FROM carbon.case_intake AS intake
    WHERE intake.tenant_id = NEW.tenant_id
      AND intake.org_id = NEW.org_id
      AND intake.id = NEW.case_id
      AND intake.created_by = actor
    FOR SHARE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Only the intake creator may register materials for this intake'
            USING ERRCODE = '42501';
    END IF;
    IF intake_status NOT IN ('draft', 'returned') THEN
        RAISE EXCEPTION 'Materials can only be registered for draft or returned intakes'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER guard_evidence_registration
    BEFORE INSERT ON carbon.case_evidence
    FOR EACH ROW EXECUTE FUNCTION carbon.guard_evidence_registration();
CREATE TRIGGER immutable_evidence_registration
    BEFORE UPDATE OR DELETE ON carbon.case_evidence
    FOR EACH ROW EXECUTE FUNCTION carbon.reject_mutation();

REVOKE ALL ON FUNCTION carbon.guard_evidence_registration() FROM PUBLIC;
GRANT SELECT ON carbon.case_evidence TO carbon_app;
GRANT INSERT (tenant_id, org_id, case_id, id, registered_by, title, source_description)
    ON carbon.case_evidence TO carbon_app;
