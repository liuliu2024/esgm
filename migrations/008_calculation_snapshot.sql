CREATE TABLE carbon.calculation_snapshot (
    tenant_id uuid NOT NULL,
    org_id uuid NOT NULL,
    case_id uuid NOT NULL,
    id uuid NOT NULL,
    created_by uuid NOT NULL,
    request_id text NOT NULL CHECK (length(btrim(request_id)) BETWEEN 1 AND 200),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    schema_version integer NOT NULL CHECK (schema_version > 0),
    from_period date NOT NULL,
    to_period date NOT NULL,
    input_fingerprint text NOT NULL CHECK (input_fingerprint ~ '^[0-9a-f]{64}$'),
    payload jsonb NOT NULL,
    PRIMARY KEY (tenant_id, org_id, case_id, id),
    UNIQUE (tenant_id, org_id, case_id, input_fingerprint),
    FOREIGN KEY (tenant_id, org_id, case_id) REFERENCES carbon.case_intake(tenant_id, org_id, id),
    CHECK ((extract(day FROM from_period) = 1 AND extract(day FROM to_period) = 1 AND from_period <= to_period) IS TRUE),
    CONSTRAINT complete_synthetic_snapshot CHECK ((
        jsonb_typeof(payload) = 'object'
        AND payload->>'caseId' = case_id::text
        AND payload->>'mode' = 'synthetic'
        AND payload->'formalReportEligible' = 'false'::jsonb
        AND payload#>>'{coverage,status}' = 'complete'
    ) IS TRUE)
);

ALTER TABLE carbon.calculation_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE carbon.calculation_snapshot FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON carbon.calculation_snapshot
    USING (tenant_id = (SELECT carbon.tenant_context()))
    WITH CHECK (tenant_id = (SELECT carbon.tenant_context()));
CREATE POLICY actor_snapshot ON carbon.calculation_snapshot AS RESTRICTIVE TO carbon_app
    USING (
        created_by = (SELECT carbon.actor_context())
        AND carbon.has_org_role(tenant_id, org_id, 'customer')
        AND EXISTS (
            SELECT 1 FROM carbon.case_intake AS intake
            WHERE intake.tenant_id = calculation_snapshot.tenant_id
              AND intake.org_id = calculation_snapshot.org_id
              AND intake.id = calculation_snapshot.case_id
              AND intake.created_by = calculation_snapshot.created_by
        )
    );

CREATE TRIGGER immutable_calculation_snapshot
    BEFORE UPDATE OR DELETE ON carbon.calculation_snapshot
    FOR EACH ROW EXECUTE FUNCTION carbon.reject_mutation();

GRANT SELECT ON carbon.calculation_snapshot TO carbon_app;
GRANT INSERT (tenant_id, org_id, case_id, id, created_by, request_id,
    schema_version, from_period, to_period, input_fingerprint, payload)
    ON carbon.calculation_snapshot TO carbon_app;
