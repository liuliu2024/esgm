-- Supported model versions and their exact dependencies are installed by migration.
CREATE TABLE catalog.model_template_version (
    template_id text NOT NULL CHECK (template_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
    version integer NOT NULL CHECK (version > 0),
    title text NOT NULL CHECK (title ~ '[^[:space:]]'),
    install_order bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
    sealed boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (template_id, version)
);

CREATE TABLE catalog.model_template_dependency (
    template_id text NOT NULL,
    version integer NOT NULL,
    dependency_id text NOT NULL,
    dependency_version integer NOT NULL,
    PRIMARY KEY (template_id, version, dependency_id, dependency_version),
    FOREIGN KEY (template_id, version)
        REFERENCES catalog.model_template_version(template_id, version),
    FOREIGN KEY (dependency_id, dependency_version)
        REFERENCES catalog.model_template_version(template_id, version)
);

CREATE FUNCTION catalog.guard_model_template_dependency() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
DECLARE
    template_order bigint;
    dependency_order bigint;
    template_sealed boolean;
BEGIN
    SELECT dependent.install_order, upstream.install_order, dependent.sealed
    INTO template_order, dependency_order, template_sealed
    FROM catalog.model_template_version AS dependent
    CROSS JOIN catalog.model_template_version AS upstream
    WHERE (dependent.template_id, dependent.version) = (NEW.template_id, NEW.version)
      AND (upstream.template_id, upstream.version) = (NEW.dependency_id, NEW.dependency_version)
    FOR SHARE OF dependent;

    -- Every edge strictly descends an immutable order, excluding all cycles.
    IF FOUND AND dependency_order >= template_order THEN
        RAISE EXCEPTION 'A model dependency must have been installed before its dependent version'
            USING ERRCODE = '23514', CONSTRAINT = 'model_template_dependency_order';
    END IF;
    IF template_sealed THEN
        RAISE EXCEPTION 'A sealed model template cannot gain dependencies'
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$$;

CREATE FUNCTION catalog.guard_model_template_seal() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.sealed THEN
            RAISE EXCEPTION 'A model template must be installed before it is sealed' USING ERRCODE = '55000';
        END IF;
    ELSE
        IF OLD.sealed OR NOT NEW.sealed
           OR (NEW.template_id, NEW.version, NEW.title, NEW.install_order, NEW.created_at) IS DISTINCT FROM
              (OLD.template_id, OLD.version, OLD.title, OLD.install_order, OLD.created_at) THEN
            RAISE EXCEPTION 'A model template version can only be sealed once' USING ERRCODE = '55000';
        END IF;
        IF EXISTS (
            SELECT 1
            FROM catalog.model_template_dependency AS edge
            JOIN catalog.model_template_version AS upstream
              ON (upstream.template_id, upstream.version) = (edge.dependency_id, edge.dependency_version)
            WHERE (edge.template_id, edge.version) = (OLD.template_id, OLD.version)
              AND NOT upstream.sealed
        ) THEN
            RAISE EXCEPTION 'A model template requires sealed upstream dependencies' USING ERRCODE = '55000';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE FUNCTION catalog.reject_model_template_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
BEGIN
    RAISE EXCEPTION 'Installed model template versions and dependencies are immutable'
        USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER guard_model_template_dependency
    BEFORE INSERT ON catalog.model_template_dependency
    FOR EACH ROW EXECUTE FUNCTION catalog.guard_model_template_dependency();
CREATE TRIGGER guard_model_template_seal
    BEFORE INSERT OR UPDATE ON catalog.model_template_version
    FOR EACH ROW EXECUTE FUNCTION catalog.guard_model_template_seal();
CREATE TRIGGER immutable_model_template_version
    BEFORE DELETE OR TRUNCATE ON catalog.model_template_version
    FOR EACH STATEMENT EXECUTE FUNCTION catalog.reject_model_template_mutation();
CREATE TRIGGER immutable_model_template_dependency
    BEFORE UPDATE OR DELETE OR TRUNCATE ON catalog.model_template_dependency
    FOR EACH STATEMENT EXECUTE FUNCTION catalog.reject_model_template_mutation();

INSERT INTO catalog.model_template_version (template_id, version, title)
VALUES ('submitted-electricity', 1, '提交版外购电力核算'),
       ('product-electricity-allocation', 1, '产品电力分配');

INSERT INTO catalog.model_template_version (template_id, version, title)
VALUES ('product-electricity-contribution', 1, '产品电力碳足迹贡献');

INSERT INTO catalog.model_template_dependency (template_id, version, dependency_id, dependency_version)
VALUES ('product-electricity-contribution', 1, 'submitted-electricity', 1),
       ('product-electricity-contribution', 1, 'product-electricity-allocation', 1);

UPDATE catalog.model_template_version SET sealed = true
WHERE version = 1 AND template_id IN ('submitted-electricity', 'product-electricity-allocation');
UPDATE catalog.model_template_version SET sealed = true
WHERE version = 1 AND template_id = 'product-electricity-contribution';

ALTER TABLE carbon.product_electricity_profile
    ADD COLUMN model_template_id text NOT NULL DEFAULT 'product-electricity-contribution',
    ADD COLUMN model_template_version integer NOT NULL DEFAULT 1,
    ADD CONSTRAINT product_electricity_profile_template_id
        CHECK (model_template_id = 'product-electricity-contribution'),
    ADD CONSTRAINT product_electricity_profile_template_version
        FOREIGN KEY (model_template_id, model_template_version)
        REFERENCES catalog.model_template_version(template_id, version);

REVOKE ALL ON FUNCTION catalog.guard_model_template_dependency(), catalog.guard_model_template_seal(),
    catalog.reject_model_template_mutation() FROM PUBLIC;
REVOKE ALL ON catalog.model_template_version, catalog.model_template_dependency FROM PUBLIC;
GRANT SELECT ON catalog.model_template_version, catalog.model_template_dependency TO carbon_app;
