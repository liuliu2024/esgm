-- Product electricity allocation is tied to one submitted production period.
CREATE TABLE carbon.product_electricity_profile (
    tenant_id uuid NOT NULL,
    org_id uuid NOT NULL,
    case_id uuid NOT NULL,
    submission_revision integer NOT NULL,
    from_period date NOT NULL,
    to_period date NOT NULL,
    boundary_note text NOT NULL CHECK (length(boundary_note) <= 500 AND boundary_note ~ '[^[:space:]]'),
    functional_unit text NOT NULL CHECK (length(functional_unit) <= 160 AND functional_unit ~ '[^[:space:]]'),
    output_quantity numeric(18,6) NOT NULL CHECK (output_quantity > 0 AND output_quantity < 'Infinity'::numeric),
    allocation_method text NOT NULL,
    product_mass_kg numeric(18,6),
    batch_mass_kg numeric(18,6),
    allocation_basis text NOT NULL CHECK (length(allocation_basis) <= 500 AND allocation_basis ~ '[^[:space:]]'),
    created_by uuid NOT NULL,
    request_id text NOT NULL CHECK (length(request_id) <= 200 AND request_id ~ '[^[:space:]]'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, org_id, case_id, submission_revision),
    FOREIGN KEY (tenant_id, org_id, case_id, submission_revision)
        REFERENCES carbon.case_submission(tenant_id, org_id, case_id, revision),
    CONSTRAINT product_electricity_profile_period CHECK (
        extract(year FROM from_period) BETWEEN 1 AND 9999
        AND extract(year FROM from_period) = extract(year FROM to_period)
        AND from_period <= to_period AND extract(day FROM from_period) = 1 AND extract(day FROM to_period) = 1
    ),
    CONSTRAINT product_electricity_profile_allocation CHECK (
        (allocation_method = 'exclusive' AND product_mass_kg IS NULL AND batch_mass_kg IS NULL)
        OR (allocation_method = 'mass' AND product_mass_kg IS NOT NULL AND batch_mass_kg IS NOT NULL
            AND product_mass_kg > 0 AND product_mass_kg <= batch_mass_kg AND batch_mass_kg < 'Infinity'::numeric)
    )
);

ALTER TABLE carbon.product_electricity_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE carbon.product_electricity_profile FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON carbon.product_electricity_profile
    USING (tenant_id = (SELECT carbon.tenant_context()))
    WITH CHECK (tenant_id = (SELECT carbon.tenant_context()));
CREATE POLICY actor_product_electricity_profile_read ON carbon.product_electricity_profile
    AS RESTRICTIVE FOR SELECT TO carbon_app
    USING (
        EXISTS (
            SELECT 1 FROM carbon.case_intake AS intake
            WHERE (intake.tenant_id, intake.org_id, intake.id) =
                (product_electricity_profile.tenant_id, product_electricity_profile.org_id, product_electricity_profile.case_id)
              AND (
                  carbon.has_org_role(intake.tenant_id, intake.org_id, 'reviewer')
                  OR (
                      intake.created_by = (SELECT carbon.actor_context())
                      AND carbon.has_org_role(intake.tenant_id, intake.org_id, 'customer')
                  )
              )
        )
    );

CREATE FUNCTION carbon.guard_product_electricity_profile() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
DECLARE
    actor uuid := carbon.actor_context();
    intake record;
BEGIN
    IF actor IS NULL OR NEW.tenant_id IS DISTINCT FROM carbon.tenant_context()
       OR NEW.created_by IS DISTINCT FROM actor
       OR NEW.request_id IS DISTINCT FROM current_setting('carbon.request_id', true)
       OR NOT carbon.has_org_role(NEW.tenant_id, NEW.org_id, 'reviewer') THEN
        RAISE EXCEPTION 'Only the organization reviewer can record a product electricity profile as themselves'
            USING ERRCODE = '42501';
    END IF;

    SELECT task.created_by, task.status, task.revision, task.intake_scope, release.code INTO intake
    FROM carbon.case_intake AS task
    JOIN carbon.scenario_release AS release
      ON (release.tenant_id, release.id) = (task.tenant_id, task.scenario_release_id)
    WHERE (task.tenant_id, task.org_id, task.id) = (NEW.tenant_id, NEW.org_id, NEW.case_id)
    FOR SHARE OF task;

    IF NOT FOUND OR intake.created_by = actor THEN
        RAISE EXCEPTION 'A product electricity profile requires an independent reviewer for the intake'
            USING ERRCODE = '42501';
    END IF;
    IF intake.status <> 'submitted' OR intake.revision <> NEW.submission_revision THEN
        RAISE EXCEPTION 'A product electricity profile requires the current submitted revision'
            USING ERRCODE = '23514', CONSTRAINT = 'product_electricity_profile_state';
    END IF;
    IF intake.code IS DISTINCT FROM 'product-footprint-prep'
       OR intake.intake_scope->>'subjectType' IS DISTINCT FROM 'product' THEN
        RAISE EXCEPTION 'An electricity profile requires a declared product-footprint intake'
            USING ERRCODE = '23514', CONSTRAINT = 'product_electricity_profile_scope';
    END IF;
    IF intake.intake_scope->>'reportingYear' IS NOT NULL
       AND intake.intake_scope->>'reportingYear' IS DISTINCT FROM to_char(NEW.from_period, 'YYYY') THEN
        RAISE EXCEPTION 'The production period must match the declared reporting year'
            USING ERRCODE = '23514', CONSTRAINT = 'product_electricity_profile_period';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER guard_product_electricity_profile
    BEFORE INSERT ON carbon.product_electricity_profile
    FOR EACH ROW EXECUTE FUNCTION carbon.guard_product_electricity_profile();
CREATE TRIGGER immutable_product_electricity_profile
    BEFORE UPDATE OR DELETE ON carbon.product_electricity_profile
    FOR EACH ROW EXECUTE FUNCTION carbon.reject_mutation();

REVOKE ALL ON FUNCTION carbon.guard_product_electricity_profile() FROM PUBLIC;
GRANT SELECT ON carbon.product_electricity_profile TO carbon_app;
GRANT INSERT (
    tenant_id, org_id, case_id, submission_revision, from_period, to_period, boundary_note, functional_unit,
    output_quantity, allocation_method, product_mass_kg, batch_mass_kg, allocation_basis, created_by, request_id
) ON carbon.product_electricity_profile TO carbon_app;
