-- Existing versions are both national. Future versions must name their region.
ALTER TABLE catalog.factor_reference_version
    ADD COLUMN region_name text NOT NULL DEFAULT '全国'
    CHECK (region_name ~ '[^[:space:]]');
ALTER TABLE catalog.factor_reference_version ALTER COLUMN region_name DROP DEFAULT;

-- Official 2023 organization electricity CO₂ factors. The seven grid codes
-- are internal aliases. Province codes use ISO 3166-2.
INSERT INTO catalog.factor_reference_version (
    factor_id, version, accounting_basis, region_code, region_name, data_year, value,
    input_unit, output_unit, source_title, source_url, source_locator, usage_note
)
SELECT
    'cn-electricity-organization-' || lower(substr(region_code, 4)) || '-2023',
    1, 'organization_electricity_co2', region_code, region_name, 2023, value,
    'kWh', 'kgCO2', '关于发布2023年电力二氧化碳排放因子的公告',
    'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk01/202512/W020251231726284332528.pdf',
    '附件《2023 年电力二氧化碳排放因子》表 ' || table_no || '，' || region_name,
    '电力消费二氧化碳口径。仅供参考，使用前核对适用年度、供电地域及核算方法。'
FROM (VALUES
    ('CN-GNC', '华北', 0.6361, 2),
    ('CN-GNE', '东北', 0.5122, 2),
    ('CN-GEC', '华东', 0.5500, 2),
    ('CN-GCC', '华中', 0.5271, 2),
    ('CN-GNW', '西北', 0.5543, 2),
    ('CN-GSO', '南方', 0.4042, 2),
    ('CN-GSW', '西南', 0.2472, 2),
    ('CN-BJ', '北京', 0.5554, 3),
    ('CN-TJ', '天津', 0.6796, 3),
    ('CN-HE', '河北', 0.6516, 3),
    ('CN-SX', '山西', 0.6634, 3),
    ('CN-NM', '内蒙古', 0.6479, 3),
    ('CN-LN', '辽宁', 0.4878, 3),
    ('CN-JL', '吉林', 0.4671, 3),
    ('CN-HL', '黑龙江', 0.5229, 3),
    ('CN-SH', '上海', 0.5737, 3),
    ('CN-JS', '江苏', 0.5827, 3),
    ('CN-ZJ', '浙江', 0.4974, 3),
    ('CN-AH', '安徽', 0.6553, 3),
    ('CN-FJ', '福建', 0.4211, 3),
    ('CN-JX', '江西', 0.5836, 3),
    ('CN-SD', '山东', 0.6191, 3),
    ('CN-HA', '河南', 0.5897, 3),
    ('CN-HB', '湖北', 0.4044, 3),
    ('CN-HN', '湖南', 0.4976, 3),
    ('CN-GD', '广东', 0.4419, 3),
    ('CN-GX', '广西', 0.4476, 3),
    ('CN-HI', '海南', 0.3648, 3),
    ('CN-CQ', '重庆', 0.5581, 3),
    ('CN-SC', '四川', 0.1564, 3),
    ('CN-GZ', '贵州', 0.5683, 3),
    ('CN-YN', '云南', 0.1333, 3),
    ('CN-SN', '陕西', 0.6335, 3),
    ('CN-GS', '甘肃', 0.4471, 3),
    ('CN-QH', '青海', 0.1796, 3),
    ('CN-NX', '宁夏', 0.6187, 3),
    ('CN-XJ', '新疆', 0.6021, 3)
) AS official (region_code, region_name, value, table_no);

INSERT INTO catalog.factor_reference_version (
    factor_id, version, accounting_basis, region_code, region_name, data_year, value,
    input_unit, output_unit, source_title, source_url, source_locator, usage_note
)
VALUES (
    'cn-electricity-product-average-2023', 1, 'product_footprint', 'CN', '全国', 2023, 0.6205,
    'kWh', 'kgCO2e', '关于发布2023年电力碳足迹因子数据的公告',
    'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk01/202501/W020250123519612367413.pdf',
    '附件 1《2023 年全国电力碳足迹因子》表 1，全国',
    '全国平均电力产品碳足迹口径。仅供参考，使用前核对适用年度、地域及核算方法。'
);
