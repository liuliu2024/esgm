-- A rule assessment is an append-only professional decision on one submission.
CREATE TABLE carbon.case_rule_decision (
    tenant_id uuid NOT NULL,
    org_id uuid NOT NULL,
    case_id uuid NOT NULL,
    submission_revision integer NOT NULL,
    status text NOT NULL CHECK (status IN ('confirmed', 'needs_review')),
    reference_code text,
    rationale text NOT NULL CHECK (length(rationale) <= 500 AND rationale ~ '[^[:space:]]'),
    decided_by uuid NOT NULL,
    request_id text NOT NULL CHECK (length(request_id) <= 200 AND request_id ~ '[^[:space:]]'),
    decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, org_id, case_id, submission_revision),
    FOREIGN KEY (tenant_id, org_id, case_id, submission_revision)
        REFERENCES carbon.case_submission(tenant_id, org_id, case_id, revision),
    CONSTRAINT case_rule_decision_reference CHECK (
        (status = 'needs_review' AND reference_code IS NULL)
        OR (status = 'confirmed' AND reference_code IS NOT NULL AND reference_code ~ '[^[:space:]]')
    )
);

ALTER TABLE carbon.case_rule_decision ENABLE ROW LEVEL SECURITY;
ALTER TABLE carbon.case_rule_decision FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON carbon.case_rule_decision
    USING (tenant_id = (SELECT carbon.tenant_context()))
    WITH CHECK (tenant_id = (SELECT carbon.tenant_context()));
CREATE POLICY actor_rule_decision_read ON carbon.case_rule_decision
    AS RESTRICTIVE FOR SELECT TO carbon_app
    USING (
        EXISTS (
            SELECT 1 FROM carbon.case_intake AS intake
            WHERE (intake.tenant_id, intake.org_id, intake.id) =
                (case_rule_decision.tenant_id, case_rule_decision.org_id, case_rule_decision.case_id)
              AND (
                  carbon.has_org_role(intake.tenant_id, intake.org_id, 'reviewer')
                  OR (
                      intake.created_by = (SELECT carbon.actor_context())
                      AND carbon.has_org_role(intake.tenant_id, intake.org_id, 'customer')
                  )
              )
        )
    );

CREATE FUNCTION carbon.guard_rule_decision() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
DECLARE
    actor uuid := carbon.actor_context();
    intake record;
BEGIN
    IF actor IS NULL OR NEW.tenant_id IS DISTINCT FROM carbon.tenant_context()
       OR NEW.decided_by IS DISTINCT FROM actor
       OR NEW.request_id IS DISTINCT FROM current_setting('carbon.request_id', true)
       OR NOT carbon.has_org_role(NEW.tenant_id, NEW.org_id, 'reviewer') THEN
        RAISE EXCEPTION 'Only the organization reviewer can record a rule decision as themselves'
            USING ERRCODE = '42501';
    END IF;

    SELECT task.created_by, task.status, task.revision, task.scenario_release_id, task.intake_scope INTO intake
    FROM carbon.case_intake AS task
    WHERE (task.tenant_id, task.org_id, task.id) = (NEW.tenant_id, NEW.org_id, NEW.case_id)
    FOR SHARE;

    IF NOT FOUND OR intake.created_by = actor THEN
        RAISE EXCEPTION 'A rule decision requires an independent reviewer for the intake'
            USING ERRCODE = '42501';
    END IF;
    IF intake.status <> 'submitted' OR intake.revision <> NEW.submission_revision THEN
        RAISE EXCEPTION 'A rule decision requires the current submitted revision'
            USING ERRCODE = '23514', CONSTRAINT = 'case_rule_decision_submission_state';
    END IF;

    IF NEW.status = 'confirmed' AND (
        intake.intake_scope IS NULL OR intake.intake_scope = '{}'::jsonb
        OR NOT EXISTS (
            SELECT 1
            FROM carbon.scenario_release AS release
            CROSS JOIN LATERAL jsonb_array_elements(
                CASE WHEN jsonb_typeof(release.manifest->'references') = 'array'
                    THEN release.manifest->'references' ELSE '[]'::jsonb END
            ) AS candidate(entry)
            WHERE (release.tenant_id, release.id) = (NEW.tenant_id, intake.scenario_release_id)
              AND candidate.entry->'code' = to_jsonb(NEW.reference_code)
              AND candidate.entry->>'publicationStatus' IN ('effective', 'pilot')
        )
    ) THEN
        RAISE EXCEPTION 'Confirmation requires a declared scope and an effective or pilot reference from the locked release'
            USING ERRCODE = '23514', CONSTRAINT = 'case_rule_decision_reference';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER guard_rule_decision
    BEFORE INSERT ON carbon.case_rule_decision
    FOR EACH ROW EXECUTE FUNCTION carbon.guard_rule_decision();
CREATE TRIGGER immutable_rule_decision
    BEFORE UPDATE OR DELETE ON carbon.case_rule_decision
    FOR EACH ROW EXECUTE FUNCTION carbon.reject_mutation();

REVOKE ALL ON FUNCTION carbon.guard_rule_decision() FROM PUBLIC;
GRANT SELECT ON carbon.case_rule_decision TO carbon_app;
GRANT INSERT (
    tenant_id, org_id, case_id, submission_revision, status, reference_code, rationale, decided_by, request_id
) ON carbon.case_rule_decision TO carbon_app;
