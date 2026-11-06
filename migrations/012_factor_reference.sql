-- Public-source reference values. This catalog does not select or apply a factor.
CREATE SCHEMA catalog;
REVOKE ALL ON SCHEMA catalog FROM PUBLIC;

CREATE TABLE catalog.factor_reference_version (
    factor_id text NOT NULL CHECK (factor_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
    version integer NOT NULL CHECK (version > 0),
    accounting_basis text NOT NULL CHECK (
        accounting_basis IN ('product_footprint', 'organization_electricity_co2')
    ),
    region_code text NOT NULL CHECK (region_code ~ '^[A-Z]{2}(-[A-Z0-9]{1,3})?$'),
    data_year integer NOT NULL CHECK (data_year BETWEEN 1900 AND 9999),
    value numeric NOT NULL CHECK (value >= 0 AND value < 'Infinity'::numeric),
    input_unit text NOT NULL CHECK (btrim(input_unit) <> ''),
    output_unit text NOT NULL,
    source_title text NOT NULL CHECK (btrim(source_title) <> ''),
    source_url text NOT NULL CHECK (source_url LIKE 'https://%'),
    source_locator text NOT NULL CHECK (btrim(source_locator) <> ''),
    usage_note text NOT NULL CHECK (btrim(usage_note) <> ''),
    PRIMARY KEY (factor_id, version),
    CHECK (
        (accounting_basis = 'product_footprint' AND output_unit = 'kgCO2e')
        OR (accounting_basis = 'organization_electricity_co2' AND output_unit = 'kgCO2')
    )
);

INSERT INTO catalog.factor_reference_version (
    factor_id, version, accounting_basis, region_code, data_year, value,
    input_unit, output_unit, source_title, source_url, source_locator, usage_note
)
VALUES
    (
        'cn-electricity-product-average', 1, 'product_footprint', 'CN', 2024, 0.5777,
        'kWh', 'kgCO2e', '关于发布2024年电力碳足迹因子数据的公告',
        'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk01/202510/W020251024569470952545.pdf',
        '附件《2024 年全国电力碳足迹因子》表 1，全国',
        '全国平均电力产品碳足迹口径。仅供参考，使用前核对适用年度、地域及核算方法。'
    ),
    (
        'cn-electricity-organization-average', 1, 'organization_electricity_co2', 'CN', 2023, 0.5306,
        'kWh', 'kgCO2', '关于发布2023年电力二氧化碳排放因子的公告',
        'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk01/202512/W020251231726284332528.pdf',
        '附件《2023 年电力二氧化碳排放因子》表 1，全国',
        '全国平均电力消费二氧化碳口径。表 4 扣除市场化交易非化石能源电量的因子另有口径。仅供参考，使用前核对适用年度、地域及核算方法。'
    );

CREATE FUNCTION catalog.reject_factor_reference_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
BEGIN
    RAISE EXCEPTION 'Published factor reference versions are immutable' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER immutable_factor_reference_version
    BEFORE UPDATE OR DELETE OR TRUNCATE ON catalog.factor_reference_version
    FOR EACH STATEMENT EXECUTE FUNCTION catalog.reject_factor_reference_mutation();

REVOKE ALL ON FUNCTION catalog.reject_factor_reference_mutation() FROM PUBLIC;
REVOKE ALL ON catalog.factor_reference_version FROM PUBLIC;
GRANT USAGE ON SCHEMA catalog TO carbon_app;
GRANT SELECT ON catalog.factor_reference_version TO carbon_app;
