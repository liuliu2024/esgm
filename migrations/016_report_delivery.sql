CREATE TABLE carbon.internal_report_delivery (
    tenant_id uuid NOT NULL,
    org_id uuid NOT NULL,
    case_id uuid NOT NULL,
    draft_id uuid NOT NULL,
    id uuid NOT NULL,
    created_by uuid NOT NULL,
    request_id text NOT NULL CHECK (length(btrim(request_id)) BETWEEN 1 AND 200),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    recipient text NOT NULL CHECK (length(recipient) <= 120 AND recipient ~ '[^[:space:]]'),
    purpose text NOT NULL CHECK (length(purpose) <= 300 AND purpose ~ '[^[:space:]]'),
    include_monthly boolean NOT NULL,
    include_factor boolean NOT NULL,
    document_html text NOT NULL CHECK (length(document_html) > 0),
    document_sha256 text NOT NULL CHECK (document_sha256 = encode(sha256(convert_to(document_html, 'UTF8')), 'hex')),
    recorded_at timestamptz,
    recorded_by uuid,
    recorded_request_id text CHECK (length(btrim(recorded_request_id)) BETWEEN 1 AND 200),
    delivery_reference text CHECK (length(delivery_reference) <= 300 AND delivery_reference ~ '[^[:space:]]'),
    PRIMARY KEY (tenant_id, org_id, case_id, draft_id, id),
    FOREIGN KEY (tenant_id, org_id, case_id, draft_id)
        REFERENCES carbon.internal_report_review(tenant_id, org_id, case_id, draft_id),
    CONSTRAINT internal_report_delivery_options_key
        UNIQUE (tenant_id, org_id, case_id, draft_id, recipient, purpose, include_monthly, include_factor),
    CHECK (num_nonnulls(recorded_at, recorded_by, recorded_request_id, delivery_reference) IN (0, 4))
);

ALTER TABLE carbon.internal_report_delivery ENABLE ROW LEVEL SECURITY;
ALTER TABLE carbon.internal_report_delivery FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON carbon.internal_report_delivery
    USING (tenant_id = (SELECT carbon.tenant_context()))
    WITH CHECK (tenant_id = (SELECT carbon.tenant_context()));
CREATE POLICY actor_report_delivery ON carbon.internal_report_delivery AS RESTRICTIVE TO carbon_app
    USING (
        created_by = (SELECT carbon.actor_context())
        AND carbon.has_org_role(tenant_id, org_id, 'customer')
        AND EXISTS (
            SELECT 1 FROM carbon.case_intake AS intake
            WHERE (intake.tenant_id, intake.org_id, intake.id) =
                (internal_report_delivery.tenant_id, internal_report_delivery.org_id, internal_report_delivery.case_id)
              AND intake.created_by = internal_report_delivery.created_by
        )
    );

CREATE FUNCTION carbon.guard_internal_report_delivery() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
DECLARE
    actor uuid := carbon.actor_context();
    request_id text := current_setting('carbon.request_id', true);
    intake_status text;
    review_status text;
    report_mode text;
    report_coverage text;
    report_revision text;
    latest_revision integer;
BEGIN
    IF actor IS NULL OR NEW.tenant_id IS DISTINCT FROM carbon.tenant_context()
       OR NEW.created_by IS DISTINCT FROM actor
       OR NOT carbon.has_org_role(NEW.tenant_id, NEW.org_id, 'customer') THEN
        RAISE EXCEPTION 'Only the customer who created the intake can manage report delivery'
            USING ERRCODE = '42501';
    END IF;

    -- Serialize generation and delivery recording with transitions of this task.
    SELECT intake.status INTO intake_status
    FROM carbon.case_intake AS intake
    WHERE (intake.tenant_id, intake.org_id, intake.id) = (NEW.tenant_id, NEW.org_id, NEW.case_id)
      AND intake.created_by = actor
    FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Report intake is not visible' USING ERRCODE = '42501';
    END IF;

    SELECT review.status, draft.payload->>'mode', draft.payload#>>'{report,summary,coverage,status}',
           draft.source_submission_key
    INTO review_status, report_mode, report_coverage, report_revision
    FROM carbon.internal_report_review AS review
    JOIN carbon.internal_report_draft AS draft
      ON (draft.tenant_id, draft.org_id, draft.case_id, draft.id)
       = (review.tenant_id, review.org_id, review.case_id, review.draft_id)
    WHERE (review.tenant_id, review.org_id, review.case_id, review.draft_id)
        = (NEW.tenant_id, NEW.org_id, NEW.case_id, NEW.draft_id);

    SELECT max(submission.revision) INTO latest_revision
    FROM carbon.case_submission AS submission
    WHERE (submission.tenant_id, submission.org_id, submission.case_id)
        = (NEW.tenant_id, NEW.org_id, NEW.case_id);

    IF intake_status NOT IN ('submitted', 'approved')
       OR review_status IS DISTINCT FROM 'reviewed'
       OR report_mode IS DISTINCT FROM 'controlled'
       OR report_coverage IS DISTINCT FROM 'complete'
       OR report_revision IS DISTINCT FROM latest_revision::text THEN
        RAISE EXCEPTION 'Delivery requires the current reviewed, complete controlled report'
            USING ERRCODE = '23514', CONSTRAINT = 'internal_report_delivery_source_conflict';
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF NEW.request_id IS DISTINCT FROM request_id
           OR num_nonnulls(NEW.recorded_at, NEW.recorded_by, NEW.recorded_request_id, NEW.delivery_reference) <> 0 THEN
            RAISE EXCEPTION 'A report delivery must begin without a delivery record'
                USING ERRCODE = '23514', CONSTRAINT = 'internal_report_delivery_source_conflict';
        END IF;
    ELSE
        IF (NEW.tenant_id, NEW.org_id, NEW.case_id, NEW.draft_id, NEW.id, NEW.created_by, NEW.request_id,
            NEW.created_at, NEW.recipient, NEW.purpose, NEW.include_monthly, NEW.include_factor,
            NEW.document_html, NEW.document_sha256)
           IS DISTINCT FROM
           (OLD.tenant_id, OLD.org_id, OLD.case_id, OLD.draft_id, OLD.id, OLD.created_by, OLD.request_id,
            OLD.created_at, OLD.recipient, OLD.purpose, OLD.include_monthly, OLD.include_factor,
            OLD.document_html, OLD.document_sha256) THEN
            RAISE EXCEPTION 'The report delivery snapshot is immutable' USING ERRCODE = '55000';
        END IF;
        IF OLD.recorded_at IS NOT NULL OR NEW.recorded_at IS NOT NULL
           OR NEW.recorded_by IS DISTINCT FROM actor
           OR NEW.recorded_request_id IS DISTINCT FROM request_id
           OR NEW.delivery_reference IS NULL THEN
            RAISE EXCEPTION 'A report delivery can be recorded only once by the current customer'
                USING ERRCODE = '23514', CONSTRAINT = 'internal_report_delivery_source_conflict';
        END IF;
        NEW.recorded_at := clock_timestamp();
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER guard_internal_report_delivery
    BEFORE INSERT OR UPDATE ON carbon.internal_report_delivery
    FOR EACH ROW EXECUTE FUNCTION carbon.guard_internal_report_delivery();
CREATE TRIGGER immutable_internal_report_delivery
    BEFORE DELETE ON carbon.internal_report_delivery
    FOR EACH ROW EXECUTE FUNCTION carbon.reject_mutation();

REVOKE ALL ON FUNCTION carbon.guard_internal_report_delivery() FROM PUBLIC;
GRANT SELECT ON carbon.internal_report_delivery TO carbon_app;
GRANT INSERT (tenant_id, org_id, case_id, draft_id, id, created_by, request_id, recipient, purpose,
    include_monthly, include_factor, document_html, document_sha256) ON carbon.internal_report_delivery TO carbon_app;
GRANT UPDATE (recorded_by, recorded_request_id, delivery_reference) ON carbon.internal_report_delivery TO carbon_app;
