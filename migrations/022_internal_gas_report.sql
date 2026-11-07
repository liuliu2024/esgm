ALTER TABLE carbon.model_trial_snapshot
    ADD CONSTRAINT model_trial_snapshot_submission_identity
        UNIQUE (tenant_id, org_id, case_id, submission_revision, id);

ALTER TABLE carbon.internal_report_draft
    ALTER COLUMN snapshot_id DROP NOT NULL,
    ADD COLUMN trial_snapshot_id uuid,
    ADD COLUMN trial_submission_revision integer GENERATED ALWAYS AS (
        CASE WHEN payload->>'mode' = 'internal_trial' THEN (payload#>>'{report,scope,submissionRevision}')::integer END
    ) STORED,
    ADD CONSTRAINT internal_report_draft_trial_snapshot_source
        FOREIGN KEY (tenant_id, org_id, case_id, trial_submission_revision, trial_snapshot_id)
        REFERENCES carbon.model_trial_snapshot(tenant_id, org_id, case_id, submission_revision, id),
    ADD CONSTRAINT internal_report_draft_trial_template
        UNIQUE (tenant_id, org_id, case_id, trial_snapshot_id, template_id, template_version),
    DROP CONSTRAINT synthetic_internal_report_draft,
    ADD CONSTRAINT synthetic_internal_report_draft CHECK ((
        jsonb_typeof(payload) = 'object'
        AND payload->>'caseId' = case_id::text
        AND payload->>'status' = 'draft'
        AND payload->'formalReportEligible' = 'false'::jsonb
        AND payload->'externalDeliveryEligible' = 'false'::jsonb
        AND (
            (snapshot_id IS NOT NULL AND trial_snapshot_id IS NULL
                AND payload->>'snapshotId' = snapshot_id::text
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
                ))
            OR
            (snapshot_id IS NULL AND trial_snapshot_id IS NOT NULL AND trial_submission_revision IS NOT NULL
                AND payload->>'snapshotId' = trial_snapshot_id::text
                AND payload#>'{report,scope,submissionRevision}' = to_jsonb(trial_submission_revision)
                AND payload->>'mode' = 'internal_trial'
                AND template_id = 'internal-management-gas-combustion' AND template_version = 1
                AND payload#>>'{template,id}' = template_id
                AND payload#>'{template,version}' = to_jsonb(template_version)
                AND payload#>>'{report,model,id}' = 'power-gas-combustion-2026'
                AND payload#>'{report,model,version}' = '1'::jsonb
                AND payload#>>'{report,watermark}' = '内部试算｜禁止外发')
        )
    ) IS TRUE);

-- The original review guard already serializes this check with case transitions.
CREATE OR REPLACE FUNCTION carbon.guard_internal_report_review_source() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
DECLARE
    report_mode text;
    report_revision text;
    latest_revision integer;
BEGIN
    SELECT draft.payload->>'mode', coalesce(draft.trial_submission_revision::text, draft.source_submission_key)
    INTO report_mode, report_revision
    FROM carbon.internal_report_draft AS draft
    WHERE (draft.tenant_id, draft.org_id, draft.case_id, draft.id)
        = (NEW.tenant_id, NEW.org_id, NEW.case_id, NEW.draft_id);

    IF report_mode IN ('controlled', 'internal_trial') THEN
        SELECT max(submission.revision) INTO latest_revision
        FROM carbon.case_submission AS submission
        WHERE (submission.tenant_id, submission.org_id, submission.case_id)
            = (NEW.tenant_id, NEW.org_id, NEW.case_id);

        IF report_revision IS DISTINCT FROM latest_revision::text THEN
            RAISE EXCEPTION 'Report review requires the latest submitted revision'
                USING ERRCODE = '23514', CONSTRAINT = 'internal_report_review_source_revision';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

GRANT INSERT (trial_snapshot_id) ON carbon.internal_report_draft TO carbon_app;
