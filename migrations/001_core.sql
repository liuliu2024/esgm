-- Empty-database baseline. The migration runner owns the transaction.
-- Bootstrap/provisioning and application connections use different roles.
DO $bootstrap$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'carbon_app') THEN
        CREATE ROLE carbon_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_roles AS r
        WHERE r.rolname = 'carbon_app'
          AND (r.rolcanlogin OR r.rolsuper OR r.rolbypassrls OR r.rolcreatedb
               OR r.rolcreaterole OR r.rolreplication OR EXISTS (
                   SELECT 1 FROM pg_catalog.pg_auth_members AS m WHERE m.member = r.oid
               ))
    ) THEN
        RAISE EXCEPTION 'carbon_app must be a restricted role with no memberships';
    END IF;
END;
$bootstrap$;

CREATE SCHEMA carbon;
REVOKE ALL ON SCHEMA carbon FROM PUBLIC;
GRANT USAGE ON SCHEMA carbon TO carbon_app;

CREATE TABLE carbon.workspace (
    id uuid PRIMARY KEY,
    name text NOT NULL CHECK (length(btrim(name)) > 0)
);

CREATE TABLE carbon.organization (
    tenant_id uuid NOT NULL REFERENCES carbon.workspace(id),
    id uuid NOT NULL,
    name text NOT NULL CHECK (length(btrim(name)) > 0),
    PRIMARY KEY (tenant_id, id)
);

CREATE TABLE carbon.org_grant (
    tenant_id uuid NOT NULL,
    org_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    role text NOT NULL CHECK (role IN ('customer', 'reviewer', 'admin')),
    PRIMARY KEY (tenant_id, org_id, actor_id, role),
    FOREIGN KEY (tenant_id, org_id) REFERENCES carbon.organization(tenant_id, id)
);
CREATE INDEX org_grant_by_actor ON carbon.org_grant (tenant_id, actor_id, org_id, role);

-- Only published releases enter this table. Corrections publish a new version.
CREATE TABLE carbon.scenario_release (
    tenant_id uuid NOT NULL REFERENCES carbon.workspace(id),
    id uuid NOT NULL,
    code text NOT NULL CHECK (length(btrim(code)) > 0),
    version integer NOT NULL CHECK (version > 0),
    manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'object'),
    PRIMARY KEY (tenant_id, id),
    UNIQUE (tenant_id, code, version)
);

CREATE TABLE carbon.case_intake (
    tenant_id uuid NOT NULL,
    id uuid NOT NULL,
    org_id uuid NOT NULL,
    scenario_release_id uuid NOT NULL,
    created_by uuid NOT NULL,
    purpose text NOT NULL CHECK (length(btrim(purpose)) > 0),
    status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'approved', 'returned')),
    return_reason text,
    revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
    PRIMARY KEY (tenant_id, id),
    UNIQUE (tenant_id, org_id, id),
    FOREIGN KEY (tenant_id, org_id) REFERENCES carbon.organization(tenant_id, id),
    FOREIGN KEY (tenant_id, scenario_release_id) REFERENCES carbon.scenario_release(tenant_id, id),
    CHECK ((status = 'returned') = (return_reason IS NOT NULL)),
    CHECK (length(btrim(return_reason)) BETWEEN 1 AND 500)
);
CREATE INDEX case_intake_by_org ON carbon.case_intake (tenant_id, org_id, status, id);
CREATE INDEX case_intake_by_release ON carbon.case_intake (tenant_id, scenario_release_id);

CREATE TABLE carbon.audit_event (
    tenant_id uuid NOT NULL,
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    org_id uuid NOT NULL,
    case_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    action text NOT NULL CHECK (action IN ('created', 'submitted', 'approved', 'returned')),
    reason text,
    revision integer NOT NULL CHECK (revision > 0),
    request_id text NOT NULL CHECK (length(btrim(request_id)) BETWEEN 1 AND 200),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, id),
    UNIQUE (tenant_id, case_id, revision),
    FOREIGN KEY (tenant_id, org_id, case_id) REFERENCES carbon.case_intake(tenant_id, org_id, id)
);
CREATE INDEX audit_event_by_org ON carbon.audit_event (tenant_id, org_id, created_at, id);

-- API establishes these settings transaction-locally only after authentication.
CREATE FUNCTION carbon.tenant_context() RETURNS uuid
LANGUAGE sql STABLE SET search_path = pg_catalog
AS $$ SELECT nullif(current_setting('carbon.tenant_id', true), '')::uuid $$;

CREATE FUNCTION carbon.actor_context() RETURNS uuid
LANGUAGE sql STABLE SET search_path = pg_catalog
AS $$ SELECT nullif(current_setting('carbon.actor_id', true), '')::uuid $$;

CREATE FUNCTION carbon.has_org_role(p_tenant uuid, p_org uuid, p_role text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog
AS $$
    SELECT EXISTS (
        SELECT 1 FROM carbon.org_grant AS g
        WHERE g.tenant_id = p_tenant AND g.org_id = p_org
          AND g.actor_id = carbon.actor_context() AND g.role = p_role
    )
$$;

-- Tenant predicates apply to every connection subject to RLS. Additional
-- restrictive policies constrain the runtime role to its authenticated actor.
ALTER TABLE carbon.workspace ENABLE ROW LEVEL SECURITY;
ALTER TABLE carbon.workspace FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON carbon.workspace
    USING (id = (SELECT carbon.tenant_context()))
    WITH CHECK (id = (SELECT carbon.tenant_context()));

DO $rls$
DECLARE
    table_name text;
BEGIN
    FOREACH table_name IN ARRAY ARRAY['organization', 'org_grant', 'scenario_release', 'case_intake', 'audit_event']
    LOOP
        EXECUTE format('ALTER TABLE carbon.%I ENABLE ROW LEVEL SECURITY', table_name);
        EXECUTE format('ALTER TABLE carbon.%I FORCE ROW LEVEL SECURITY', table_name);
        EXECUTE format(
            'CREATE POLICY tenant_boundary ON carbon.%I
             USING (tenant_id = (SELECT carbon.tenant_context()))
             WITH CHECK (tenant_id = (SELECT carbon.tenant_context()))',
            table_name
        );
    END LOOP;
END;
$rls$;

CREATE POLICY own_grants ON carbon.org_grant AS RESTRICTIVE TO carbon_app
    USING (actor_id = (SELECT carbon.actor_context()))
    WITH CHECK (false);

CREATE POLICY actor_workspace ON carbon.workspace AS RESTRICTIVE FOR SELECT TO carbon_app
    USING (EXISTS (SELECT 1 FROM carbon.org_grant AS g WHERE g.tenant_id = workspace.id));

CREATE POLICY actor_organization ON carbon.organization AS RESTRICTIVE FOR SELECT TO carbon_app
    USING (EXISTS (
        SELECT 1 FROM carbon.org_grant AS g
        WHERE g.tenant_id = organization.tenant_id AND g.org_id = organization.id
    ));

CREATE POLICY actor_releases ON carbon.scenario_release AS RESTRICTIVE FOR SELECT TO carbon_app
    USING (EXISTS (SELECT 1 FROM carbon.org_grant AS g WHERE g.tenant_id = scenario_release.tenant_id));

CREATE POLICY actor_case ON carbon.case_intake AS RESTRICTIVE TO carbon_app
    USING (
        carbon.has_org_role(tenant_id, org_id, 'admin')
        OR (status <> 'draft' AND carbon.has_org_role(tenant_id, org_id, 'reviewer'))
        OR (created_by = (SELECT carbon.actor_context()) AND carbon.has_org_role(tenant_id, org_id, 'customer'))
    )
    WITH CHECK (
        (status = 'draft' AND created_by = (SELECT carbon.actor_context())
            AND carbon.has_org_role(tenant_id, org_id, 'customer'))
        OR (status = 'submitted' AND created_by = (SELECT carbon.actor_context())
            AND carbon.has_org_role(tenant_id, org_id, 'customer'))
        OR (status IN ('approved', 'returned') AND created_by <> (SELECT carbon.actor_context())
            AND carbon.has_org_role(tenant_id, org_id, 'reviewer'))
    );

CREATE POLICY organization_audit ON carbon.audit_event AS RESTRICTIVE FOR SELECT TO carbon_app
    USING (carbon.has_org_role(tenant_id, org_id, 'admin'));

CREATE FUNCTION carbon.reject_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
BEGIN
    RAISE EXCEPTION 'Rows in carbon.% are immutable', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER immutable_scenario_release
    BEFORE UPDATE OR DELETE ON carbon.scenario_release
    FOR EACH ROW EXECUTE FUNCTION carbon.reject_mutation();
CREATE TRIGGER immutable_audit_event
    BEFORE UPDATE OR DELETE ON carbon.audit_event
    FOR EACH ROW EXECUTE FUNCTION carbon.reject_mutation();

CREATE FUNCTION carbon.guard_case_transition() RETURNS trigger
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
        IF NEW.status <> 'draft' OR NEW.revision <> 1 THEN
            RAISE EXCEPTION 'An intake must start as draft revision 1' USING ERRCODE = '23514';
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

    IF OLD.status = 'draft' AND NEW.status = 'submitted' THEN
        IF OLD.created_by IS DISTINCT FROM actor OR NOT carbon.has_org_role(OLD.tenant_id, OLD.org_id, 'customer') THEN
            RAISE EXCEPTION 'Only the intake creator may submit as a customer' USING ERRCODE = '42501';
        END IF;
    ELSIF OLD.status = 'submitted' AND NEW.status IN ('approved', 'returned') THEN
        IF OLD.created_by = actor OR NOT carbon.has_org_role(OLD.tenant_id, OLD.org_id, 'reviewer') THEN
            RAISE EXCEPTION 'An independent organization reviewer is required' USING ERRCODE = '42501';
        END IF;
    ELSE
        RAISE EXCEPTION 'Unsupported intake state transition' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER guard_case_intake
    BEFORE INSERT OR UPDATE ON carbon.case_intake
    FOR EACH ROW EXECUTE FUNCTION carbon.guard_case_transition();

-- The runtime role has no audit INSERT grant. The trigger uses its owner,
-- a fixed search path, qualified names and the transaction's tenant boundary.
CREATE FUNCTION carbon.append_case_audit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
BEGIN
    INSERT INTO carbon.audit_event (tenant_id, org_id, case_id, actor_id, action, reason, revision, request_id)
    VALUES (
        NEW.tenant_id, NEW.org_id, NEW.id, carbon.actor_context(),
        CASE WHEN TG_OP = 'INSERT' THEN 'created' ELSE NEW.status END,
        NEW.return_reason, NEW.revision, current_setting('carbon.request_id', true)
    );
    RETURN NULL;
END;
$$;

CREATE TRIGGER audit_case_intake
    AFTER INSERT OR UPDATE ON carbon.case_intake
    FOR EACH ROW EXECUTE FUNCTION carbon.append_case_audit();

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA carbon FROM PUBLIC;
GRANT EXECUTE ON FUNCTION carbon.tenant_context(), carbon.actor_context(), carbon.has_org_role(uuid, uuid, text) TO carbon_app;
GRANT SELECT ON carbon.workspace, carbon.organization, carbon.org_grant,
    carbon.scenario_release, carbon.case_intake, carbon.audit_event TO carbon_app;
GRANT INSERT (tenant_id, id, org_id, scenario_release_id, created_by, purpose) ON carbon.case_intake TO carbon_app;
GRANT UPDATE (status, revision, return_reason) ON carbon.case_intake TO carbon_app;
