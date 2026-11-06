ALTER TABLE carbon.calculation_snapshot
    ADD COLUMN submission_revision integer,
    ADD COLUMN source_submission_key text
        GENERATED ALWAYS AS (coalesce(submission_revision::text, 'synthetic')) STORED,
    ADD CONSTRAINT calculation_snapshot_source_identity
        UNIQUE (tenant_id, org_id, case_id, id, source_submission_key),
    ADD CONSTRAINT calculation_snapshot_factor_decision
        FOREIGN KEY (tenant_id, org_id, case_id, submission_revision)
        REFERENCES carbon.case_factor_decision(tenant_id, org_id, case_id, submission_revision),
    DROP CONSTRAINT complete_synthetic_snapshot,
    ADD CONSTRAINT complete_synthetic_snapshot CHECK ((
        jsonb_typeof(payload) = 'object'
        AND payload->>'caseId' = case_id::text
        AND payload->'formalReportEligible' = 'false'::jsonb
        AND (
            (payload->>'mode' = 'synthetic' AND submission_revision IS NULL
                AND payload#>>'{coverage,status}' = 'complete')
            OR
            (payload->>'mode' = 'controlled' AND submission_revision IS NOT NULL
                AND payload->'submissionRevision' = to_jsonb(submission_revision)
                AND payload->>'scope' = 'purchased_electricity'
                AND payload->'model' = '{"id":"submitted-electricity","version":1}'::jsonb
                AND payload->'externalDeliveryEligible' = 'false'::jsonb
                AND payload#>>'{coverage,status}' IN ('complete', 'partial'))
        )
    ) IS TRUE);

-- The source key is generated on both sides so a draft cannot change its
-- snapshot's mode or claim a different submitted revision.
ALTER TABLE carbon.internal_report_draft
    ADD COLUMN source_submission_key text GENERATED ALWAYS AS (
        CASE WHEN payload->>'mode' = 'controlled'
            THEN payload#>>'{report,scope,submissionRevision}' ELSE 'synthetic' END
    ) STORED,
    DROP CONSTRAINT internal_report_draft_tenant_id_org_id_case_id_snapshot_id_fkey,
    ADD CONSTRAINT internal_report_draft_snapshot_source
        FOREIGN KEY (tenant_id, org_id, case_id, snapshot_id, source_submission_key)
        REFERENCES carbon.calculation_snapshot(tenant_id, org_id, case_id, id, source_submission_key),
    DROP CONSTRAINT synthetic_internal_report_draft,
    ADD CONSTRAINT synthetic_internal_report_draft CHECK ((
        jsonb_typeof(payload) = 'object'
        AND payload->>'caseId' = case_id::text
        AND payload->>'snapshotId' = snapshot_id::text
        AND payload->>'status' = 'draft'
        AND payload->'formalReportEligible' = 'false'::jsonb
        AND payload->'externalDeliveryEligible' = 'false'::jsonb
        AND (
            (payload->>'mode' = 'synthetic'
                AND payload#>>'{report,watermark}' = '内部演示｜合成因子｜禁止外发')
            OR
            (payload->>'mode' = 'controlled'
                AND template_id = 'internal-management-electricity' AND template_version = 1
                AND payload#>>'{template,id}' = template_id
                AND payload#>'{template,version}' = to_jsonb(template_version)
                AND jsonb_typeof(payload#>'{report,scope,submissionRevision}') = 'number'
                AND payload#>'{report,model}' = '{"id":"submitted-electricity","version":1}'::jsonb
                AND payload#>>'{report,watermark}' = '内部管理｜待授权交付')
        )
    ) IS TRUE);

-- Runs after guard_internal_report_review has locked the intake row.
CREATE FUNCTION carbon.guard_internal_report_review_source() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
DECLARE
    report_mode text;
    report_revision text;
    latest_revision integer;
BEGIN
    SELECT draft.payload->>'mode', draft.source_submission_key INTO report_mode, report_revision
    FROM carbon.internal_report_draft AS draft
    WHERE (draft.tenant_id, draft.org_id, draft.case_id, draft.id)
        = (NEW.tenant_id, NEW.org_id, NEW.case_id, NEW.draft_id);

    IF report_mode = 'controlled' THEN
        SELECT max(submission.revision) INTO latest_revision
        FROM carbon.case_submission AS submission
        WHERE (submission.tenant_id, submission.org_id, submission.case_id)
            = (NEW.tenant_id, NEW.org_id, NEW.case_id);

        IF report_revision IS DISTINCT FROM latest_revision::text THEN
            RAISE EXCEPTION 'Controlled report review requires the latest submitted revision'
                USING ERRCODE = '23514', CONSTRAINT = 'internal_report_review_source_revision';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER guard_internal_report_review_source
    BEFORE INSERT OR UPDATE ON carbon.internal_report_review
    FOR EACH ROW EXECUTE FUNCTION carbon.guard_internal_report_review_source();

REVOKE ALL ON FUNCTION carbon.guard_internal_report_review_source() FROM PUBLIC;
GRANT INSERT (submission_revision) ON carbon.calculation_snapshot TO carbon_app;
