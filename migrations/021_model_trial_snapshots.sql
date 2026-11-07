-- A persisted internal trial is separate from report calculation snapshots.
CREATE TABLE carbon.model_trial_snapshot (
    tenant_id uuid NOT NULL,
    org_id uuid NOT NULL,
    case_id uuid NOT NULL,
    submission_revision integer NOT NULL,
    id uuid NOT NULL,
    model_id text NOT NULL,
    model_version integer NOT NULL,
    from_period date NOT NULL,
    to_period date NOT NULL,
    payload jsonb NOT NULL,
    created_by uuid NOT NULL,
    request_id text NOT NULL CHECK (length(request_id) <= 200 AND request_id ~ '[^[:space:]]'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, org_id, case_id, id),
    CONSTRAINT model_trial_snapshot_input_key
        UNIQUE (tenant_id, org_id, case_id, submission_revision, model_id, model_version, from_period, to_period),
    FOREIGN KEY (tenant_id, org_id, case_id, submission_revision)
        REFERENCES carbon.case_submission(tenant_id, org_id, case_id, revision),
    CONSTRAINT model_trial_snapshot_period CHECK (
        from_period >= DATE '2026-01-01' AND to_period < DATE '2027-01-01'
        AND from_period <= to_period AND extract(day FROM from_period) = 1 AND extract(day FROM to_period) = 1
    ),
    CONSTRAINT model_trial_snapshot_payload CHECK ((
        jsonb_typeof(payload) = 'object'
        AND model_id = 'power-gas-combustion-2026' AND model_version = 1
        AND payload->>'mode' = 'internal_trial'
        AND payload->'submissionRevision' = to_jsonb(submission_revision)
        AND payload->>'from' = to_char(from_period, 'YYYY-MM')
        AND payload->>'to' = to_char(to_period, 'YYYY-MM')
        AND payload#>>'{model,id}' = model_id
        AND payload#>'{model,version}' = to_jsonb(model_version)
        AND payload#>>'{coverage,status}' = 'complete'
        AND payload#>'{coverage,expectedSlots}' =
            to_jsonb(extract(month FROM to_period) - extract(month FROM from_period) + 1)
        AND payload#>'{coverage,availableSlots}' = payload#>'{coverage,expectedSlots}'
        AND payload#>'{coverage,missingSlots}' = '0'::jsonb
        AND payload->'formalReportEligible' = 'false'::jsonb
        AND payload->'externalDeliveryEligible' = 'false'::jsonb
    ) IS TRUE)
);

ALTER TABLE carbon.model_trial_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE carbon.model_trial_snapshot FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON carbon.model_trial_snapshot
    USING (tenant_id = (SELECT carbon.tenant_context()))
    WITH CHECK (tenant_id = (SELECT carbon.tenant_context()));
CREATE POLICY actor_model_trial_snapshot_read ON carbon.model_trial_snapshot
    AS RESTRICTIVE FOR SELECT TO carbon_app
    USING (
        EXISTS (
            SELECT 1 FROM carbon.case_intake AS intake
            WHERE (intake.tenant_id, intake.org_id, intake.id) =
                (model_trial_snapshot.tenant_id, model_trial_snapshot.org_id, model_trial_snapshot.case_id)
              AND (
                  carbon.has_org_role(intake.tenant_id, intake.org_id, 'reviewer')
                  OR (
                      intake.created_by = (SELECT carbon.actor_context())
                      AND carbon.has_org_role(intake.tenant_id, intake.org_id, 'customer')
                  )
              )
        )
    );

CREATE FUNCTION carbon.guard_model_trial_snapshot() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
DECLARE
    actor uuid := carbon.actor_context();
    intake record;
BEGIN
    IF actor IS NULL OR NEW.tenant_id IS DISTINCT FROM carbon.tenant_context()
       OR NEW.created_by IS DISTINCT FROM actor
       OR NEW.request_id IS DISTINCT FROM current_setting('carbon.request_id', true)
       OR NOT carbon.has_org_role(NEW.tenant_id, NEW.org_id, 'customer') THEN
        RAISE EXCEPTION 'Only the organization customer can save a model trial as themselves'
            USING ERRCODE = '42501';
    END IF;

    SELECT task.status, task.revision, task.intake_scope, release.code INTO intake
    FROM carbon.case_intake AS task
    JOIN carbon.scenario_release AS release
      ON (release.tenant_id, release.id) = (task.tenant_id, task.scenario_release_id)
    WHERE (task.tenant_id, task.org_id, task.id) = (NEW.tenant_id, NEW.org_id, NEW.case_id)
      AND task.created_by = actor
    FOR SHARE OF task;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Only the intake creator may save its model trial' USING ERRCODE = '42501';
    END IF;
    IF intake.status NOT IN ('submitted', 'approved')
       OR NEW.submission_revision <> (CASE WHEN intake.status = 'approved' THEN intake.revision - 1 ELSE intake.revision END) THEN
        RAISE EXCEPTION 'A model trial requires the current effective submission'
            USING ERRCODE = '23514', CONSTRAINT = 'model_trial_snapshot_submission_state';
    END IF;
    IF intake.code IS DISTINCT FROM 'power-generation-combustion'
       OR intake.intake_scope->>'subjectType' IS DISTINCT FROM 'facility'
       OR intake.intake_scope->>'reportingYear' IS DISTINCT FROM '2026'
       OR NEW.payload->>'facility' IS DISTINCT FROM intake.intake_scope->>'subjectName' THEN
        RAISE EXCEPTION 'A model trial requires the declared 2026 power-generation facility'
            USING ERRCODE = '23514', CONSTRAINT = 'model_trial_snapshot_scope';
    END IF;
    IF (SELECT count(*) FROM carbon.gas_combustion_input AS input
        WHERE (input.tenant_id, input.org_id, input.case_id, input.submission_revision) =
            (NEW.tenant_id, NEW.org_id, NEW.case_id, NEW.submission_revision)
          AND input.period BETWEEN NEW.from_period AND NEW.to_period)
       <> extract(month FROM NEW.to_period) - extract(month FROM NEW.from_period) + 1 THEN
        RAISE EXCEPTION 'Every month in a model trial snapshot requires a pinned input'
            USING ERRCODE = '23514', CONSTRAINT = 'model_trial_snapshot_incomplete';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER guard_model_trial_snapshot
    BEFORE INSERT ON carbon.model_trial_snapshot
    FOR EACH ROW EXECUTE FUNCTION carbon.guard_model_trial_snapshot();
CREATE TRIGGER immutable_model_trial_snapshot
    BEFORE UPDATE OR DELETE ON carbon.model_trial_snapshot
    FOR EACH ROW EXECUTE FUNCTION carbon.reject_mutation();

REVOKE ALL ON FUNCTION carbon.guard_model_trial_snapshot() FROM PUBLIC;
GRANT SELECT ON carbon.model_trial_snapshot TO carbon_app;
GRANT INSERT (
    tenant_id, org_id, case_id, submission_revision, id, model_id, model_version, from_period, to_period,
    payload, created_by, request_id
) ON carbon.model_trial_snapshot TO carbon_app;
