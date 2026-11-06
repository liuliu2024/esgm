CREATE TABLE carbon.ingestion_batch (
    tenant_id uuid NOT NULL,
    org_id uuid NOT NULL,
    case_id uuid NOT NULL,
    id uuid NOT NULL,
    source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
    template_version text NOT NULL CHECK (template_version = 'activity-csv-v1'),
    source_csv text NOT NULL CHECK (octet_length(source_csv) BETWEEN 1 AND 8192),
    created_by uuid NOT NULL,
    request_id text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, org_id, case_id, id),
    UNIQUE (tenant_id, org_id, case_id, template_version, source_sha256),
    FOREIGN KEY (tenant_id, org_id, case_id) REFERENCES carbon.case_intake(tenant_id, org_id, id)
);

CREATE TABLE carbon.ingestion_preview (
    tenant_id uuid NOT NULL,
    org_id uuid NOT NULL,
    case_id uuid NOT NULL,
    batch_id uuid NOT NULL,
    revision integer NOT NULL CHECK (revision > 0),
    status text NOT NULL CHECK (status IN ('ready', 'blocked')),
    summary jsonb NOT NULL CHECK (jsonb_typeof(summary) = 'object'),
    issues jsonb NOT NULL CHECK (jsonb_typeof(issues) = 'array'),
    preview jsonb NOT NULL CHECK (jsonb_typeof(preview) = 'array'),
    created_by uuid NOT NULL,
    request_id text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, org_id, case_id, batch_id, revision),
    FOREIGN KEY (tenant_id, org_id, case_id, batch_id)
        REFERENCES carbon.ingestion_batch(tenant_id, org_id, case_id, id)
);

CREATE TABLE carbon.ingestion_commit (
    tenant_id uuid NOT NULL,
    org_id uuid NOT NULL,
    case_id uuid NOT NULL,
    batch_id uuid NOT NULL,
    preview_revision integer NOT NULL,
    inserted integer NOT NULL CHECK (inserted >= 0),
    corrected integer NOT NULL CHECK (corrected >= 0),
    unchanged integer NOT NULL CHECK (unchanged >= 0),
    committed_by uuid NOT NULL,
    request_id text NOT NULL,
    committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, org_id, case_id, batch_id),
    FOREIGN KEY (tenant_id, org_id, case_id, batch_id, preview_revision)
        REFERENCES carbon.ingestion_preview(tenant_id, org_id, case_id, batch_id, revision)
);

CREATE TABLE carbon.activity_record_revision (
    tenant_id uuid NOT NULL,
    org_id uuid NOT NULL,
    case_id uuid NOT NULL,
    period date NOT NULL CHECK (extract(day FROM period) = 1),
    source text NOT NULL,
    revision integer NOT NULL CHECK (revision > 0),
    quantity numeric NOT NULL CHECK (quantity >= 0 AND quantity < 'Infinity'::numeric),
    unit text NOT NULL CHECK ((source = 'electricity' AND unit = 'kWh') OR (source = 'natural_gas' AND unit = 'm3')),
    original_quantity text NOT NULL,
    original_unit text NOT NULL,
    conversion_version text NOT NULL,
    source_type text NOT NULL CHECK (source_type = 'manual_csv'),
    batch_id uuid NOT NULL,
    preview_revision integer NOT NULL,
    source_row integer NOT NULL CHECK (source_row >= 2),
    PRIMARY KEY (tenant_id, org_id, case_id, period, source, revision),
    FOREIGN KEY (tenant_id, org_id, case_id, batch_id, preview_revision)
        REFERENCES carbon.ingestion_preview(tenant_id, org_id, case_id, batch_id, revision)
);

DO $ledger_policies$
DECLARE
    ledger_table text;
BEGIN
    FOREACH ledger_table IN ARRAY ARRAY[
        'ingestion_batch', 'ingestion_preview', 'ingestion_commit', 'activity_record_revision'
    ]
    LOOP
        EXECUTE format('ALTER TABLE carbon.%I ENABLE ROW LEVEL SECURITY', ledger_table);
        EXECUTE format('ALTER TABLE carbon.%I FORCE ROW LEVEL SECURITY', ledger_table);
        EXECUTE format(
            'CREATE POLICY tenant_boundary ON carbon.%I
             USING (tenant_id = (SELECT carbon.tenant_context()))
             WITH CHECK (tenant_id = (SELECT carbon.tenant_context()))', ledger_table
        );
        EXECUTE format(
            'CREATE POLICY actor_read ON carbon.%1$I AS RESTRICTIVE FOR SELECT TO carbon_app
             USING (EXISTS (
                 SELECT 1 FROM carbon.case_intake AS intake
                 WHERE intake.tenant_id = %1$I.tenant_id AND intake.org_id = %1$I.org_id
                   AND intake.id = %1$I.case_id AND intake.created_by = (SELECT carbon.actor_context())
                   AND carbon.has_org_role(intake.tenant_id, intake.org_id, ''customer'')
             ))', ledger_table
        );
        EXECUTE format(
            'CREATE TRIGGER immutable_row BEFORE UPDATE OR DELETE ON carbon.%I
             FOR EACH ROW EXECUTE FUNCTION carbon.reject_mutation()', ledger_table
        );
    END LOOP;

    FOREACH ledger_table IN ARRAY ARRAY['ingestion_batch', 'ingestion_preview']
    LOOP
        EXECUTE format(
            'CREATE POLICY actor_append ON carbon.%1$I AS RESTRICTIVE FOR INSERT TO carbon_app
             WITH CHECK (created_by = (SELECT carbon.actor_context()) AND EXISTS (
                 SELECT 1 FROM carbon.case_intake AS intake
                 WHERE intake.tenant_id = %1$I.tenant_id AND intake.org_id = %1$I.org_id
                   AND intake.id = %1$I.case_id AND intake.created_by = %1$I.created_by
                   AND intake.status IN (''draft'', ''returned'')
                   AND carbon.has_org_role(intake.tenant_id, intake.org_id, ''customer'')
             ))', ledger_table
        );
    END LOOP;
END;
$ledger_policies$;

CREATE FUNCTION carbon.commit_activity_import(
    p_org_id uuid, p_case_id uuid, p_batch_id uuid, p_preview_revision integer
) RETURNS TABLE (
    preview_revision integer, inserted integer, corrected integer, unchanged integer, committed_at timestamptz
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
    tenant uuid := carbon.tenant_context();
    actor uuid := carbon.actor_context();
    intake_status text;
    batch carbon.ingestion_batch%ROWTYPE;
    selected carbon.ingestion_preview%ROWTYPE;
    receipt carbon.ingestion_commit%ROWTYPE;
    revision_mismatch boolean;
    inserted_count integer;
    corrected_count integer;
    unchanged_count integer;
BEGIN
    SELECT intake.status INTO intake_status
    FROM carbon.case_intake AS intake
    WHERE intake.tenant_id = tenant AND intake.org_id = p_org_id AND intake.id = p_case_id
      AND intake.created_by = actor AND carbon.has_org_role(tenant, p_org_id, 'customer')
    FOR NO KEY UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Import case not visible'
            USING ERRCODE = '23514', CONSTRAINT = 'activity_import_not_found';
    END IF;

    -- The task lock serializes save, repreview, confirmation and case transition.
    SELECT batch_row.* INTO batch FROM carbon.ingestion_batch AS batch_row
    WHERE batch_row.tenant_id = tenant AND batch_row.org_id = p_org_id
      AND batch_row.case_id = p_case_id AND batch_row.id = p_batch_id AND batch_row.created_by = actor;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Import batch not visible'
            USING ERRCODE = '23514', CONSTRAINT = 'activity_import_not_found';
    END IF;

    SELECT entry.* INTO receipt FROM carbon.ingestion_commit AS entry
    WHERE entry.tenant_id = tenant AND entry.org_id = p_org_id
      AND entry.case_id = p_case_id AND entry.batch_id = p_batch_id;
    IF FOUND THEN
        IF receipt.preview_revision IS DISTINCT FROM p_preview_revision THEN
            RAISE EXCEPTION 'Import has another committed preview'
                USING ERRCODE = '23514', CONSTRAINT = 'activity_import_stale_preview';
        END IF;
        RETURN QUERY SELECT receipt.preview_revision, receipt.inserted, receipt.corrected, receipt.unchanged,
            receipt.committed_at;
        RETURN;
    END IF;

    IF intake_status NOT IN ('draft', 'returned') THEN
        RAISE EXCEPTION 'Import case is not editable'
            USING ERRCODE = '23514', CONSTRAINT = 'activity_import_case_conflict';
    END IF;
    SELECT snapshot.* INTO selected FROM carbon.ingestion_preview AS snapshot
    WHERE snapshot.tenant_id = tenant AND snapshot.org_id = p_org_id
      AND snapshot.case_id = p_case_id AND snapshot.batch_id = p_batch_id
    ORDER BY snapshot.revision DESC LIMIT 1;
    IF selected.revision IS DISTINCT FROM p_preview_revision THEN
        RAISE EXCEPTION 'Import preview revision changed'
            USING ERRCODE = '23514', CONSTRAINT = 'activity_import_stale_preview';
    END IF;
    IF selected.status IS DISTINCT FROM 'ready' THEN
        RAISE EXCEPTION 'Import preview is blocked'
            USING ERRCODE = '23514', CONSTRAINT = 'activity_import_blocked';
    END IF;

    WITH rows AS MATERIALIZED (
        SELECT source_row.*, (source_row.period || '-01')::date AS activity_period
        FROM jsonb_to_recordset(selected.preview) AS source_row(
            row integer, period text, source text, quantity numeric, unit text,
            "originalQuantity" text, "originalUnit" text, "baseRevision" integer, action text
        )
    ), checked AS MATERIALIZED (
        SELECT rows.*, latest.revision AS latest_revision
        FROM rows
        LEFT JOIN LATERAL (
            SELECT activity.revision FROM carbon.activity_record_revision AS activity
            WHERE activity.tenant_id = tenant AND activity.org_id = p_org_id AND activity.case_id = p_case_id
              AND activity.period = rows.activity_period AND activity.source = rows.source
            ORDER BY activity.revision DESC LIMIT 1
        ) AS latest ON true
    ), appended AS (
        INSERT INTO carbon.activity_record_revision (
            tenant_id, org_id, case_id, period, source, revision, quantity, unit, original_quantity, original_unit,
            conversion_version, source_type, batch_id, preview_revision, source_row
        )
        SELECT tenant, p_org_id, p_case_id, activity_period, source, coalesce(latest_revision, 0) + 1,
            quantity, unit, "originalQuantity", "originalUnit", batch.template_version, 'manual_csv',
            p_batch_id, p_preview_revision, row
        FROM checked
        WHERE action IN ('insert', 'correct')
          AND NOT EXISTS (SELECT 1 FROM checked WHERE latest_revision IS DISTINCT FROM "baseRevision")
        RETURNING revision
    )
    SELECT EXISTS (SELECT 1 FROM checked WHERE latest_revision IS DISTINCT FROM "baseRevision"),
        (SELECT count(*) FROM appended WHERE revision = 1),
        (SELECT count(*) FROM appended WHERE revision > 1),
        (SELECT count(*) FROM checked WHERE action = 'unchanged')
    INTO revision_mismatch, inserted_count, corrected_count, unchanged_count;

    IF revision_mismatch THEN
        RAISE EXCEPTION 'Import activity baseline changed'
            USING ERRCODE = '23514', CONSTRAINT = 'activity_import_stale_baseline';
    END IF;

    INSERT INTO carbon.ingestion_commit (
        tenant_id, org_id, case_id, batch_id, preview_revision, inserted, corrected, unchanged, committed_by, request_id
    )
    VALUES (tenant, p_org_id, p_case_id, p_batch_id, p_preview_revision,
        inserted_count, corrected_count, unchanged_count, actor, current_setting('carbon.request_id', true))
    RETURNING * INTO receipt;

    RETURN QUERY SELECT receipt.preview_revision, receipt.inserted, receipt.corrected, receipt.unchanged,
        receipt.committed_at;
END;
$$;

REVOKE ALL ON FUNCTION carbon.commit_activity_import(uuid, uuid, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION carbon.commit_activity_import(uuid, uuid, uuid, integer) TO carbon_app;
GRANT SELECT ON carbon.ingestion_batch, carbon.ingestion_preview,
    carbon.ingestion_commit, carbon.activity_record_revision TO carbon_app;
GRANT INSERT (tenant_id, org_id, case_id, id, source_sha256, template_version, source_csv, created_by, request_id)
    ON carbon.ingestion_batch TO carbon_app;
GRANT INSERT (tenant_id, org_id, case_id, batch_id, revision, status, summary, issues, preview, created_by, request_id)
    ON carbon.ingestion_preview TO carbon_app;
