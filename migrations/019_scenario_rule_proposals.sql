-- Legacy releases are shared templates. Published organization releases must
-- remain private to the organization that proposed them.
ALTER TABLE carbon.scenario_release
    ADD COLUMN org_id uuid,
    ADD CONSTRAINT scenario_release_organization
        FOREIGN KEY (tenant_id, org_id) REFERENCES carbon.organization(tenant_id, id),
    DROP CONSTRAINT scenario_release_tenant_id_code_version_key,
    ADD CONSTRAINT scenario_release_scope_code_version
        UNIQUE NULLS NOT DISTINCT (tenant_id, org_id, code, version),
    ADD CONSTRAINT scenario_release_scope_identity UNIQUE (tenant_id, org_id, id);

ALTER POLICY actor_releases ON carbon.scenario_release USING (
    EXISTS (
        SELECT 1 FROM carbon.org_grant AS grant_row
        WHERE grant_row.tenant_id = scenario_release.tenant_id
          AND grant_row.actor_id = (SELECT carbon.actor_context())
          AND (scenario_release.org_id IS NULL OR grant_row.org_id = scenario_release.org_id)
    )
);

CREATE TABLE carbon.scenario_rule_proposal (
    tenant_id uuid NOT NULL,
    org_id uuid NOT NULL,
    id uuid NOT NULL,
    base_release_id uuid NOT NULL,
    references_payload jsonb NOT NULL CHECK (jsonb_typeof(references_payload) = 'array'),
    status text NOT NULL DEFAULT 'submitted',
    created_by uuid NOT NULL,
    request_id text NOT NULL CHECK (length(btrim(request_id)) BETWEEN 1 AND 200),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    reviewed_by uuid,
    review_request_id text CHECK (length(btrim(review_request_id)) BETWEEN 1 AND 200),
    reviewed_at timestamptz,
    review_note text CHECK (length(review_note) <= 500 AND review_note ~ '[^[:space:]]'),
    PRIMARY KEY (tenant_id, org_id, id),
    FOREIGN KEY (tenant_id, org_id) REFERENCES carbon.organization(tenant_id, id),
    FOREIGN KEY (tenant_id, base_release_id) REFERENCES carbon.scenario_release(tenant_id, id),
    CONSTRAINT scenario_rule_proposal_transition CHECK (
        (status = 'submitted' AND num_nonnulls(reviewed_by, review_request_id, reviewed_at, review_note) = 0)
        OR (status IN ('approved', 'returned') AND reviewed_by IS NOT NULL AND reviewed_by <> created_by
            AND review_request_id IS NOT NULL AND reviewed_at IS NOT NULL
            AND (status <> 'returned' OR review_note IS NOT NULL))
    )
);

CREATE TABLE carbon.scenario_rule_publication (
    tenant_id uuid NOT NULL,
    org_id uuid NOT NULL,
    proposal_id uuid NOT NULL,
    release_id uuid NOT NULL,
    published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, org_id, proposal_id),
    UNIQUE (tenant_id, release_id),
    FOREIGN KEY (tenant_id, org_id, proposal_id)
        REFERENCES carbon.scenario_rule_proposal(tenant_id, org_id, id),
    FOREIGN KEY (tenant_id, org_id, release_id) REFERENCES carbon.scenario_release(tenant_id, org_id, id)
);

ALTER TABLE carbon.scenario_rule_proposal ENABLE ROW LEVEL SECURITY;
ALTER TABLE carbon.scenario_rule_proposal FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON carbon.scenario_rule_proposal
    USING (tenant_id = (SELECT carbon.tenant_context()))
    WITH CHECK (tenant_id = (SELECT carbon.tenant_context()));
CREATE POLICY actor_proposal_read ON carbon.scenario_rule_proposal AS RESTRICTIVE FOR SELECT TO carbon_app
    USING (carbon.has_org_role(tenant_id, org_id, 'admin') OR carbon.has_org_role(tenant_id, org_id, 'reviewer'));
CREATE POLICY actor_proposal_submit ON carbon.scenario_rule_proposal AS RESTRICTIVE FOR INSERT TO carbon_app
    WITH CHECK (created_by = (SELECT carbon.actor_context()) AND carbon.has_org_role(tenant_id, org_id, 'admin'));
CREATE POLICY actor_proposal_review ON carbon.scenario_rule_proposal AS RESTRICTIVE FOR UPDATE TO carbon_app
    USING (created_by <> (SELECT carbon.actor_context()) AND carbon.has_org_role(tenant_id, org_id, 'reviewer'))
    WITH CHECK (reviewed_by = (SELECT carbon.actor_context()) AND carbon.has_org_role(tenant_id, org_id, 'reviewer'));

ALTER TABLE carbon.scenario_rule_publication ENABLE ROW LEVEL SECURITY;
ALTER TABLE carbon.scenario_rule_publication FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON carbon.scenario_rule_publication
    USING (tenant_id = (SELECT carbon.tenant_context()))
    WITH CHECK (tenant_id = (SELECT carbon.tenant_context()));
CREATE POLICY actor_publication_read ON carbon.scenario_rule_publication AS RESTRICTIVE FOR SELECT TO carbon_app
    USING (carbon.has_org_role(tenant_id, org_id, 'admin') OR carbon.has_org_role(tenant_id, org_id, 'reviewer'));

CREATE FUNCTION carbon.guard_scenario_rule_proposal() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
DECLARE
    actor uuid := carbon.actor_context();
    request_id text := current_setting('carbon.request_id', true);
BEGIN
    IF actor IS NULL OR NEW.tenant_id IS DISTINCT FROM carbon.tenant_context() THEN
        RAISE EXCEPTION 'Workspace and actor context are required' USING ERRCODE = '42501';
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF NEW.created_by IS DISTINCT FROM actor OR NOT carbon.has_org_role(NEW.tenant_id, NEW.org_id, 'admin') THEN
            RAISE EXCEPTION 'Only an organization administrator can submit a proposal as themselves'
                USING ERRCODE = '42501';
        END IF;
        IF NEW.status <> 'submitted' OR NEW.request_id IS DISTINCT FROM request_id THEN
            RAISE EXCEPTION 'A rule proposal must begin as submitted'
                USING ERRCODE = '23514', CONSTRAINT = 'scenario_rule_proposal_transition';
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM carbon.scenario_release AS release
            WHERE (release.tenant_id, release.id) = (NEW.tenant_id, NEW.base_release_id)
              AND (release.org_id IS NULL OR release.org_id = NEW.org_id)
        ) THEN
            RAISE EXCEPTION 'The proposal requires a shared or same-organization base release'
                USING ERRCODE = '23514', CONSTRAINT = 'scenario_rule_proposal_base_scope';
        END IF;
    ELSE
        IF (NEW.tenant_id, NEW.org_id, NEW.id, NEW.base_release_id, NEW.references_payload,
            NEW.created_by, NEW.request_id, NEW.created_at) IS DISTINCT FROM
           (OLD.tenant_id, OLD.org_id, OLD.id, OLD.base_release_id, OLD.references_payload,
            OLD.created_by, OLD.request_id, OLD.created_at) THEN
            RAISE EXCEPTION 'The submitted proposal is immutable' USING ERRCODE = '55000';
        END IF;
        IF OLD.created_by = actor OR NEW.reviewed_by IS DISTINCT FROM actor
           OR NOT carbon.has_org_role(NEW.tenant_id, NEW.org_id, 'reviewer') THEN
            RAISE EXCEPTION 'An independent organization reviewer is required' USING ERRCODE = '42501';
        END IF;
        IF OLD.status <> 'submitted' OR NEW.status NOT IN ('approved', 'returned')
           OR NEW.review_request_id IS DISTINCT FROM request_id THEN
            RAISE EXCEPTION 'A submitted proposal can receive one review decision'
                USING ERRCODE = '23514', CONSTRAINT = 'scenario_rule_proposal_transition';
        END IF;
        NEW.reviewed_at := clock_timestamp();
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER guard_scenario_rule_proposal
    BEFORE INSERT OR UPDATE ON carbon.scenario_rule_proposal
    FOR EACH ROW EXECUTE FUNCTION carbon.guard_scenario_rule_proposal();
CREATE TRIGGER immutable_scenario_rule_proposal
    BEFORE DELETE ON carbon.scenario_rule_proposal
    FOR EACH ROW EXECUTE FUNCTION carbon.reject_mutation();
CREATE TRIGGER immutable_scenario_rule_publication
    BEFORE UPDATE OR DELETE ON carbon.scenario_rule_publication
    FOR EACH ROW EXECUTE FUNCTION carbon.reject_mutation();

-- Count across this organization's task owners without exposing their rows.
-- The migration owner remains subject to the tenant boundary under FORCE RLS.
CREATE FUNCTION carbon.rule_impact_dependencies(p_org uuid, p_release uuid)
RETURNS TABLE (factor_count integer, model_count integer, report_count integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
    tenant uuid := carbon.tenant_context();
BEGIN
    IF tenant IS NULL OR carbon.actor_context() IS NULL OR NOT carbon.has_org_role(tenant, p_org, 'admin') THEN
        RAISE EXCEPTION 'Organization administrator access required' USING ERRCODE = '42501';
    END IF;
    RETURN QUERY
    WITH affected AS (
        SELECT intake.tenant_id, intake.org_id, intake.id
        FROM carbon.case_intake AS intake
        WHERE (intake.tenant_id, intake.org_id, intake.scenario_release_id) = (tenant, p_org, p_release)
    )
    SELECT
        (SELECT count(*)::integer FROM affected JOIN carbon.case_factor_decision AS decision
         ON (decision.tenant_id, decision.org_id, decision.case_id) = (affected.tenant_id, affected.org_id, affected.id)),
        (SELECT count(*)::integer FROM affected JOIN carbon.calculation_snapshot AS snapshot
         ON (snapshot.tenant_id, snapshot.org_id, snapshot.case_id) = (affected.tenant_id, affected.org_id, affected.id)),
        (SELECT count(*)::integer FROM affected JOIN carbon.internal_report_draft AS draft
         ON (draft.tenant_id, draft.org_id, draft.case_id) = (affected.tenant_id, affected.org_id, affected.id));
END;
$$;

REVOKE ALL ON FUNCTION carbon.guard_scenario_rule_proposal(), carbon.rule_impact_dependencies(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION carbon.rule_impact_dependencies(uuid, uuid) TO carbon_app;
GRANT SELECT ON carbon.scenario_rule_proposal, carbon.scenario_rule_publication TO carbon_app;
GRANT INSERT (tenant_id, org_id, id, base_release_id, references_payload, created_by, request_id)
    ON carbon.scenario_rule_proposal TO carbon_app;
GRANT UPDATE (status, reviewed_by, review_request_id, review_note)
    ON carbon.scenario_rule_proposal TO carbon_app;

ALTER TABLE carbon.case_intake
    ADD COLUMN rule_recalculation_of uuid,
    ADD CONSTRAINT case_intake_rule_recalculation_parent
        FOREIGN KEY (tenant_id, org_id, rule_recalculation_of)
        REFERENCES carbon.case_intake(tenant_id, org_id, id);

CREATE FUNCTION carbon.guard_case_scenario_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM carbon.scenario_release AS release
        WHERE (release.tenant_id, release.id) = (NEW.tenant_id, NEW.scenario_release_id)
          AND (release.org_id IS NULL OR release.org_id = NEW.org_id)
    ) THEN
        RAISE EXCEPTION 'The case requires a shared or same-organization scenario release'
            USING ERRCODE = '23503', CONSTRAINT = 'case_intake_scenario_scope';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER guard_case_scenario_scope
    BEFORE INSERT ON carbon.case_intake
    FOR EACH ROW EXECUTE FUNCTION carbon.guard_case_scenario_scope();

CREATE FUNCTION carbon.guard_rule_recalculation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF NEW.rule_recalculation_of IS DISTINCT FROM OLD.rule_recalculation_of THEN
            RAISE EXCEPTION 'The recalculation source is immutable' USING ERRCODE = '55000';
        END IF;
    ELSIF NEW.rule_recalculation_of IS NOT NULL THEN
        PERFORM 1
        FROM carbon.case_intake AS parent
        JOIN carbon.scenario_release AS previous
          ON (previous.tenant_id, previous.id) = (parent.tenant_id, parent.scenario_release_id)
        JOIN carbon.scenario_release AS next_release
          ON (next_release.tenant_id, next_release.id) = (NEW.tenant_id, NEW.scenario_release_id)
        WHERE (parent.tenant_id, parent.org_id, parent.id) =
            (NEW.tenant_id, NEW.org_id, NEW.rule_recalculation_of)
          AND parent.created_by = NEW.created_by
          AND parent.status IN ('submitted', 'approved')
          AND parent.purpose = NEW.purpose
          AND parent.intake_scope IS NOT DISTINCT FROM NEW.intake_scope
          AND previous.code = next_release.code AND next_release.version > previous.version
          AND (next_release.org_id IS NULL OR next_release.org_id = parent.org_id)
        FOR SHARE OF parent;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'A recalculation requires the applicant''s submitted or approved task and a newer matching release'
                USING ERRCODE = '23514', CONSTRAINT = 'case_intake_rule_recalculation_source';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER guard_rule_recalculation
    BEFORE INSERT OR UPDATE OF rule_recalculation_of ON carbon.case_intake
    FOR EACH ROW EXECUTE FUNCTION carbon.guard_rule_recalculation();

REVOKE ALL ON FUNCTION carbon.guard_case_scenario_scope(), carbon.guard_rule_recalculation() FROM PUBLIC;
GRANT INSERT (rule_recalculation_of) ON carbon.case_intake TO carbon_app;
