CREATE TABLE catalog.factor_reference_disclosure (
    factor_id text NOT NULL,
    version integer NOT NULL,
    scope text NOT NULL CHECK (scope IN ('source_and_value', 'summary_only', 'internal_only')),
    basis text NOT NULL CHECK (basis ~ '[^[:space:]]'),
    PRIMARY KEY (factor_id, version),
    FOREIGN KEY (factor_id, version) REFERENCES catalog.factor_reference_version(factor_id, version)
);

-- Public official attachments are registered for individual citations only.
INSERT INTO catalog.factor_reference_disclosure (factor_id, version, scope, basis)
SELECT factor_id, version, 'source_and_value',
       '公开官方附件中的单条因子引用。应注明出处、单位、核算口径、适用年份及地域，不包含附件全文或因子库再分发。'
FROM catalog.factor_reference_version
WHERE version = 1 AND source_url IN (
    'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk01/202510/W020251024569470952545.pdf',
    'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk01/202512/W020251231726284332528.pdf',
    'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk01/202501/W020250123519612367413.pdf'
);

CREATE TRIGGER immutable_factor_reference_disclosure
    BEFORE UPDATE OR DELETE OR TRUNCATE ON catalog.factor_reference_disclosure
    FOR EACH STATEMENT EXECUTE FUNCTION catalog.reject_factor_reference_mutation();

CREATE FUNCTION catalog.factor_disclosure_scope(p_factor_id text, p_version integer) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog
AS $$
    SELECT coalesce((
        SELECT disclosure.scope
        FROM catalog.factor_reference_disclosure AS disclosure
        WHERE (disclosure.factor_id, disclosure.version) = (p_factor_id, p_version)
    ), 'internal_only')
$$;

-- The draft's source key is constrained by its frozen snapshot foreign key.
CREATE FUNCTION carbon.report_delivery_factor_scope(p_tenant uuid, p_org uuid, p_case uuid, p_draft uuid)
RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog
AS $$
    SELECT coalesce((
        SELECT catalog.factor_disclosure_scope(decision.factor_id, decision.factor_version)
        FROM carbon.internal_report_draft AS draft
        JOIN carbon.case_factor_decision AS decision
          ON (decision.tenant_id, decision.org_id, decision.case_id) =
             (draft.tenant_id, draft.org_id, draft.case_id)
          AND decision.submission_revision = CASE WHEN draft.payload->>'mode' = 'controlled'
              THEN draft.source_submission_key::integer END
        WHERE (draft.tenant_id, draft.org_id, draft.case_id, draft.id) = (p_tenant, p_org, p_case, p_draft)
    ), 'internal_only')
$$;

CREATE FUNCTION carbon.guard_report_delivery_factor_disclosure() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
DECLARE
    factor_scope text;
BEGIN
    factor_scope := carbon.report_delivery_factor_scope(NEW.tenant_id, NEW.org_id, NEW.case_id, NEW.draft_id);
    IF factor_scope = 'internal_only'
       OR (factor_scope = 'summary_only' AND (NEW.include_factor OR NEW.include_monthly)) THEN
        RAISE EXCEPTION 'The factor disclosure scope does not permit the requested delivery'
            USING ERRCODE = '23514', CONSTRAINT = 'report_delivery_factor_disclosure';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER guard_report_delivery_factor_disclosure
    BEFORE INSERT OR UPDATE ON carbon.internal_report_delivery
    FOR EACH ROW EXECUTE FUNCTION carbon.guard_report_delivery_factor_disclosure();

REVOKE ALL ON catalog.factor_reference_disclosure FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.factor_disclosure_scope(text, integer),
    carbon.report_delivery_factor_scope(uuid, uuid, uuid, uuid),
    carbon.guard_report_delivery_factor_disclosure() FROM PUBLIC;
GRANT SELECT ON catalog.factor_reference_disclosure TO carbon_app;
GRANT EXECUTE ON FUNCTION catalog.factor_disclosure_scope(text, integer),
    carbon.report_delivery_factor_scope(uuid, uuid, uuid, uuid) TO carbon_app;
