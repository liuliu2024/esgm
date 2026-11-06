CREATE TABLE carbon.internal_report_draft (
    tenant_id uuid NOT NULL,
    org_id uuid NOT NULL,
    case_id uuid NOT NULL,
    id uuid NOT NULL,
    snapshot_id uuid NOT NULL,
    template_id text NOT NULL,
    template_version integer NOT NULL CHECK (template_version > 0),
    created_by uuid NOT NULL,
    request_id text NOT NULL CHECK (length(btrim(request_id)) BETWEEN 1 AND 200),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    payload jsonb NOT NULL,
    PRIMARY KEY (tenant_id, org_id, case_id, id),
    UNIQUE (tenant_id, org_id, case_id, snapshot_id, template_id, template_version),
    FOREIGN KEY (tenant_id, org_id, case_id, snapshot_id)
        REFERENCES carbon.calculation_snapshot(tenant_id, org_id, case_id, id),
    CONSTRAINT synthetic_internal_report_draft CHECK ((
        jsonb_typeof(payload) = 'object'
        AND payload->>'caseId' = case_id::text
        AND payload->>'snapshotId' = snapshot_id::text
        AND payload->>'status' = 'draft'
        AND payload->>'mode' = 'synthetic'
        AND payload->'formalReportEligible' = 'false'::jsonb
        AND payload->'externalDeliveryEligible' = 'false'::jsonb
        AND payload#>>'{report,watermark}' = '内部演示｜合成因子｜禁止外发'
    ) IS TRUE)
);

ALTER TABLE carbon.internal_report_draft ENABLE ROW LEVEL SECURITY;
ALTER TABLE carbon.internal_report_draft FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON carbon.internal_report_draft
    USING (tenant_id = (SELECT carbon.tenant_context()))
    WITH CHECK (tenant_id = (SELECT carbon.tenant_context()));
CREATE POLICY actor_report_draft ON carbon.internal_report_draft AS RESTRICTIVE TO carbon_app
    USING (
        created_by = (SELECT carbon.actor_context())
        AND carbon.has_org_role(tenant_id, org_id, 'customer')
        AND EXISTS (
            SELECT 1 FROM carbon.case_intake AS intake
            WHERE intake.tenant_id = internal_report_draft.tenant_id
              AND intake.org_id = internal_report_draft.org_id
              AND intake.id = internal_report_draft.case_id
              AND intake.created_by = internal_report_draft.created_by
        )
    );

CREATE TRIGGER immutable_internal_report_draft
    BEFORE UPDATE OR DELETE ON carbon.internal_report_draft
    FOR EACH ROW EXECUTE FUNCTION carbon.reject_mutation();

GRANT SELECT ON carbon.internal_report_draft TO carbon_app;
GRANT INSERT (tenant_id, org_id, case_id, id, snapshot_id, template_id, template_version,
    created_by, request_id, payload) ON carbon.internal_report_draft TO carbon_app;
