-- This receipt records metadata for a quarantined file, not verified evidence.
ALTER TABLE carbon.case_evidence ADD CONSTRAINT case_evidence_case_identity
    UNIQUE (tenant_id, org_id, case_id, id);

CREATE TABLE carbon.evidence_receipt (
    tenant_id uuid NOT NULL,
    org_id uuid NOT NULL,
    case_id uuid NOT NULL,
    evidence_id uuid NOT NULL,
    id uuid PRIMARY KEY,
    received_by uuid NOT NULL,
    media_type text NOT NULL CHECK (media_type IN ('application/pdf', 'image/png')),
    byte_size integer NOT NULL CHECK (byte_size BETWEEN 1 AND 5242880),
    sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (tenant_id, evidence_id),
    FOREIGN KEY (tenant_id, org_id, case_id, evidence_id)
        REFERENCES carbon.case_evidence(tenant_id, org_id, case_id, id)
);

ALTER TABLE carbon.evidence_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE carbon.evidence_receipt FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON carbon.evidence_receipt
    USING (tenant_id = (SELECT carbon.tenant_context()))
    WITH CHECK (tenant_id = (SELECT carbon.tenant_context()));

CREATE POLICY actor_receipt_read ON carbon.evidence_receipt AS RESTRICTIVE FOR SELECT TO carbon_app
    USING (
        EXISTS (
            SELECT 1 FROM carbon.case_evidence AS evidence
            WHERE evidence.tenant_id = evidence_receipt.tenant_id
              AND evidence.org_id = evidence_receipt.org_id
              AND evidence.case_id = evidence_receipt.case_id
              AND evidence.id = evidence_receipt.evidence_id
        )
    );

CREATE FUNCTION carbon.guard_evidence_receipt() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
DECLARE
    actor uuid := carbon.actor_context();
    intake_status text;
BEGIN
    IF actor IS NULL OR NEW.tenant_id IS DISTINCT FROM carbon.tenant_context()
       OR NEW.received_by IS DISTINCT FROM actor
       OR NOT carbon.has_org_role(NEW.tenant_id, NEW.org_id, 'customer') THEN
        RAISE EXCEPTION 'Only an organization customer can receive materials as themselves'
            USING ERRCODE = '42501';
    END IF;

    -- Match the registration lock so this write and case submission have
    -- the same ordering on the intake row.
    SELECT intake.status INTO intake_status
    FROM carbon.case_intake AS intake
    JOIN carbon.case_evidence AS evidence
      ON evidence.tenant_id = intake.tenant_id AND evidence.org_id = intake.org_id
     AND evidence.case_id = intake.id
    WHERE intake.tenant_id = NEW.tenant_id
      AND intake.org_id = NEW.org_id
      AND intake.id = NEW.case_id
      AND evidence.id = NEW.evidence_id
      AND intake.created_by = actor
    FOR SHARE OF intake;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Only the intake creator may receive its registered material'
            USING ERRCODE = '42501';
    END IF;
    IF intake_status NOT IN ('draft', 'returned') THEN
        RAISE EXCEPTION 'Materials can only be received for draft or returned intakes'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER guard_evidence_receipt
    BEFORE INSERT ON carbon.evidence_receipt
    FOR EACH ROW EXECUTE FUNCTION carbon.guard_evidence_receipt();
CREATE TRIGGER immutable_evidence_receipt
    BEFORE UPDATE OR DELETE ON carbon.evidence_receipt
    FOR EACH ROW EXECUTE FUNCTION carbon.reject_mutation();

REVOKE ALL ON FUNCTION carbon.guard_evidence_receipt() FROM PUBLIC;
GRANT SELECT ON carbon.evidence_receipt TO carbon_app;
GRANT INSERT (tenant_id, org_id, case_id, evidence_id, id, received_by, media_type, byte_size, sha256)
    ON carbon.evidence_receipt TO carbon_app;
