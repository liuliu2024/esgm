CREATE TABLE carbon.gas_report_restatement (
    tenant_id uuid NOT NULL,
    org_id uuid NOT NULL,
    case_id uuid NOT NULL,
    id uuid NOT NULL,
    baseline_snapshot_id uuid NOT NULL,
    target_snapshot_id uuid NOT NULL,
    reason text NOT NULL CHECK (length(reason) <= 500 AND reason ~ '[^[:space:]]'),
    created_by uuid NOT NULL,
    request_id text NOT NULL CHECK (length(btrim(request_id)) BETWEEN 1 AND 200),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    status text NOT NULL DEFAULT 'pending',
    reviewed_by uuid,
    review_reason text CHECK (length(review_reason) <= 500 AND review_reason ~ '[^[:space:]]'),
    review_request_id text CHECK (length(btrim(review_request_id)) BETWEEN 1 AND 200),
    reviewed_at timestamptz,
    PRIMARY KEY (tenant_id, org_id, case_id, id),
    FOREIGN KEY (tenant_id, org_id, case_id, baseline_snapshot_id)
        REFERENCES carbon.model_trial_snapshot(tenant_id, org_id, case_id, id),
    FOREIGN KEY (tenant_id, org_id, case_id, target_snapshot_id)
        REFERENCES carbon.model_trial_snapshot(tenant_id, org_id, case_id, id),
    CONSTRAINT gas_report_restatement_transition CHECK (
        (status = 'pending' AND num_nonnulls(reviewed_by, review_reason, review_request_id, reviewed_at) = 0)
        OR (status IN ('approved', 'returned') AND reviewed_by IS NOT NULL AND reviewed_by <> created_by
            AND review_request_id IS NOT NULL AND reviewed_at IS NOT NULL
            AND (status <> 'returned' OR review_reason IS NOT NULL))
    )
);
CREATE UNIQUE INDEX gas_report_restatement_active_target
    ON carbon.gas_report_restatement (tenant_id, org_id, case_id, target_snapshot_id)
    WHERE status IN ('pending', 'approved');

ALTER TABLE carbon.gas_report_restatement ENABLE ROW LEVEL SECURITY;
ALTER TABLE carbon.gas_report_restatement FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON carbon.gas_report_restatement
    USING (tenant_id = (SELECT carbon.tenant_context()))
    WITH CHECK (tenant_id = (SELECT carbon.tenant_context()));
CREATE POLICY actor_restatement_read ON carbon.gas_report_restatement AS RESTRICTIVE FOR SELECT TO carbon_app
    USING (
        EXISTS (
            SELECT 1 FROM carbon.case_intake AS intake
            WHERE (intake.tenant_id, intake.org_id, intake.id) =
                (gas_report_restatement.tenant_id, gas_report_restatement.org_id, gas_report_restatement.case_id)
              AND (
                  carbon.has_org_role(intake.tenant_id, intake.org_id, 'reviewer')
                  OR (intake.created_by = (SELECT carbon.actor_context())
                      AND carbon.has_org_role(intake.tenant_id, intake.org_id, 'customer'))
              )
        )
    );

-- An invoker lookup sees only snapshots and drafts already visible to the actor.
CREATE FUNCTION carbon.latest_prior_gas_report_snapshot(p_tenant uuid, p_org uuid, p_case uuid, p_target uuid)
RETURNS uuid
LANGUAGE sql STABLE SET search_path = pg_catalog
AS $$
    SELECT earlier.id
    FROM carbon.model_trial_snapshot AS target
    JOIN carbon.model_trial_snapshot AS earlier
      ON (earlier.tenant_id, earlier.org_id, earlier.case_id, earlier.model_id, earlier.model_version,
          earlier.from_period, earlier.to_period) =
         (target.tenant_id, target.org_id, target.case_id, target.model_id, target.model_version,
          target.from_period, target.to_period)
     AND earlier.submission_revision < target.submission_revision
    WHERE (target.tenant_id, target.org_id, target.case_id, target.id) = (p_tenant, p_org, p_case, p_target)
      AND EXISTS (
          SELECT 1 FROM carbon.internal_report_draft AS draft
          WHERE (draft.tenant_id, draft.org_id, draft.case_id, draft.trial_snapshot_id) =
              (earlier.tenant_id, earlier.org_id, earlier.case_id, earlier.id)
      )
    ORDER BY earlier.submission_revision DESC
    LIMIT 1
$$;

CREATE FUNCTION carbon.guard_gas_report_restatement() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
DECLARE
    actor uuid := carbon.actor_context();
    request_id text := current_setting('carbon.request_id', true);
    intake record;
    target_revision integer;
BEGIN
    IF actor IS NULL OR NEW.tenant_id IS DISTINCT FROM carbon.tenant_context() THEN
        RAISE EXCEPTION 'Workspace and actor context are required' USING ERRCODE = '42501';
    END IF;

    SELECT task.created_by, task.status, task.revision INTO intake
    FROM carbon.case_intake AS task
    WHERE (task.tenant_id, task.org_id, task.id) = (NEW.tenant_id, NEW.org_id, NEW.case_id)
    FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Report intake is not visible' USING ERRCODE = '42501';
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF intake.created_by IS DISTINCT FROM actor OR NEW.created_by IS DISTINCT FROM actor
           OR NOT carbon.has_org_role(NEW.tenant_id, NEW.org_id, 'customer') THEN
            RAISE EXCEPTION 'Only the intake creator may request a restatement as themselves' USING ERRCODE = '42501';
        END IF;
        IF NEW.status <> 'pending' OR NEW.request_id IS DISTINCT FROM request_id THEN
            RAISE EXCEPTION 'A restatement request must begin pending'
                USING ERRCODE = '23514', CONSTRAINT = 'gas_report_restatement_transition';
        END IF;
        IF EXISTS (
            SELECT 1 FROM carbon.internal_report_draft AS draft
            WHERE (draft.tenant_id, draft.org_id, draft.case_id, draft.trial_snapshot_id) =
                (NEW.tenant_id, NEW.org_id, NEW.case_id, NEW.target_snapshot_id)
        ) THEN
            RAISE EXCEPTION 'A target with an existing report cannot request a restatement'
                USING ERRCODE = '23514', CONSTRAINT = 'gas_report_restatement_source';
        END IF;
        IF NEW.baseline_snapshot_id IS DISTINCT FROM carbon.latest_prior_gas_report_snapshot(
            NEW.tenant_id, NEW.org_id, NEW.case_id, NEW.target_snapshot_id
        ) THEN
            RAISE EXCEPTION 'A restatement requires the latest earlier report for the same model and period'
                USING ERRCODE = '23514', CONSTRAINT = 'gas_report_restatement_source';
        END IF;
    ELSE
        IF (NEW.tenant_id, NEW.org_id, NEW.case_id, NEW.id, NEW.baseline_snapshot_id, NEW.target_snapshot_id,
            NEW.reason, NEW.created_by, NEW.request_id, NEW.created_at) IS DISTINCT FROM
           (OLD.tenant_id, OLD.org_id, OLD.case_id, OLD.id, OLD.baseline_snapshot_id, OLD.target_snapshot_id,
            OLD.reason, OLD.created_by, OLD.request_id, OLD.created_at) THEN
            RAISE EXCEPTION 'The submitted restatement is immutable' USING ERRCODE = '55000';
        END IF;
        IF intake.created_by = actor OR NEW.reviewed_by IS DISTINCT FROM actor
           OR NOT carbon.has_org_role(NEW.tenant_id, NEW.org_id, 'reviewer') THEN
            RAISE EXCEPTION 'An independent organization reviewer is required' USING ERRCODE = '42501';
        END IF;
        IF OLD.status <> 'pending' OR NEW.status NOT IN ('approved', 'returned')
           OR NEW.review_request_id IS DISTINCT FROM request_id THEN
            RAISE EXCEPTION 'A pending restatement can receive one review decision'
                USING ERRCODE = '23514', CONSTRAINT = 'gas_report_restatement_transition';
        END IF;
        NEW.reviewed_at := clock_timestamp();
    END IF;

    SELECT snapshot.submission_revision INTO target_revision
    FROM carbon.model_trial_snapshot AS snapshot
    WHERE (snapshot.tenant_id, snapshot.org_id, snapshot.case_id, snapshot.id) =
        (NEW.tenant_id, NEW.org_id, NEW.case_id, NEW.target_snapshot_id);
    IF intake.status NOT IN ('submitted', 'approved') OR target_revision IS DISTINCT FROM
        (CASE WHEN intake.status = 'approved' THEN intake.revision - 1 ELSE intake.revision END) THEN
        RAISE EXCEPTION 'A restatement requires the current effective target submission'
            USING ERRCODE = '23514', CONSTRAINT = 'gas_report_restatement_source';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER guard_gas_report_restatement
    BEFORE INSERT OR UPDATE ON carbon.gas_report_restatement
    FOR EACH ROW EXECUTE FUNCTION carbon.guard_gas_report_restatement();
CREATE TRIGGER immutable_gas_report_restatement
    BEFORE DELETE ON carbon.gas_report_restatement
    FOR EACH ROW EXECUTE FUNCTION carbon.reject_mutation();

CREATE FUNCTION carbon.guard_gas_report_restatement_draft() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
DECLARE
    intake record;
    target_revision integer;
    baseline_id uuid;
BEGIN
    IF NEW.payload->>'mode' IS DISTINCT FROM 'internal_trial' OR NEW.trial_snapshot_id IS NULL THEN
        RETURN NEW;
    END IF;
    SELECT task.status, task.revision INTO intake
    FROM carbon.case_intake AS task
    WHERE (task.tenant_id, task.org_id, task.id) = (NEW.tenant_id, NEW.org_id, NEW.case_id)
      AND task.created_by = (SELECT carbon.actor_context())
      AND carbon.has_org_role(task.tenant_id, task.org_id, 'customer')
    FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Report intake is not visible' USING ERRCODE = '42501';
    END IF;

    -- BEFORE INSERT also runs for idempotent replays of a draft already saved.
    IF EXISTS (
        SELECT 1 FROM carbon.internal_report_draft AS draft
        WHERE (draft.tenant_id, draft.org_id, draft.case_id, draft.trial_snapshot_id, draft.template_id, draft.template_version) =
            (NEW.tenant_id, NEW.org_id, NEW.case_id, NEW.trial_snapshot_id, NEW.template_id, NEW.template_version)
    ) THEN
        RETURN NEW;
    END IF;
    SELECT snapshot.submission_revision INTO target_revision
    FROM carbon.model_trial_snapshot AS snapshot
    WHERE (snapshot.tenant_id, snapshot.org_id, snapshot.case_id, snapshot.id) =
        (NEW.tenant_id, NEW.org_id, NEW.case_id, NEW.trial_snapshot_id);
    IF intake.status NOT IN ('submitted', 'approved') OR target_revision IS DISTINCT FROM
        (CASE WHEN intake.status = 'approved' THEN intake.revision - 1 ELSE intake.revision END) THEN
        RAISE EXCEPTION 'An internal trial report requires the current effective target submission'
            USING ERRCODE = '23514', CONSTRAINT = 'gas_report_restatement_source';
    END IF;

    baseline_id := carbon.latest_prior_gas_report_snapshot(NEW.tenant_id, NEW.org_id, NEW.case_id, NEW.trial_snapshot_id);
    IF baseline_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM carbon.gas_report_restatement AS decision
        WHERE (decision.tenant_id, decision.org_id, decision.case_id, decision.baseline_snapshot_id, decision.target_snapshot_id) =
            (NEW.tenant_id, NEW.org_id, NEW.case_id, baseline_id, NEW.trial_snapshot_id)
          AND decision.status = 'approved'
    ) THEN
        RAISE EXCEPTION 'The newer report requires an approved restatement'
            USING ERRCODE = '23514', CONSTRAINT = 'gas_report_restatement_required';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER guard_gas_report_restatement_draft
    BEFORE INSERT ON carbon.internal_report_draft
    FOR EACH ROW EXECUTE FUNCTION carbon.guard_gas_report_restatement_draft();

REVOKE ALL ON FUNCTION carbon.guard_gas_report_restatement(), carbon.guard_gas_report_restatement_draft(),
    carbon.latest_prior_gas_report_snapshot(uuid, uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION carbon.latest_prior_gas_report_snapshot(uuid, uuid, uuid, uuid) TO carbon_app;
GRANT SELECT ON carbon.gas_report_restatement TO carbon_app;
GRANT INSERT (tenant_id, org_id, case_id, id, baseline_snapshot_id, target_snapshot_id, reason, created_by, request_id)
    ON carbon.gas_report_restatement TO carbon_app;
GRANT UPDATE (status, reviewed_by, review_reason, review_request_id)
    ON carbon.gas_report_restatement TO carbon_app;
