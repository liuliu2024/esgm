CREATE TABLE carbon.case_reopen_request (
    tenant_id uuid NOT NULL,
    org_id uuid NOT NULL,
    case_id uuid NOT NULL,
    id uuid NOT NULL,
    approved_revision integer NOT NULL CHECK (approved_revision > 1),
    reason text NOT NULL CHECK (length(reason) <= 500 AND reason ~ '[^[:space:]]'),
    created_by uuid NOT NULL,
    request_id text NOT NULL CHECK (length(request_id) <= 200 AND request_id ~ '[^[:space:]]'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    status text NOT NULL DEFAULT 'pending',
    reviewed_by uuid,
    review_reason text CHECK (length(review_reason) <= 500 AND review_reason ~ '[^[:space:]]'),
    review_request_id text CHECK (length(review_request_id) <= 200 AND review_request_id ~ '[^[:space:]]'),
    reviewed_at timestamptz,
    PRIMARY KEY (tenant_id, org_id, case_id, id),
    UNIQUE (tenant_id, org_id, id),
    FOREIGN KEY (tenant_id, org_id, case_id) REFERENCES carbon.case_intake(tenant_id, org_id, id),
    CONSTRAINT case_reopen_request_transition CHECK (
        (status = 'pending' AND num_nonnulls(reviewed_by, review_reason, review_request_id, reviewed_at) = 0)
        OR (status IN ('approved', 'returned') AND reviewed_by IS NOT NULL AND reviewed_by <> created_by
            AND review_request_id IS NOT NULL AND reviewed_at IS NOT NULL
            AND (status <> 'returned' OR review_reason IS NOT NULL))
    )
);
CREATE UNIQUE INDEX case_reopen_request_active_case ON carbon.case_reopen_request (tenant_id, org_id, case_id)
    WHERE status IN ('pending', 'approved');

ALTER TABLE carbon.case_reopen_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE carbon.case_reopen_request FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON carbon.case_reopen_request
    USING (tenant_id = (SELECT carbon.tenant_context()))
    WITH CHECK (tenant_id = (SELECT carbon.tenant_context()));
CREATE POLICY actor_case_reopen_read ON carbon.case_reopen_request AS RESTRICTIVE FOR SELECT TO carbon_app
    USING (
        EXISTS (
            SELECT 1 FROM carbon.case_intake AS task
            WHERE (task.tenant_id, task.org_id, task.id) =
                (case_reopen_request.tenant_id, case_reopen_request.org_id, case_reopen_request.case_id)
              AND (
                  carbon.has_org_role(task.tenant_id, task.org_id, 'reviewer')
                  OR (task.created_by = (SELECT carbon.actor_context())
                      AND carbon.has_org_role(task.tenant_id, task.org_id, 'customer'))
              )
        )
    );

CREATE FUNCTION carbon.guard_case_reopen_request() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
DECLARE
    actor uuid := carbon.actor_context();
    request_id text := current_setting('carbon.request_id', true);
    intake record;
BEGIN
    IF actor IS NULL OR NEW.tenant_id IS DISTINCT FROM carbon.tenant_context() THEN
        RAISE EXCEPTION 'Workspace and actor context are required' USING ERRCODE = '42501';
    END IF;
    IF TG_OP = 'UPDATE' AND
       (NEW.tenant_id, NEW.org_id, NEW.case_id, NEW.id, NEW.approved_revision,
        NEW.reason, NEW.created_by, NEW.request_id, NEW.created_at)
       IS DISTINCT FROM
       (OLD.tenant_id, OLD.org_id, OLD.case_id, OLD.id, OLD.approved_revision,
        OLD.reason, OLD.created_by, OLD.request_id, OLD.created_at) THEN
        RAISE EXCEPTION 'The original reopen request is immutable' USING ERRCODE = '55000';
    END IF;

    SELECT task.created_by, task.status, task.revision, task.intake_scope INTO intake
    FROM carbon.case_intake AS task
    WHERE (task.tenant_id, task.org_id, task.id) = (NEW.tenant_id, NEW.org_id, NEW.case_id)
    FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'The source intake is not visible' USING ERRCODE = '42501';
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF actor <> intake.created_by OR NEW.created_by IS DISTINCT FROM actor
           OR NOT carbon.has_org_role(NEW.tenant_id, NEW.org_id, 'customer') THEN
            RAISE EXCEPTION 'Only the task owner can request reopening' USING ERRCODE = '42501';
        END IF;
        IF NEW.status <> 'pending' OR NEW.request_id IS DISTINCT FROM request_id THEN
            RAISE EXCEPTION 'A reopen request must begin pending'
                USING ERRCODE = '23514', CONSTRAINT = 'case_reopen_request_transition';
        END IF;
    ELSE
        IF actor = intake.created_by OR NEW.reviewed_by IS DISTINCT FROM actor
           OR NOT carbon.has_org_role(NEW.tenant_id, NEW.org_id, 'reviewer') THEN
            RAISE EXCEPTION 'An independent organization reviewer is required' USING ERRCODE = '42501';
        END IF;
        IF OLD.status <> 'pending' OR NEW.status NOT IN ('approved', 'returned')
           OR NEW.review_request_id IS DISTINCT FROM request_id THEN
            RAISE EXCEPTION 'A pending reopen request can receive one review decision'
                USING ERRCODE = '23514', CONSTRAINT = 'case_reopen_request_transition';
        END IF;
        NEW.reviewed_at := clock_timestamp();
    END IF;

    IF intake.status <> 'approved' OR intake.revision IS DISTINCT FROM NEW.approved_revision
       OR jsonb_typeof(intake.intake_scope->'reportingYear') IS DISTINCT FROM 'string'
       OR intake.intake_scope->>'reportingYear' !~ '^[0-9]{4}$'
       OR intake.intake_scope->>'reportingYear' = '0000'
       OR NOT EXISTS (
           SELECT 1 FROM carbon.case_submission AS submission
           WHERE (submission.tenant_id, submission.org_id, submission.case_id, submission.revision) =
                 (NEW.tenant_id, NEW.org_id, NEW.case_id, intake.revision - 1)
       ) THEN
        RAISE EXCEPTION 'Reopening requires the exact approved task revision with a valid reporting year and submission'
            USING ERRCODE = '23514', CONSTRAINT = 'case_reopen_request_source';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER guard_case_reopen_request
    BEFORE INSERT OR UPDATE ON carbon.case_reopen_request
    FOR EACH ROW EXECUTE FUNCTION carbon.guard_case_reopen_request();
CREATE TRIGGER immutable_case_reopen_request
    BEFORE DELETE ON carbon.case_reopen_request
    FOR EACH ROW EXECUTE FUNCTION carbon.reject_mutation();

ALTER TABLE carbon.case_intake
    ADD COLUMN reopen_request_id uuid,
    ADD CONSTRAINT case_intake_reopen_request_key UNIQUE (tenant_id, org_id, reopen_request_id),
    ADD CONSTRAINT case_intake_reopen_request_reference FOREIGN KEY (tenant_id, org_id, reopen_request_id)
        REFERENCES carbon.case_reopen_request(tenant_id, org_id, id),
    ADD CONSTRAINT case_intake_reopen_source CHECK (reopen_request_id IS NULL OR rule_recalculation_of IS NULL);

CREATE FUNCTION carbon.guard_case_reopen_child() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF NEW.reopen_request_id IS DISTINCT FROM OLD.reopen_request_id THEN
            RAISE EXCEPTION 'The reopen request link is immutable' USING ERRCODE = '55000';
        END IF;
    ELSIF NEW.reopen_request_id IS NOT NULL THEN
        PERFORM 1
        FROM carbon.case_reopen_request AS request
        JOIN carbon.case_intake AS parent
          ON (parent.tenant_id, parent.org_id, parent.id) = (request.tenant_id, request.org_id, request.case_id)
        WHERE (request.tenant_id, request.org_id, request.id) = (NEW.tenant_id, NEW.org_id, NEW.reopen_request_id)
          AND request.status = 'approved' AND request.created_by = NEW.created_by
          AND parent.status = 'approved' AND parent.revision = request.approved_revision
          AND parent.created_by = NEW.created_by AND NEW.created_by = (SELECT carbon.actor_context())
          AND carbon.has_org_role(NEW.tenant_id, NEW.org_id, 'customer')
          AND parent.scenario_release_id = NEW.scenario_release_id AND parent.purpose = NEW.purpose
          AND parent.intake_scope IS NOT DISTINCT FROM NEW.intake_scope
        FOR SHARE OF parent;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'A reopened draft requires the owner''s approved request and unchanged source scope'
                USING ERRCODE = '23514', CONSTRAINT = 'case_intake_reopen_source';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER guard_case_reopen_child
    BEFORE INSERT OR UPDATE OF reopen_request_id ON carbon.case_intake
    FOR EACH ROW EXECUTE FUNCTION carbon.guard_case_reopen_child();

REVOKE ALL ON FUNCTION carbon.guard_case_reopen_request(), carbon.guard_case_reopen_child() FROM PUBLIC;
GRANT SELECT ON carbon.case_reopen_request TO carbon_app;
GRANT INSERT (tenant_id, org_id, case_id, id, approved_revision, reason, created_by, request_id)
    ON carbon.case_reopen_request TO carbon_app;
GRANT UPDATE (status, reviewed_by, review_reason, review_request_id) ON carbon.case_reopen_request TO carbon_app;
GRANT INSERT (reopen_request_id) ON carbon.case_intake TO carbon_app;
