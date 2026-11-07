-- One set of evidenced combustion parameters per facility submission and month.
CREATE TABLE carbon.gas_combustion_input (
    tenant_id uuid NOT NULL,
    org_id uuid NOT NULL,
    case_id uuid NOT NULL,
    submission_revision integer NOT NULL,
    period date NOT NULL,
    standard_volume_nm3 numeric(22,8) NOT NULL CHECK (
        standard_volume_nm3 >= 0 AND standard_volume_nm3 < 'Infinity'::numeric
    ),
    method_branch text NOT NULL DEFAULT 'ncv_carbon',
    ncv_gj_per_10k_nm3 numeric(22,8) CHECK (
        ncv_gj_per_10k_nm3 > 0 AND ncv_gj_per_10k_nm3 < 'Infinity'::numeric
    ),
    carbon_tc_per_gj numeric(22,12) CHECK (
        carbon_tc_per_gj > 0 AND carbon_tc_per_gj < 'Infinity'::numeric
    ),
    elemental_carbon_tc_per_10k_nm3 numeric(22,12) CHECK (
        elemental_carbon_tc_per_10k_nm3 > 0 AND elemental_carbon_tc_per_10k_nm3 < 'Infinity'::numeric
    ),
    oxidation_fraction numeric(12,10) NOT NULL CHECK (oxidation_fraction > 0 AND oxidation_fraction <= 1),
    activity_evidence_id uuid NOT NULL,
    parameter_evidence_id uuid NOT NULL,
    parameter_basis text NOT NULL CHECK (length(parameter_basis) <= 500 AND parameter_basis ~ '[^[:space:]]'),
    recorded_by uuid NOT NULL,
    request_id text NOT NULL CHECK (length(request_id) <= 200 AND request_id ~ '[^[:space:]]'),
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, org_id, case_id, submission_revision, period),
    CONSTRAINT gas_combustion_activity_evidence
        FOREIGN KEY (tenant_id, org_id, case_id, submission_revision, activity_evidence_id)
        REFERENCES carbon.case_submission_evidence(tenant_id, org_id, case_id, revision, evidence_id),
    CONSTRAINT gas_combustion_parameter_evidence
        FOREIGN KEY (tenant_id, org_id, case_id, submission_revision, parameter_evidence_id)
        REFERENCES carbon.case_submission_evidence(tenant_id, org_id, case_id, revision, evidence_id),
    CONSTRAINT gas_combustion_input_method_branch CHECK (
        (method_branch = 'ncv_carbon' AND ncv_gj_per_10k_nm3 IS NOT NULL
            AND carbon_tc_per_gj IS NOT NULL AND elemental_carbon_tc_per_10k_nm3 IS NULL)
        OR (method_branch = 'measured_carbon' AND ncv_gj_per_10k_nm3 IS NULL
            AND carbon_tc_per_gj IS NULL AND elemental_carbon_tc_per_10k_nm3 IS NOT NULL)
    ),
    CONSTRAINT gas_combustion_input_scope CHECK (
        period >= DATE '2026-01-01' AND period < DATE '2027-01-01' AND extract(day FROM period) = 1
    )
);

ALTER TABLE carbon.gas_combustion_input ENABLE ROW LEVEL SECURITY;
ALTER TABLE carbon.gas_combustion_input FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON carbon.gas_combustion_input
    USING (tenant_id = (SELECT carbon.tenant_context()))
    WITH CHECK (tenant_id = (SELECT carbon.tenant_context()));
CREATE POLICY actor_gas_combustion_input_read ON carbon.gas_combustion_input
    AS RESTRICTIVE FOR SELECT TO carbon_app
    USING (
        EXISTS (
            SELECT 1 FROM carbon.case_intake AS intake
            WHERE (intake.tenant_id, intake.org_id, intake.id) =
                (gas_combustion_input.tenant_id, gas_combustion_input.org_id, gas_combustion_input.case_id)
              AND (
                  carbon.has_org_role(intake.tenant_id, intake.org_id, 'reviewer')
                  OR (
                      intake.created_by = (SELECT carbon.actor_context())
                      AND carbon.has_org_role(intake.tenant_id, intake.org_id, 'customer')
                  )
              )
        )
    );

CREATE FUNCTION carbon.guard_gas_combustion_input() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
DECLARE
    actor uuid := carbon.actor_context();
    intake record;
BEGIN
    IF actor IS NULL OR NEW.tenant_id IS DISTINCT FROM carbon.tenant_context()
       OR NEW.recorded_by IS DISTINCT FROM actor
       OR NEW.request_id IS DISTINCT FROM current_setting('carbon.request_id', true)
       OR NOT carbon.has_org_role(NEW.tenant_id, NEW.org_id, 'reviewer') THEN
        RAISE EXCEPTION 'Only the organization reviewer can record combustion inputs as themselves'
            USING ERRCODE = '42501';
    END IF;

    SELECT task.created_by, task.status, task.revision, task.intake_scope, release.code INTO intake
    FROM carbon.case_intake AS task
    JOIN carbon.scenario_release AS release
      ON (release.tenant_id, release.id) = (task.tenant_id, task.scenario_release_id)
    WHERE (task.tenant_id, task.org_id, task.id) = (NEW.tenant_id, NEW.org_id, NEW.case_id)
    FOR SHARE OF task;

    IF NOT FOUND OR intake.created_by = actor THEN
        RAISE EXCEPTION 'Combustion inputs require an independent reviewer for the intake'
            USING ERRCODE = '42501';
    END IF;
    IF intake.status <> 'submitted' OR intake.revision <> NEW.submission_revision THEN
        RAISE EXCEPTION 'Combustion inputs require the current submitted revision'
            USING ERRCODE = '23514', CONSTRAINT = 'gas_combustion_input_state';
    END IF;
    IF intake.code IS DISTINCT FROM 'power-generation-combustion'
       OR intake.intake_scope->>'subjectType' IS DISTINCT FROM 'facility'
       OR intake.intake_scope->>'reportingYear' IS DISTINCT FROM '2026'
       OR NOT EXISTS (
            SELECT 1 FROM carbon.case_rule_decision AS decision
            WHERE (decision.tenant_id, decision.org_id, decision.case_id, decision.submission_revision) =
                (NEW.tenant_id, NEW.org_id, NEW.case_id, NEW.submission_revision)
              AND decision.status = 'confirmed' AND decision.reference_code = 'cets-power-2026'
       ) THEN
        RAISE EXCEPTION 'Combustion inputs require the 2026 power-generation facility scope and confirmed rule'
            USING ERRCODE = '23514', CONSTRAINT = 'gas_combustion_input_scope';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER guard_gas_combustion_input
    BEFORE INSERT ON carbon.gas_combustion_input
    FOR EACH ROW EXECUTE FUNCTION carbon.guard_gas_combustion_input();
CREATE TRIGGER immutable_gas_combustion_input
    BEFORE UPDATE OR DELETE ON carbon.gas_combustion_input
    FOR EACH ROW EXECUTE FUNCTION carbon.reject_mutation();

REVOKE ALL ON FUNCTION carbon.guard_gas_combustion_input() FROM PUBLIC;
GRANT SELECT ON carbon.gas_combustion_input TO carbon_app;
GRANT INSERT (
    tenant_id, org_id, case_id, submission_revision, period, standard_volume_nm3,
    method_branch, ncv_gj_per_10k_nm3, carbon_tc_per_gj, elemental_carbon_tc_per_10k_nm3,
    oxidation_fraction, activity_evidence_id,
    parameter_evidence_id, parameter_basis, recorded_by, request_id
) ON carbon.gas_combustion_input TO carbon_app;
