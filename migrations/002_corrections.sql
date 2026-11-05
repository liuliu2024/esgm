-- Keep the original intake and retain each correction in the audit history.
ALTER TABLE carbon.case_intake ADD COLUMN correction_note text;
ALTER TABLE carbon.case_intake ADD CONSTRAINT case_correction_note_valid CHECK (
    correction_note IS NULL OR (length(correction_note) <= 500 AND correction_note ~ '[^[:space:]]')
);
CREATE INDEX case_intake_by_customer ON carbon.case_intake (tenant_id, org_id, created_by, id);

ALTER TABLE carbon.audit_event ADD COLUMN correction_note text;
ALTER TABLE carbon.audit_event ADD CONSTRAINT audit_correction_note_valid CHECK (
    correction_note IS NULL OR (
        action = 'submitted' AND length(correction_note) <= 500 AND correction_note ~ '[^[:space:]]'
    )
);

-- The existing restrictive case policy defines which history can be read.
ALTER POLICY organization_audit ON carbon.audit_event USING (
    EXISTS (
        SELECT 1 FROM carbon.case_intake AS intake
        WHERE intake.tenant_id = audit_event.tenant_id
          AND intake.org_id = audit_event.org_id
          AND intake.id = audit_event.case_id
    )
);

CREATE OR REPLACE FUNCTION carbon.guard_case_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
DECLARE
    actor uuid := carbon.actor_context();
    request_id text := current_setting('carbon.request_id', true);
BEGIN
    IF actor IS NULL OR NEW.tenant_id IS DISTINCT FROM carbon.tenant_context() THEN
        RAISE EXCEPTION 'Workspace and actor context are required' USING ERRCODE = '42501';
    END IF;
    IF request_id IS NULL OR length(btrim(request_id)) NOT BETWEEN 1 AND 200 THEN
        RAISE EXCEPTION 'A request identifier is required' USING ERRCODE = '23514';
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'draft' OR NEW.revision <> 1 OR NEW.correction_note IS NOT NULL THEN
            RAISE EXCEPTION 'An intake must start as draft revision 1 without a correction' USING ERRCODE = '23514';
        END IF;
        IF NEW.created_by IS DISTINCT FROM actor OR NOT carbon.has_org_role(NEW.tenant_id, NEW.org_id, 'customer') THEN
            RAISE EXCEPTION 'Only the organization customer may create an intake as themselves' USING ERRCODE = '42501';
        END IF;
        RETURN NEW;
    END IF;

    IF (NEW.tenant_id, NEW.id, NEW.org_id, NEW.scenario_release_id, NEW.created_by, NEW.purpose)
            IS DISTINCT FROM (OLD.tenant_id, OLD.id, OLD.org_id, OLD.scenario_release_id, OLD.created_by, OLD.purpose) THEN
        RAISE EXCEPTION 'Intake identity and contents are immutable' USING ERRCODE = '55000';
    END IF;
    IF NEW.revision IS DISTINCT FROM OLD.revision + 1 THEN
        RAISE EXCEPTION 'Intake revision must advance by one' USING ERRCODE = '23514';
    END IF;

    IF OLD.status IN ('draft', 'returned') AND NEW.status = 'submitted' THEN
        IF OLD.created_by IS DISTINCT FROM actor OR NOT carbon.has_org_role(OLD.tenant_id, OLD.org_id, 'customer') THEN
            RAISE EXCEPTION 'Only the intake creator may submit as a customer' USING ERRCODE = '42501';
        END IF;
        IF OLD.status = 'draft' AND NEW.correction_note IS NOT NULL THEN
            RAISE EXCEPTION 'An initial submission cannot include a correction' USING ERRCODE = '23514';
        END IF;
        IF OLD.status = 'returned' AND NEW.correction_note IS NULL THEN
            RAISE EXCEPTION 'A correction note is required to resubmit' USING ERRCODE = '23514';
        END IF;
    ELSIF OLD.status = 'submitted' AND NEW.status IN ('approved', 'returned') THEN
        IF OLD.created_by = actor OR NOT carbon.has_org_role(OLD.tenant_id, OLD.org_id, 'reviewer') THEN
            RAISE EXCEPTION 'An independent organization reviewer is required' USING ERRCODE = '42501';
        END IF;
        IF NEW.correction_note IS DISTINCT FROM OLD.correction_note THEN
            RAISE EXCEPTION 'A review cannot change the customer correction' USING ERRCODE = '55000';
        END IF;
    ELSE
        RAISE EXCEPTION 'Unsupported intake state transition' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION carbon.append_case_audit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
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
    RETURN NULL;
END;
$$;

GRANT UPDATE (correction_note) ON carbon.case_intake TO carbon_app;
