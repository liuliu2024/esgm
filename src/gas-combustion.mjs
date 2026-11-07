export const gasCombustionScenario = 'power-generation-combustion';
export const gasCombustionModel = Object.freeze({
  id: 'power-gas-combustion-2026',
  version: 1,
  sourceUrl: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202606/W020260629673485282202.pdf',
  sourceLocator: 'CETS—AG—01.01—V04—2026 第 6.1 节式（1）、（3）及第 6.2 节',
  volumeReference: {temperatureC: '20', pressureKPa: '101.325'},
  unit: 'kgCO2',
  rounding: 'per_month_6_decimal_places'
});

export async function calculateGasCombustion(tx, key, from, to, facility) {
  const {rows} = await tx.query(`
    WITH periods AS (
      SELECT period::date
      FROM generate_series($5::date::timestamp, $6::date::timestamp, interval '1 month') AS month(period)
    ), slots AS (
      SELECT periods.period, entry.method_branch, entry.elemental_carbon_tc_per_10k_nm3,
        entry.standard_volume_nm3, entry.ncv_gj_per_10k_nm3, entry.carbon_tc_per_gj,
        entry.oxidation_fraction, entry.activity_evidence_id, entry.parameter_evidence_id, entry.parameter_basis,
        jsonb_build_object('receiptId', activity.receipt_id, 'sha256', activity.sha256) AS activity_source,
        jsonb_build_object('receiptId', parameter.receipt_id, 'sha256', parameter.sha256) AS parameter_source,
        entry.standard_volume_nm3 * entry.ncv_gj_per_10k_nm3 * 0.0001::numeric AS energy_gj,
        coalesce(entry.elemental_carbon_tc_per_10k_nm3,
          entry.ncv_gj_per_10k_nm3 * entry.carbon_tc_per_gj) AS carbon_tc_per_10k_nm3
      FROM periods
      LEFT JOIN carbon.gas_combustion_input AS entry
        ON (entry.tenant_id, entry.org_id, entry.case_id, entry.submission_revision, entry.period)
         = ($1, $2, $3, $4, periods.period)
      LEFT JOIN carbon.case_submission_evidence AS activity
        ON (activity.tenant_id, activity.org_id, activity.case_id, activity.revision, activity.evidence_id)
         = ($1, $2, $3, $4, entry.activity_evidence_id)
      LEFT JOIN carbon.case_submission_evidence AS parameter
        ON (parameter.tenant_id, parameter.org_id, parameter.case_id, parameter.revision, parameter.evidence_id)
         = ($1, $2, $3, $4, entry.parameter_evidence_id)
    ), results AS (
      SELECT to_char(slots.period, 'YYYY-MM') AS month,
        method_branch, elemental_carbon_tc_per_10k_nm3, standard_volume_nm3,
        ncv_gj_per_10k_nm3, carbon_tc_per_gj, oxidation_fraction,
        activity_evidence_id, parameter_evidence_id, parameter_basis, activity_source, parameter_source,
        energy_gj, carbon_tc_per_10k_nm3,
        round(standard_volume_nm3 * 0.0001::numeric * carbon_tc_per_10k_nm3
          * oxidation_fraction * 44000 / 12, 6) AS emissions
      FROM slots
    )
    SELECT month AS period, method_branch AS "methodBranch",
      trim_scale(elemental_carbon_tc_per_10k_nm3)::text AS "elementalCarbonTcPer10kNm3",
      trim_scale(standard_volume_nm3)::text AS "standardVolumeNm3",
      trim_scale(ncv_gj_per_10k_nm3)::text AS "ncvGjPer10kNm3",
      trim_scale(carbon_tc_per_gj)::text AS "carbonTcPerGj",
      trim_scale(oxidation_fraction)::text AS "oxidationFraction",
      trim_scale(energy_gj)::text AS "energyGj", trim_scale(carbon_tc_per_10k_nm3)::text AS "carbonTcPer10kNm3",
      trim_scale(emissions)::text AS "emissionsKgCO2", activity_evidence_id AS "activityEvidenceId",
      parameter_evidence_id AS "parameterEvidenceId", parameter_basis AS "parameterBasis",
      CASE WHEN activity_evidence_id IS NOT NULL THEN activity_source END AS "activitySource",
      CASE WHEN parameter_evidence_id IS NOT NULL THEN parameter_source END AS "parameterSource",
      trim_scale(sum(emissions) OVER ())::text AS "subtotalKg",
      trim_scale(sum(emissions) OVER () * 0.001::numeric)::text AS "subtotalT"
    FROM results ORDER BY month
  `, [...key, `${from}-01`, `${to}-01`]);
  const items = rows.map(({subtotalKg, subtotalT, ...item}) => ({
    ...item, status: item.emissionsKgCO2 === null ? 'missing_input' : 'calculated'
  }));
  const expectedSlots = items.length;
  const availableSlots = items.filter(item => item.status === 'calculated').length;
  const missingSlots = expectedSlots - availableSlots;
  const knownSubtotalKgCO2 = rows[0].subtotalKg;
  return {
    submissionRevision: key[3], from, to, facility, model: gasCombustionModel, mode: 'internal_trial',
    coverage: {status: !availableSlots ? 'empty' : missingSlots ? 'partial' : 'complete',
      expectedSlots, availableSlots, missingSlots}, items, knownSubtotalKgCO2,
    totalKgCO2: missingSlots ? null : knownSubtotalKgCO2, totalTCO2: missingSlots ? null : rows[0].subtotalT,
    formalReportEligible: false, externalDeliveryEligible: false
  };
}

export async function compareGasCombustion(tx, baseline, target) {
  const {rows} = await tx.query(`
    SELECT base.month AS period,
      trim_scale(candidate.emissions::numeric - base.emissions::numeric)::text AS "deltaKgCO2",
      trim_scale(sum(candidate.emissions::numeric - base.emissions::numeric) OVER ())::text AS "totalDeltaKgCO2"
    FROM unnest($1::text[], $2::text[]) AS base(month, emissions)
    JOIN unnest($1::text[], $3::text[]) AS candidate(month, emissions) USING (month)
    ORDER BY base.month
  `, [baseline.items.map(item => item.period), baseline.items.map(item => item.emissionsKgCO2),
    target.items.map(item => item.emissionsKgCO2)]);
  const trackedFields = ['methodBranch', 'standardVolumeNm3', 'ncvGjPer10kNm3', 'carbonTcPerGj',
    'elementalCarbonTcPer10kNm3', 'oxidationFraction'];
  return {
    totalDeltaKgCO2: rows[0].totalDeltaKgCO2,
    items: rows.map(({period, deltaKgCO2}, index) => ({
      period, deltaKgCO2,
      baselineKgCO2: baseline.items[index].emissionsKgCO2, targetKgCO2: target.items[index].emissionsKgCO2,
      changedInputs: trackedFields.filter(field => baseline.items[index][field] !== target.items[index][field])
        .map(field => ({field, before: baseline.items[index][field], after: target.items[index][field]}))
    }))
  };
}
