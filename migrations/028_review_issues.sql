CREATE TABLE carbon.review_issue (
    tenant_id uuid NOT NULL,
    org_id uuid NOT NULL,
    case_id uuid NOT NULL,
    id uuid NOT NULL,
    submission_revision integer NOT NULL,
    evidence_id uuid,
    title text NOT NULL CHECK (length(title) <= 200 AND title ~ '[^[:space:]]'),
    description text NOT NULL CHECK (length(description) <= 1000 AND description ~ '[^[:space:]]'),
    severity text NOT NULL CHECK (severity IN ('low', 'normal', 'critical')),
    due_date date NOT NULL CHECK (isfinite(due_date)),
    assignee_id uuid NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'closed')),
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    last_action text NOT NULL DEFAULT 'opened',
    last_actor_id uuid NOT NULL,
    last_note text CHECK (length(last_note) <= 1000),
    request_id text NOT NULL CHECK (length(request_id) <= 200 AND request_id ~ '[^[:space:]]'),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, org_id, case_id, id),
    CONSTRAINT review_issue_submission_reference FOREIGN KEY (tenant_id, org_id, case_id, submission_revision)
        REFERENCES carbon.case_submission(tenant_id, org_id, case_id, revision),
    CONSTRAINT review_issue_evidence_reference FOREIGN KEY (tenant_id, org_id, case_id, submission_revision, evidence_id)
        REFERENCES carbon.case_submission_evidence(tenant_id, org_id, case_id, revision, evidence_id)
);

CREATE TABLE carbon.review_issue_event (
    tenant_id uuid NOT NULL,
    org_id uuid NOT NULL,
    case_id uuid NOT NULL,
    issue_id uuid NOT NULL,
    version integer NOT NULL,
    action text NOT NULL,
    actor_id uuid NOT NULL,
    note text,
    request_id text NOT NULL,
    created_at timestamptz NOT NULL,
    PRIMARY KEY (tenant_id, org_id, case_id, issue_id, version),
    FOREIGN KEY (tenant_id, org_id, case_id, issue_id)
        REFERENCES carbon.review_issue(tenant_id, org_id, case_id, id)
);

ALTER TABLE carbon.review_issue ENABLE ROW LEVEL SECURITY;
ALTER TABLE carbon.review_issue FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON carbon.review_issue
    USING (tenant_id = (SELECT carbon.tenant_context()))
    WITH CHECK (tenant_id = (SELECT carbon.tenant_context()));
CREATE POLICY actor_review_issue ON carbon.review_issue AS RESTRICTIVE TO carbon_app
    USING (
        EXISTS (
            SELECT 1 FROM carbon.case_intake AS intake
            WHERE (intake.tenant_id, intake.org_id, intake.id) =
                (review_issue.tenant_id, review_issue.org_id, review_issue.case_id)
              AND (
                  carbon.has_org_role(intake.tenant_id, intake.org_id, 'reviewer')
                  OR (intake.created_by = (SELECT carbon.actor_context())
                      AND carbon.has_org_role(intake.tenant_id, intake.org_id, 'customer'))
              )
        )
    );

ALTER TABLE carbon.review_issue_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE carbon.review_issue_event FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON carbon.review_issue_event
    USING (tenant_id = (SELECT carbon.tenant_context()))
    WITH CHECK (tenant_id = (SELECT carbon.tenant_context()));
CREATE POLICY actor_review_issue_event ON carbon.review_issue_event AS RESTRICTIVE FOR SELECT TO carbon_app
    USING (
        EXISTS (
            SELECT 1 FROM carbon.review_issue AS issue
            WHERE (issue.tenant_id, issue.org_id, issue.case_id, issue.id) =
                (review_issue_event.tenant_id, review_issue_event.org_id, review_issue_event.case_id,
                 review_issue_event.issue_id)
        )
    );

CREATE FUNCTION carbon.guard_review_issue() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
DECLARE
    actor uuid := carbon.actor_context();
    task_owner uuid;
BEGIN
    IF actor IS NULL OR NEW.tenant_id IS DISTINCT FROM carbon.tenant_context()
       OR NEW.last_actor_id IS DISTINCT FROM actor
       OR NEW.request_id IS DISTINCT FROM current_setting('carbon.request_id', true) THEN
        RAISE EXCEPTION 'The review issue requires the current actor and request' USING ERRCODE = '42501';
    END IF;

    IF TG_OP = 'INSERT' THEN
        SELECT task.created_by INTO task_owner
        FROM carbon.case_intake AS task
        WHERE (task.tenant_id, task.org_id, task.id) = (NEW.tenant_id, NEW.org_id, NEW.case_id);
        IF NOT FOUND OR task_owner = actor OR NEW.created_by IS DISTINCT FROM actor
           OR NEW.assignee_id IS DISTINCT FROM task_owner
           OR NOT carbon.has_org_role(NEW.tenant_id, NEW.org_id, 'reviewer') THEN
            RAISE EXCEPTION 'Only an independent organization reviewer can open an issue for the task owner'
                USING ERRCODE = '42501';
        END IF;
        IF NEW.status <> 'open' OR NEW.version <> 1 OR NEW.last_action <> 'opened' OR NEW.last_note IS NOT NULL THEN
            RAISE EXCEPTION 'A review issue must begin open at version 1'
                USING ERRCODE = '23514', CONSTRAINT = 'review_issue_transition';
        END IF;
        NEW.updated_at := NEW.created_at;
        RETURN NEW;
    END IF;

    IF (NEW.tenant_id, NEW.org_id, NEW.case_id, NEW.id, NEW.submission_revision, NEW.evidence_id,
        NEW.title, NEW.description, NEW.severity, NEW.due_date, NEW.assignee_id, NEW.created_by, NEW.created_at)
       IS DISTINCT FROM
       (OLD.tenant_id, OLD.org_id, OLD.case_id, OLD.id, OLD.submission_revision, OLD.evidence_id,
        OLD.title, OLD.description, OLD.severity, OLD.due_date, OLD.assignee_id, OLD.created_by, OLD.created_at) THEN
        RAISE EXCEPTION 'The original review issue fields are immutable' USING ERRCODE = '55000';
    END IF;
    IF NEW.last_action = 'replied' THEN
        IF actor <> OLD.assignee_id OR NOT carbon.has_org_role(OLD.tenant_id, OLD.org_id, 'customer') THEN
            RAISE EXCEPTION 'Only the task owner can reply to a review issue' USING ERRCODE = '42501';
        END IF;
    ELSIF actor = OLD.assignee_id OR NOT carbon.has_org_role(OLD.tenant_id, OLD.org_id, 'reviewer') THEN
        RAISE EXCEPTION 'Only an independent organization reviewer can decide the issue'
            USING ERRCODE = '42501';
    END IF;

    IF NEW.version <> OLD.version + 1 OR NEW.last_note IS NULL OR NEW.last_note !~ '[^[:space:]]'
       OR NOT (
           (OLD.status = 'open' AND NEW.status = 'answered' AND NEW.last_action = 'replied')
           OR (OLD.status = 'answered' AND NEW.status = 'open' AND NEW.last_action = 'request_follow_up')
           OR (OLD.status = 'answered' AND NEW.status = 'closed' AND NEW.last_action = 'closed')
       ) THEN
        RAISE EXCEPTION 'The review issue transition requires the next version and a note'
            USING ERRCODE = '23514', CONSTRAINT = 'review_issue_transition';
    END IF;
    NEW.updated_at := clock_timestamp();
    RETURN NEW;
END;
$$;

CREATE FUNCTION carbon.append_review_issue_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
BEGIN
    INSERT INTO carbon.review_issue_event (
        tenant_id, org_id, case_id, issue_id, version, action, actor_id, note, request_id, created_at
    ) VALUES (
        NEW.tenant_id, NEW.org_id, NEW.case_id, NEW.id, NEW.version, NEW.last_action,
        NEW.last_actor_id, NEW.last_note, NEW.request_id, NEW.updated_at
    );
    RETURN NULL;
END;
$$;

CREATE TRIGGER guard_review_issue
    BEFORE INSERT OR UPDATE ON carbon.review_issue
    FOR EACH ROW EXECUTE FUNCTION carbon.guard_review_issue();
CREATE TRIGGER audit_review_issue
    AFTER INSERT OR UPDATE ON carbon.review_issue
    FOR EACH ROW EXECUTE FUNCTION carbon.append_review_issue_event();
CREATE TRIGGER immutable_review_issue
    BEFORE DELETE ON carbon.review_issue
    FOR EACH ROW EXECUTE FUNCTION carbon.reject_mutation();
CREATE TRIGGER immutable_review_issue_event
    BEFORE UPDATE OR DELETE OR TRUNCATE ON carbon.review_issue_event
    FOR EACH STATEMENT EXECUTE FUNCTION carbon.reject_mutation();

REVOKE ALL ON FUNCTION carbon.guard_review_issue(), carbon.append_review_issue_event() FROM PUBLIC;
GRANT SELECT ON carbon.review_issue, carbon.review_issue_event TO carbon_app;
GRANT INSERT (
    tenant_id, org_id, case_id, id, submission_revision, evidence_id, title, description, severity, due_date,
    assignee_id, created_by, last_actor_id, request_id
) ON carbon.review_issue TO carbon_app;
GRANT UPDATE (status, version, last_action, last_actor_id, last_note, request_id) ON carbon.review_issue TO carbon_app;
