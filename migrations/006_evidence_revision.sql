CREATE TABLE carbon.case_submission (
    tenant_id uuid NOT NULL,
    org_id uuid NOT NULL,
    case_id uuid NOT NULL,
    revision integer NOT NULL,
    PRIMARY KEY (tenant_id, org_id, case_id, revision),
    FOREIGN KEY (tenant_id, case_id, revision)
        REFERENCES carbon.audit_event(tenant_id, case_id, revision)
);

-- The migration owner must see all historical submissions. This transaction
-- leaves RLS enabled for all other roles and restores FORCE before committing.
ALTER TABLE carbon.audit_event NO FORCE ROW LEVEL SECURITY;
INSERT INTO carbon.case_submission (tenant_id, org_id, case_id, revision)
SELECT tenant_id, org_id, case_id, revision
FROM carbon.audit_event WHERE action = 'submitted';
ALTER TABLE carbon.audit_event FORCE ROW LEVEL SECURITY;

ALTER TABLE carbon.evidence_scan ADD CONSTRAINT evidence_scan_submission_identity
    UNIQUE (tenant_id, org_id, case_id, evidence_id, receipt_id, sha256);

CREATE TABLE carbon.case_submission_evidence (
    tenant_id uuid NOT NULL,
    org_id uuid NOT NULL,
    case_id uuid NOT NULL,
    revision integer NOT NULL,
    evidence_id uuid NOT NULL,
    receipt_id uuid NOT NULL,
    sha256 text NOT NULL,
    PRIMARY KEY (tenant_id, org_id, case_id, revision, evidence_id),
    FOREIGN KEY (tenant_id, org_id, case_id, revision)
        REFERENCES carbon.case_submission(tenant_id, org_id, case_id, revision),
    FOREIGN KEY (tenant_id, org_id, case_id, evidence_id, receipt_id, sha256)
        REFERENCES carbon.evidence_scan(tenant_id, org_id, case_id, evidence_id, receipt_id, sha256)
);

ALTER TABLE carbon.case_submission ENABLE ROW LEVEL SECURITY;
ALTER TABLE carbon.case_submission FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON carbon.case_submission
    USING (tenant_id = (SELECT carbon.tenant_context()))
    WITH CHECK (tenant_id = (SELECT carbon.tenant_context()));
CREATE POLICY actor_submission_read ON carbon.case_submission AS RESTRICTIVE FOR SELECT TO carbon_app
    USING (
        EXISTS (
            SELECT 1 FROM carbon.case_intake AS intake
            WHERE intake.tenant_id = case_submission.tenant_id
              AND intake.org_id = case_submission.org_id
              AND intake.id = case_submission.case_id
        )
    );

ALTER TABLE carbon.case_submission_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE carbon.case_submission_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON carbon.case_submission_evidence
    USING (tenant_id = (SELECT carbon.tenant_context()))
    WITH CHECK (tenant_id = (SELECT carbon.tenant_context()));
CREATE POLICY actor_submission_evidence_read ON carbon.case_submission_evidence AS RESTRICTIVE FOR SELECT TO carbon_app
    USING (
        EXISTS (
            SELECT 1 FROM carbon.case_submission AS submission
            WHERE submission.tenant_id = case_submission_evidence.tenant_id
              AND submission.org_id = case_submission_evidence.org_id
              AND submission.case_id = case_submission_evidence.case_id
              AND submission.revision = case_submission_evidence.revision
        )
    );

CREATE TRIGGER immutable_case_submission
    BEFORE UPDATE OR DELETE ON carbon.case_submission
    FOR EACH ROW EXECUTE FUNCTION carbon.reject_mutation();
CREATE TRIGGER immutable_case_submission_evidence
    BEFORE UPDATE OR DELETE ON carbon.case_submission_evidence
    FOR EACH ROW EXECUTE FUNCTION carbon.reject_mutation();

CREATE OR REPLACE FUNCTION carbon.append_case_audit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
    selected_evidence uuid[];
    attached_count integer;
BEGIN
    INSERT INTO carbon.audit_event (
        tenant_id, org_id, case_id, actor_id, action, reason, revision, request_id, correction_note
    )
    VALUES (
        NEW.tenant_id, NEW.org_id, NEW.id, carbon.actor_context(),
        CASE WHEN TG_OP = 'INSERT' THEN 'created' ELSE NEW.status END,
        NEW.return_reason, NEW.revision, current_setting('carbon.request_id', true),
        CASE WHEN NEW.status = 'submitted' THEN NEW.correction_note END
    );
    IF NEW.status = 'submitted' THEN
        INSERT INTO carbon.case_submission (tenant_id, org_id, case_id, revision)
        VALUES (NEW.tenant_id, NEW.org_id, NEW.id, NEW.revision);

        selected_evidence := nullif(current_setting('carbon.submission_evidence_ids', true), '')::uuid[];
        IF cardinality(selected_evidence) > 0 THEN
            INSERT INTO carbon.case_submission_evidence (
                tenant_id, org_id, case_id, revision, evidence_id, receipt_id, sha256
            )
            SELECT scan.tenant_id, scan.org_id, scan.case_id, NEW.revision, scan.evidence_id, scan.receipt_id, scan.sha256
            FROM carbon.evidence_scan AS scan
            WHERE scan.tenant_id = NEW.tenant_id AND scan.org_id = NEW.org_id AND scan.case_id = NEW.id
              AND scan.evidence_id = ANY(selected_evidence) AND scan.verdict = 'pass';
            GET DIAGNOSTICS attached_count = ROW_COUNT;
            IF attached_count <> cardinality(selected_evidence) THEN
                RAISE EXCEPTION 'Selected evidence is unavailable for submission'
                    USING ERRCODE = '23514', CONSTRAINT = 'submission_evidence_available';
            END IF;
        END IF;
    END IF;
    RETURN NULL;
END;
$$;

GRANT SELECT ON carbon.case_submission, carbon.case_submission_evidence TO carbon_app;
