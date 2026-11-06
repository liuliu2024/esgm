CREATE TABLE carbon.internal_report_review (
    tenant_id uuid NOT NULL,
    org_id uuid NOT NULL,
    case_id uuid NOT NULL,
    draft_id uuid NOT NULL,
    status text NOT NULL DEFAULT 'submitted',
    submitted_by uuid NOT NULL,
    submitted_request_id text NOT NULL CHECK (length(btrim(submitted_request_id)) BETWEEN 1 AND 200),
    submitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    reviewed_by uuid,
    reviewed_request_id text CHECK (length(btrim(reviewed_request_id)) BETWEEN 1 AND 200),
    reviewed_at timestamptz,
    reason text,
    PRIMARY KEY (tenant_id, org_id, case_id, draft_id),
    FOREIGN KEY (tenant_id, org_id, case_id, draft_id)
        REFERENCES carbon.internal_report_draft(tenant_id, org_id, case_id, id),
    CONSTRAINT internal_report_review_transition CHECK (
        (status = 'submitted' AND reviewed_by IS NULL AND reviewed_request_id IS NULL AND reviewed_at IS NULL)
        OR (status IN ('reviewed', 'returned') AND reviewed_by IS NOT NULL AND reviewed_by <> submitted_by
            AND reviewed_request_id IS NOT NULL AND reviewed_at IS NOT NULL)
    ),
    CONSTRAINT internal_report_review_reason CHECK (
        (status <> 'returned' OR reason IS NOT NULL)
        AND (reason IS NULL OR (status <> 'submitted' AND length(reason) <= 500 AND reason ~ '[^[:space:]]'))
    )
);

ALTER TABLE carbon.internal_report_review ENABLE ROW LEVEL SECURITY;
ALTER TABLE carbon.internal_report_review FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON carbon.internal_report_review
    USING (tenant_id = (SELECT carbon.tenant_context()))
    WITH CHECK (tenant_id = (SELECT carbon.tenant_context()));
CREATE POLICY actor_review_read ON carbon.internal_report_review AS RESTRICTIVE FOR SELECT TO carbon_app
    USING (
        (submitted_by = (SELECT carbon.actor_context()) AND carbon.has_org_role(tenant_id, org_id, 'customer'))
        OR (submitted_by <> (SELECT carbon.actor_context()) AND carbon.has_org_role(tenant_id, org_id, 'reviewer'))
    );
CREATE POLICY actor_review_submit ON carbon.internal_report_review AS RESTRICTIVE FOR INSERT TO carbon_app
    WITH CHECK (
        submitted_by = (SELECT carbon.actor_context()) AND carbon.has_org_role(tenant_id, org_id, 'customer')
    );
CREATE POLICY actor_review_decide ON carbon.internal_report_review AS RESTRICTIVE FOR UPDATE TO carbon_app
    USING (
        submitted_by <> (SELECT carbon.actor_context()) AND carbon.has_org_role(tenant_id, org_id, 'reviewer')
    )
    WITH CHECK (
        reviewed_by = (SELECT carbon.actor_context()) AND carbon.has_org_role(tenant_id, org_id, 'reviewer')
    );

-- Draft visibility depends on the submitted review. Review policies depend only
-- on actors and organization grants so this lookup does not recurse.
ALTER POLICY actor_report_draft ON carbon.internal_report_draft
    USING (
        (
            created_by = (SELECT carbon.actor_context())
            AND carbon.has_org_role(tenant_id, org_id, 'customer')
            AND EXISTS (
                SELECT 1 FROM carbon.case_intake AS intake
                WHERE intake.tenant_id = internal_report_draft.tenant_id
                  AND intake.org_id = internal_report_draft.org_id
                  AND intake.id = internal_report_draft.case_id
                  AND intake.created_by = internal_report_draft.created_by
            )
        )
        OR (
            carbon.has_org_role(tenant_id, org_id, 'reviewer')
            AND EXISTS (
                SELECT 1 FROM carbon.internal_report_review AS review
                WHERE review.tenant_id = internal_report_draft.tenant_id
                  AND review.org_id = internal_report_draft.org_id
                  AND review.case_id = internal_report_draft.case_id
                  AND review.draft_id = internal_report_draft.id
                  AND review.submitted_by <> (SELECT carbon.actor_context())
            )
        )
    )
    WITH CHECK (
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

CREATE FUNCTION carbon.guard_internal_report_review() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
DECLARE
    actor uuid := carbon.actor_context();
    request_id text := current_setting('carbon.request_id', true);
    applicant uuid;
    intake_status text;
BEGIN
    IF actor IS NULL OR NEW.tenant_id IS DISTINCT FROM carbon.tenant_context() THEN
        RAISE EXCEPTION 'Workspace and actor context are required' USING ERRCODE = '42501';
    END IF;

    SELECT intake.created_by, intake.status INTO applicant, intake_status
    FROM carbon.case_intake AS intake
    WHERE intake.tenant_id = NEW.tenant_id AND intake.org_id = NEW.org_id AND intake.id = NEW.case_id
    FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Report intake is not visible' USING ERRCODE = '42501';
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF applicant <> actor OR NEW.submitted_by <> actor
           OR NOT carbon.has_org_role(NEW.tenant_id, NEW.org_id, 'customer') THEN
            RAISE EXCEPTION 'Only the task creator can submit the report draft' USING ERRCODE = '42501';
        END IF;
        IF NEW.status <> 'submitted' OR NEW.submitted_request_id IS DISTINCT FROM request_id THEN
            RAISE EXCEPTION 'A report review must begin as submitted'
                USING ERRCODE = '23514', CONSTRAINT = 'internal_report_review_transition';
        END IF;
    ELSE
        IF (NEW.tenant_id, NEW.org_id, NEW.case_id, NEW.draft_id, NEW.submitted_by, NEW.submitted_request_id, NEW.submitted_at)
           IS DISTINCT FROM
           (OLD.tenant_id, OLD.org_id, OLD.case_id, OLD.draft_id, OLD.submitted_by, OLD.submitted_request_id, OLD.submitted_at) THEN
            RAISE EXCEPTION 'The report submission identity is immutable' USING ERRCODE = '55000';
        END IF;
        IF applicant = actor OR NEW.reviewed_by IS DISTINCT FROM actor
           OR NOT carbon.has_org_role(NEW.tenant_id, NEW.org_id, 'reviewer') THEN
            RAISE EXCEPTION 'An independent organization reviewer is required' USING ERRCODE = '42501';
        END IF;
        IF OLD.status <> 'submitted' OR NEW.status NOT IN ('reviewed', 'returned')
           OR NEW.reviewed_request_id IS DISTINCT FROM request_id THEN
            RAISE EXCEPTION 'A submitted report can receive one review decision'
                USING ERRCODE = '23514', CONSTRAINT = 'internal_report_review_transition';
        END IF;
        NEW.reviewed_at := clock_timestamp();
    END IF;

    IF intake_status NOT IN ('submitted', 'approved') THEN
        RAISE EXCEPTION 'Report review requires a submitted or approved intake'
            USING ERRCODE = '23514', CONSTRAINT = 'internal_report_review_case_state';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER guard_internal_report_review
    BEFORE INSERT OR UPDATE ON carbon.internal_report_review
    FOR EACH ROW EXECUTE FUNCTION carbon.guard_internal_report_review();
CREATE TRIGGER immutable_internal_report_review
    BEFORE DELETE ON carbon.internal_report_review
    FOR EACH ROW EXECUTE FUNCTION carbon.reject_mutation();

REVOKE ALL ON FUNCTION carbon.guard_internal_report_review() FROM PUBLIC;
GRANT SELECT ON carbon.internal_report_review TO carbon_app;
GRANT INSERT (tenant_id, org_id, case_id, draft_id, submitted_by, submitted_request_id)
    ON carbon.internal_report_review TO carbon_app;
GRANT UPDATE (status, reviewed_by, reviewed_request_id, reason) ON carbon.internal_report_review TO carbon_app;
