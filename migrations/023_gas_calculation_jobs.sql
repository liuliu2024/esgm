DO $bootstrap$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'carbon_calculation_worker') THEN
        CREATE ROLE carbon_calculation_worker NOLOGIN NOSUPERUSER NOBYPASSRLS
            NOCREATEDB NOCREATEROLE NOREPLICATION;
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles AS role
        WHERE role.rolname = 'carbon_calculation_worker'
          AND (role.rolcanlogin OR role.rolsuper OR role.rolbypassrls OR role.rolcreatedb
               OR role.rolcreaterole OR role.rolreplication OR EXISTS (
                   SELECT 1 FROM pg_catalog.pg_auth_members AS member WHERE member.member = role.oid
               ))
    ) OR pg_catalog.pg_has_role('carbon_app', 'carbon_calculation_worker', 'MEMBER') THEN
        RAISE EXCEPTION 'The calculation worker must be a restricted role separate from carbon_app';
    END IF;
END;
$bootstrap$;

CREATE TABLE carbon.calculation_worker_tenant_grant (
    login_role regrole NOT NULL,
    tenant_id uuid NOT NULL REFERENCES carbon.workspace(id),
    PRIMARY KEY (login_role, tenant_id)
);
REVOKE ALL ON carbon.calculation_worker_tenant_grant FROM PUBLIC, carbon_app, carbon_calculation_worker;

CREATE TABLE carbon.gas_calculation_job (
    tenant_id uuid NOT NULL,
    org_id uuid NOT NULL,
    case_id uuid NOT NULL,
    submission_revision integer NOT NULL,
    id uuid NOT NULL,
    from_period date NOT NULL,
    to_period date NOT NULL,
    created_by uuid NOT NULL,
    request_id text NOT NULL CHECK (length(request_id) <= 200 AND request_id ~ '[^[:space:]]'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    status text NOT NULL DEFAULT 'queued',
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    lease_token uuid,
    lease_expires_at timestamptz,
    snapshot_id uuid,
    error_code text CHECK (length(error_code) <= 200 AND error_code ~ '[^[:space:]]'),
    PRIMARY KEY (tenant_id, org_id, case_id, id),
    UNIQUE (tenant_id, id),
    CONSTRAINT gas_calculation_job_input_key UNIQUE (
        tenant_id, org_id, case_id, submission_revision, from_period, to_period
    ),
    FOREIGN KEY (tenant_id, org_id, case_id, submission_revision)
        REFERENCES carbon.case_submission(tenant_id, org_id, case_id, revision),
    FOREIGN KEY (tenant_id, org_id, case_id, submission_revision, snapshot_id)
        REFERENCES carbon.model_trial_snapshot(tenant_id, org_id, case_id, submission_revision, id),
    CONSTRAINT gas_calculation_job_period CHECK (
        from_period >= DATE '2026-01-01' AND to_period < DATE '2027-01-01'
        AND from_period <= to_period AND extract(day FROM from_period) = 1 AND extract(day FROM to_period) = 1
    ),
    CONSTRAINT gas_calculation_job_shape CHECK (
        (status = 'running' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL
            AND snapshot_id IS NULL AND error_code IS NULL)
        OR (status = 'succeeded' AND lease_token IS NULL AND lease_expires_at IS NULL
            AND snapshot_id IS NOT NULL AND error_code IS NULL)
        OR (status = 'failed' AND lease_token IS NULL AND lease_expires_at IS NULL
            AND snapshot_id IS NULL AND error_code IS NOT NULL)
        OR (status IN ('queued', 'cancelled') AND lease_token IS NULL AND lease_expires_at IS NULL
            AND snapshot_id IS NULL AND error_code IS NULL)
    )
);
CREATE INDEX gas_calculation_job_queue ON carbon.gas_calculation_job (tenant_id, created_at, id)
    WHERE status IN ('queued', 'running');

ALTER TABLE carbon.gas_calculation_job ENABLE ROW LEVEL SECURITY;
ALTER TABLE carbon.gas_calculation_job FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON carbon.gas_calculation_job
    USING (tenant_id = (SELECT carbon.tenant_context()))
    WITH CHECK (tenant_id = (SELECT carbon.tenant_context()));
CREATE POLICY actor_gas_calculation_job ON carbon.gas_calculation_job AS RESTRICTIVE TO carbon_app
    USING (
        created_by = (SELECT carbon.actor_context())
        AND carbon.has_org_role(tenant_id, org_id, 'customer')
        AND EXISTS (
            SELECT 1 FROM carbon.case_intake AS intake
            WHERE (intake.tenant_id, intake.org_id, intake.id) =
                (gas_calculation_job.tenant_id, gas_calculation_job.org_id, gas_calculation_job.case_id)
              AND intake.created_by = gas_calculation_job.created_by
        )
    );

CREATE FUNCTION carbon.guard_gas_calculation_job() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
DECLARE
    actor uuid := carbon.actor_context();
    intake record;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF (NEW.tenant_id, NEW.org_id, NEW.case_id, NEW.submission_revision, NEW.id, NEW.from_period,
            NEW.to_period, NEW.created_by, NEW.request_id, NEW.created_at) IS DISTINCT FROM
           (OLD.tenant_id, OLD.org_id, OLD.case_id, OLD.submission_revision, OLD.id, OLD.from_period,
            OLD.to_period, OLD.created_by, OLD.request_id, OLD.created_at) THEN
            RAISE EXCEPTION 'The calculation job identity and input are immutable' USING ERRCODE = '55000';
        END IF;
        IF current_user <> pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = TG_RELID))
           AND NOT (
               (OLD.status = 'queued' AND NEW.status = 'cancelled')
               OR (OLD.status IN ('failed', 'cancelled') AND NEW.status = 'queued')
           ) THEN
            RAISE EXCEPTION 'The requested application job transition is not allowed'
                USING ERRCODE = '23514', CONSTRAINT = 'gas_calculation_job_transition';
        END IF;
        NEW.updated_at := clock_timestamp();
        RETURN NEW;
    END IF;

    IF actor IS NULL OR NEW.tenant_id IS DISTINCT FROM carbon.tenant_context()
       OR NEW.created_by IS DISTINCT FROM actor
       OR NOT carbon.has_org_role(NEW.tenant_id, NEW.org_id, 'customer') THEN
        RAISE EXCEPTION 'Only the organization customer can enqueue a calculation as themselves'
            USING ERRCODE = '42501';
    END IF;
    IF NEW.status <> 'queued' OR NEW.attempts <> 0
       OR NEW.request_id IS DISTINCT FROM current_setting('carbon.request_id', true) THEN
        RAISE EXCEPTION 'A calculation job must begin queued'
            USING ERRCODE = '23514', CONSTRAINT = 'gas_calculation_job_transition';
    END IF;

    SELECT task.status, task.revision, task.intake_scope, release.code INTO intake
    FROM carbon.case_intake AS task
    JOIN carbon.scenario_release AS release
      ON (release.tenant_id, release.id) = (task.tenant_id, task.scenario_release_id)
    WHERE (task.tenant_id, task.org_id, task.id) = (NEW.tenant_id, NEW.org_id, NEW.case_id)
      AND task.created_by = actor
    FOR SHARE OF task;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Only the intake creator may enqueue its calculation' USING ERRCODE = '42501';
    END IF;
    IF intake.status NOT IN ('submitted', 'approved')
       OR NEW.submission_revision <> (CASE WHEN intake.status = 'approved' THEN intake.revision - 1 ELSE intake.revision END)
       OR intake.code IS DISTINCT FROM 'power-generation-combustion'
       OR intake.intake_scope->>'subjectType' IS DISTINCT FROM 'facility'
       OR intake.intake_scope->>'reportingYear' IS DISTINCT FROM '2026' THEN
        RAISE EXCEPTION 'A calculation job requires the current effective facility submission'
            USING ERRCODE = '23514', CONSTRAINT = 'gas_calculation_job_submission_state';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER guard_gas_calculation_job
    BEFORE INSERT OR UPDATE ON carbon.gas_calculation_job
    FOR EACH ROW EXECUTE FUNCTION carbon.guard_gas_calculation_job();
CREATE TRIGGER immutable_gas_calculation_job
    BEFORE DELETE ON carbon.gas_calculation_job
    FOR EACH ROW EXECUTE FUNCTION carbon.reject_mutation();

CREATE FUNCTION carbon.claim_gas_calculation_job(p_tenant uuid, p_lease uuid)
RETURNS TABLE (
    id uuid, org_id uuid, case_id uuid, submission_revision integer, created_by uuid, from_period date, to_period date
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
BEGIN
    IF p_tenant IS NULL OR p_tenant IS DISTINCT FROM carbon.tenant_context() OR p_lease IS NULL
       OR NOT EXISTS (
           SELECT 1 FROM carbon.calculation_worker_tenant_grant AS worker_grant
           WHERE worker_grant.login_role = quote_ident(SESSION_USER)::regrole AND worker_grant.tenant_id = p_tenant
       ) THEN
        RETURN;
    END IF;
    RETURN QUERY
    WITH next_job AS (
        SELECT job.id FROM carbon.gas_calculation_job AS job
        WHERE job.tenant_id = p_tenant
          AND (job.status = 'queued' OR (job.status = 'running' AND job.lease_expires_at <= clock_timestamp()))
        ORDER BY job.created_at, job.id
        LIMIT 1 FOR UPDATE SKIP LOCKED
    )
    UPDATE carbon.gas_calculation_job AS job
    SET status = 'running', attempts = job.attempts + 1, lease_token = p_lease,
        lease_expires_at = clock_timestamp() + interval '2 minutes'
    FROM next_job
    WHERE job.tenant_id = p_tenant AND job.id = next_job.id
    RETURNING job.id, job.org_id, job.case_id, job.submission_revision, job.created_by, job.from_period, job.to_period;
END;
$$;

CREATE FUNCTION carbon.finish_gas_calculation_job(p_tenant uuid, p_id uuid, p_lease uuid, p_snapshot uuid, p_error text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
BEGIN
    IF p_tenant IS NULL OR p_tenant IS DISTINCT FROM carbon.tenant_context()
       OR p_id IS NULL OR p_lease IS NULL OR (p_snapshot IS NULL) = (p_error IS NULL)
       OR (p_error IS NOT NULL AND (length(p_error) > 200 OR p_error !~ '[^[:space:]]'))
       OR NOT EXISTS (
           SELECT 1 FROM carbon.calculation_worker_tenant_grant AS worker_grant
           WHERE worker_grant.login_role = quote_ident(SESSION_USER)::regrole AND worker_grant.tenant_id = p_tenant
       ) THEN
        RETURN false;
    END IF;
    UPDATE carbon.gas_calculation_job AS job
    SET status = CASE WHEN p_snapshot IS NULL THEN 'failed' ELSE 'succeeded' END,
        snapshot_id = p_snapshot, error_code = p_error, lease_token = NULL, lease_expires_at = NULL
    WHERE job.tenant_id = p_tenant AND job.id = p_id AND job.status = 'running'
      AND job.lease_token = p_lease AND job.lease_expires_at > clock_timestamp()
      AND (p_snapshot IS NULL OR EXISTS (
          SELECT 1 FROM carbon.model_trial_snapshot AS snapshot
          WHERE (snapshot.tenant_id, snapshot.org_id, snapshot.case_id, snapshot.submission_revision, snapshot.id,
                 snapshot.from_period, snapshot.to_period) =
                (job.tenant_id, job.org_id, job.case_id, job.submission_revision, p_snapshot, job.from_period, job.to_period)
      ));
    RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION carbon.guard_gas_calculation_job(),
    carbon.claim_gas_calculation_job(uuid, uuid),
    carbon.finish_gas_calculation_job(uuid, uuid, uuid, uuid, text) FROM PUBLIC;
GRANT USAGE ON SCHEMA carbon TO carbon_calculation_worker;
GRANT EXECUTE ON FUNCTION carbon.claim_gas_calculation_job(uuid, uuid),
    carbon.finish_gas_calculation_job(uuid, uuid, uuid, uuid, text) TO carbon_calculation_worker;
GRANT SELECT ON carbon.gas_calculation_job TO carbon_app;
GRANT INSERT (
    tenant_id, org_id, case_id, submission_revision, id, from_period, to_period, created_by, request_id
) ON carbon.gas_calculation_job TO carbon_app;
GRANT UPDATE (status, error_code) ON carbon.gas_calculation_job TO carbon_app;
