-- Provision a separate login as a member of this role to run the scanner.
DO $bootstrap$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'carbon_scanner') THEN
        CREATE ROLE carbon_scanner NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_roles AS r
        WHERE r.rolname = 'carbon_scanner'
          AND (r.rolcanlogin OR r.rolsuper OR r.rolbypassrls OR r.rolcreatedb
               OR r.rolcreaterole OR r.rolreplication OR EXISTS (
                   SELECT 1 FROM pg_catalog.pg_auth_members AS m WHERE m.member = r.oid
               ))
    ) OR pg_catalog.pg_has_role('carbon_app', 'carbon_scanner', 'MEMBER') THEN
        RAISE EXCEPTION 'carbon_scanner must be a restricted role separate from carbon_app';
    END IF;
END;
$bootstrap$;

ALTER TABLE carbon.evidence_receipt ADD CONSTRAINT evidence_receipt_scan_identity
    UNIQUE (tenant_id, org_id, case_id, evidence_id, id, sha256);

CREATE TABLE carbon.evidence_scan (
    tenant_id uuid NOT NULL,
    org_id uuid NOT NULL,
    case_id uuid NOT NULL,
    evidence_id uuid NOT NULL,
    receipt_id uuid PRIMARY KEY,
    sha256 text NOT NULL,
    verdict text NOT NULL CHECK (verdict IN ('pass', 'rejected')),
    engine text NOT NULL CHECK (length(btrim(engine)) BETWEEN 1 AND 200),
    signature_version text NOT NULL CHECK (length(btrim(signature_version)) BETWEEN 1 AND 200),
    scanned_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (tenant_id, org_id, case_id, evidence_id, receipt_id, sha256)
        REFERENCES carbon.evidence_receipt(tenant_id, org_id, case_id, evidence_id, id, sha256)
);

ALTER TABLE carbon.evidence_scan ENABLE ROW LEVEL SECURITY;
ALTER TABLE carbon.evidence_scan FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON carbon.evidence_scan
    USING (tenant_id = (SELECT carbon.tenant_context()))
    WITH CHECK (tenant_id = (SELECT carbon.tenant_context()));
CREATE POLICY actor_scan_read ON carbon.evidence_scan AS RESTRICTIVE FOR SELECT TO carbon_app
    USING (
        EXISTS (
            SELECT 1 FROM carbon.evidence_receipt AS receipt
            WHERE receipt.id = evidence_scan.receipt_id
        )
    );

CREATE TRIGGER immutable_evidence_scan
    BEFORE UPDATE OR DELETE ON carbon.evidence_scan
    FOR EACH ROW EXECUTE FUNCTION carbon.reject_mutation();

GRANT USAGE ON SCHEMA carbon TO carbon_scanner;
GRANT EXECUTE ON FUNCTION carbon.tenant_context() TO carbon_scanner;
GRANT SELECT ON carbon.evidence_receipt TO carbon_scanner;
GRANT SELECT ON carbon.evidence_scan TO carbon_app, carbon_scanner;
GRANT INSERT (tenant_id, org_id, case_id, evidence_id, receipt_id, sha256, verdict, engine, signature_version)
    ON carbon.evidence_scan TO carbon_scanner;
