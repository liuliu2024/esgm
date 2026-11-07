import { createHash, randomUUID } from 'node:crypto';
import { previewActivityCsv } from './activity-preview.mjs';
import { renderDeliveryDocument } from './report-delivery.mjs';
import { calculateGasCombustion, compareGasCombustion, gasCombustionScenario } from './gas-combustion.mjs';

export class CarbonError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const caseFields = `id, org_id AS "orgId", scenario_release_id AS "scenarioReleaseId",
  created_by AS "createdBy", purpose, status, revision, return_reason AS "returnReason",
  correction_note AS "correctionNote"`;
const caseDetailFields = `${caseFields}, intake_scope AS scope`;
const eventFields = `id, case_id AS "caseId", actor_id AS "actorId", action, reason, revision,
  correction_note AS "correctionNote", request_id AS "requestId", created_at AS "createdAt"`;
const evidenceFields = `evidence.id, evidence.case_id AS "caseId", evidence.org_id AS "orgId",
  evidence.registered_by AS "registeredBy", evidence.title,
  evidence.source_description AS "sourceDescription", evidence.created_at AS "createdAt"`;
const catalogFields = ['industryCode', 'industryName', 'title', 'purpose', 'recipient'];
const referenceFields = ['code', 'title', 'publisher', 'sourceUrl', 'scopeNote'];
const rulePublicationStatuses = new Set(['effective', 'pilot', 'draft', 'superseded', 'expired']);
const factorReferenceFields = `factor_id AS "factorId", version, accounting_basis AS "accountingBasis", region_code AS "regionCode",
  data_year AS "dataYear", value::text AS value, input_unit AS "inputUnit", output_unit AS "outputUnit",
  source_title AS "sourceTitle", source_url AS "sourceUrl", source_locator AS "sourceLocator", usage_note AS "usageNote",
  catalog.factor_disclosure_scope(factor_id, version) AS "disclosureScope"`;
const activityTemplate = 'activity-csv-v1';
const productElectricityScenario = 'product-footprint-prep';
const productProfileFields = `submission_revision AS "submissionRevision", boundary_note AS "boundaryNote",
  functional_unit AS "functionalUnit", trim_scale(output_quantity)::text AS "outputQuantity",
  allocation_method AS "allocationMethod", trim_scale(product_mass_kg)::text AS "productMassKg",
  trim_scale(batch_mass_kg)::text AS "batchMassKg", allocation_basis AS "allocationBasis",
  model_template_id AS "modelTemplateId", model_template_version AS "modelTemplateVersion",
  to_char(from_period, 'YYYY-MM') AS "from", to_char(to_period, 'YYYY-MM') AS "to"`;
const snapshotSchemaVersion = 1;
const controlledElectricityModel = {id: 'submitted-electricity', version: 1};
const snapshotFields = `id AS "snapshotId", case_id AS "caseId", created_at AS "createdAt",
  schema_version AS "schemaVersion", payload AS result`;
const draftFields = `id AS "draftId", created_at AS "createdAt", payload`;
const trialSnapshotFields = `id AS "snapshotId", created_at AS "createdAt", payload AS result`;
const gasJobFields = `id AS "jobId", case_id AS "caseId", submission_revision AS "submissionRevision",
  to_char(from_period, 'YYYY-MM') AS "from", to_char(to_period, 'YYYY-MM') AS "to",
  status, attempts, snapshot_id AS "snapshotId", error_code AS "errorCode",
  created_at AS "createdAt", updated_at AS "updatedAt"`;
const reportReviewFields = `draft_id AS "draftId", case_id AS "caseId", status,
  submitted_by AS "submittedBy", submitted_at AS "submittedAt", reviewed_by AS "reviewedBy",
  reviewed_at AS "reviewedAt", reason`;
const deliveryFields = `id AS "deliveryId", draft_id AS "draftId", recipient, purpose,
  include_monthly AS "includeMonthly", include_factor AS "includeFactor",
  created_at AS "createdAt", recorded_at AS "recordedAt", delivery_reference AS "deliveryReference",
  document_sha256 AS "documentSha256"`;
function accessDenied() {
  return new CarbonError(403, 'ACCESS_DENIED', '你没有该组织的操作权限。');
}

function caseMissing() {
  return new CarbonError(404, 'CASE_NOT_FOUND', '未找到可访问的受理任务。');
}

async function readReviewIssues(tx, key, customerOnly, independent, issueId = null) {
  const {rows} = await tx.query(`
    SELECT i.id AS "issueId", i.submission_revision AS "submissionRevision", i.evidence_id AS "evidenceId",
      i.title, i.description, i.severity, i.status, i.version, i.assignee_id AS "assigneeId",
      i.created_by AS "createdBy", i.created_at AS "createdAt", i.updated_at AS "updatedAt",
      to_char(i.due_date, 'YYYY-MM-DD') AS "dueDate",
      i.status <> 'closed' AND i.due_date < (clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date AS overdue,
      coalesce((SELECT jsonb_agg(jsonb_build_object('version', e.version, 'action', e.action,
        'actorId', e.actor_id, 'note', e.note, 'createdAt', e.created_at) ORDER BY e.version)
        FROM carbon.review_issue_event e WHERE (e.tenant_id,e.org_id,e.case_id,e.issue_id) =
          (i.tenant_id,i.org_id,i.case_id,i.id)), '[]'::jsonb) AS events
    FROM carbon.review_issue i
    WHERE (i.tenant_id,i.org_id,i.case_id) = ($1,$2,$3) AND ($4::uuid IS NULL OR i.id = $4)
    ORDER BY i.created_at DESC, i.id DESC
  `, [...key, issueId]);
  return rows.map(item => ({...item, createdAt: new Date(item.createdAt).toISOString(),
    updatedAt: new Date(item.updatedAt).toISOString(),
    nextActions: customerOnly && item.status === 'open' ? ['reply']
      : !customerOnly && independent && item.status === 'answered' ? ['request-follow-up', 'close'] : []}));
}

function caseDetail({scope, ...task}) {
  return scope === null ? task : {...task, scope};
}

function catalogPreparation(catalog) {
  const {materials, reportRequirements} = catalog?.preparation ?? {};
  if ([materials, reportRequirements].every(lines => Array.isArray(lines) && lines.length &&
      lines.every(line => typeof line === 'string' && line.trim()))) {
    return {materials, reportRequirements};
  }
}

function scenarioReferenceItems(references, includeStatus = false) {
  const items = [];
  if (!Array.isArray(references)) return items;
  for (const entry of references) {
    if (!referenceFields.every(field => typeof entry?.[field] === 'string' && entry[field].trim())) continue;
    const url = URL.parse(entry.sourceUrl);
    if (url?.protocol !== 'https:' || url.username || url.password) continue;
    const item = {...Object.fromEntries(referenceFields.map(field => [field, entry[field]])), sourceUrl: url.href};
    if (includeStatus) {
      item.publicationStatus = rulePublicationStatuses.has(entry.publicationStatus) ? entry.publicationStatus : 'unclassified';
    }
    items.push(item);
  }
  return items;
}

function compareRuleReferences(existing, references) {
  const original = new Map(scenarioReferenceItems(existing, true).map(item => [item.code, item]));
  const proposed = new Map(references.map(item => [item.code, item]));
  const changes = [];
  for (const code of new Set([...original.keys(), ...proposed.keys()])) {
    const before = original.get(code) ?? null;
    const after = proposed.get(code) ?? null;
    if (!before || !after || Object.keys(before).some(field => before[field] !== after[field])) {
      changes.push({code, type: before ? (after ? 'changed' : 'removed') : 'added', before, after});
    }
  }
  return changes;
}

function withScenarioPreparation(task, release) {
  const title = release?.catalog?.title;
  const preparation = catalogPreparation(release?.catalog);
  const prepared = preparation && typeof title === 'string' && title.trim()
    ? {...task, scenarioPreparation: {title, version: release.version, ...preparation}}
    : task;
  if (release?.code === gasCombustionScenario) return {...prepared, gasCombustionAvailable: true};
  if (release?.code === productElectricityScenario && task.scope?.subjectType === 'product') {
    return {...prepared, productElectricityAvailable: true};
  }
  return prepared;
}

async function requireRole(tx, scope, orgId, role) {
  const result = await tx.query(`
    SELECT 1 FROM carbon.org_grant
    WHERE tenant_id = $1 AND org_id = $2 AND actor_id = $3 AND role = $4
  `, [scope.tenantId, orgId, scope.actorId, role]);
  if (result.rows.length === 0) throw accessDenied();
}

async function readCase(tx, scope, orgId, id, customerOnly = false, lock = false) {
  const result = await tx.query(`
    SELECT ${caseDetailFields} FROM carbon.case_intake
    WHERE tenant_id = $1 AND org_id = $2 AND id = $3
      AND ($4::uuid IS NULL OR created_by = $4)
    ${lock ? 'FOR NO KEY UPDATE' : ''}
  `, [scope.tenantId, orgId, id, customerOnly ? scope.actorId : null]);
  if (result.rows.length === 0) throw caseMissing();
  return caseDetail(result.rows[0]);
}

async function readVisibleCase(tx, scope, orgId, id, customerOnly, lock = false) {
  await requireRole(tx, scope, orgId, customerOnly ? 'customer' : 'reviewer');
  const result = await readCase(tx, scope, orgId, id, customerOnly, lock);
  if (!customerOnly && result.status === 'draft') throw caseMissing();
  return result;
}

async function readLockedCase(tx, scope, orgId, id, customerOnly, lock = false) {
  const task = await readVisibleCase(tx, scope, orgId, id, customerOnly, lock);
  if (task.status !== 'approved' || !task.scope?.reportingYear) {
    throw new CarbonError(409, 'CASE_REOPEN_UNAVAILABLE', '仅已批准且明确申报年度的任务可办理重开。');
  }
  return task;
}

async function readCaseReopenRequests(tx, key, requestId = null, includeDraft = false) {
  const {rows} = await tx.query(`
    SELECT r.id AS "requestId", r.approved_revision AS "approvedRevision", r.reason, r.status,
      r.created_by AS "createdBy", r.created_at AS "createdAt", r.reviewed_by AS "reviewedBy",
      r.review_reason AS "reviewReason", r.reviewed_at AS "reviewedAt", child.id AS "childCaseId"
    FROM carbon.case_reopen_request r
    LEFT JOIN carbon.case_intake child
      ON (child.tenant_id,child.org_id,child.reopen_request_id) = (r.tenant_id,r.org_id,r.id)
      AND ($5::boolean OR child.status <> 'draft')
    WHERE (r.tenant_id,r.org_id,r.case_id) = ($1,$2,$3) AND ($4::uuid IS NULL OR r.id = $4)
    ORDER BY r.created_at DESC, r.id DESC
  `, [...key, requestId, includeDraft]);
  return rows.map(row => ({...row, createdAt: new Date(row.createdAt).toISOString(),
    reviewedAt: row.reviewedAt ? new Date(row.reviewedAt).toISOString() : null}));
}

function requireEditableCase(task, message) {
  if (task.status !== 'draft' && task.status !== 'returned') {
    throw new CarbonError(409, 'CASE_CONFLICT', message);
  }
}

function importMissing() {
  return new CarbonError(404, 'IMPORT_NOT_FOUND', '未找到可访问的导入批次。');
}

async function readImport(tx, [tenantId, orgId, caseId], batchId) {
  const {rows} = await tx.query(`
    SELECT preview.batch_id AS "batchId", preview.revision AS "previewRevision",
      preview.status, preview.summary, preview.issues, preview.preview,
      CASE WHEN receipt.batch_id IS NOT NULL THEN jsonb_build_object(
        'batchId', receipt.batch_id, 'previewRevision', receipt.preview_revision, 'inserted', receipt.inserted,
        'corrected', receipt.corrected, 'unchanged', receipt.unchanged, 'committedAt', receipt.committed_at
      ) END AS receipt
    FROM carbon.ingestion_preview AS preview
    LEFT JOIN carbon.ingestion_commit AS receipt USING (tenant_id, org_id, case_id, batch_id)
    WHERE preview.tenant_id = $1 AND preview.org_id = $2 AND preview.case_id = $3 AND preview.batch_id = $4
    ORDER BY preview.revision DESC LIMIT 1
  `, [tenantId, orgId, caseId, batchId]);
  if (!rows.length) throw importMissing();
  const {receipt, ...snapshot} = rows[0];
  if (receipt) snapshot.receipt = {...receipt, committedAt: new Date(receipt.committedAt).toISOString()};
  return snapshot;
}

async function appendImportPreview(tx, key, scope, batchId, previewRevision, csv) {
  const {status, summary, issues, preview} = previewActivityCsv(csv);
  const periods = [...new Set(preview.map(item => `${item.period}-01`))];
  const {rows} = await tx.query(`
    SELECT DISTINCT ON (period, source) to_char(period, 'YYYY-MM') AS period,
      source, revision, quantity::text AS quantity
    FROM carbon.activity_record_revision
    WHERE tenant_id = $1 AND org_id = $2 AND case_id = $3 AND period = ANY($4::date[])
    ORDER BY period, source, revision DESC
  `, [...key, periods]);
  const baselines = new Map(rows.map(item => [`${item.period}:${item.source}`, item]));
  const classified = preview.map(item => {
    const baseline = baselines.get(`${item.period}:${item.source}`);
    const action = baseline ? (baseline.quantity === item.quantity ? 'unchanged' : 'correct') : 'insert';
    return {...item, action, baseRevision: baseline?.revision ?? null, baseQuantity: baseline?.quantity ?? null};
  });
  await tx.query(`
    INSERT INTO carbon.ingestion_preview
      (tenant_id, org_id, case_id, batch_id, revision, status, summary, issues, preview, created_by, request_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
  `, [...key, batchId, previewRevision, status, JSON.stringify(summary), JSON.stringify(issues),
    JSON.stringify(classified), scope.actorId, scope.requestId]);
  return {batchId, previewRevision, status, summary, issues, preview: classified};
}

async function transition(tx, scope, orgId, id, revision, before, after, customerOnly, {reason = null, correctionNote, evidenceIds} = {}) {
  const current = await readCase(tx, scope, orgId, id, customerOnly);
  if (!customerOnly && current.createdBy === scope.actorId) {
    throw new CarbonError(403, 'SELF_REVIEW_FORBIDDEN', '发起人不能复核自己的任务。');
  }
  if (current.revision !== revision || current.status !== before) {
    throw new CarbonError(409, 'CASE_CONFLICT', '任务状态或版本已变化，请刷新后重试。');
  }
  if (evidenceIds?.length) {
    await tx.query("SELECT set_config('carbon.submission_evidence_ids', $1::uuid[]::text, true)", [evidenceIds]);
  }
  const params = [scope.tenantId, orgId, id, revision, before, after, customerOnly ? scope.actorId : null, reason];
  const correctionAssignment = correctionNote === undefined ? '' : ', correction_note = $9';
  if (correctionNote !== undefined) params.push(correctionNote);
  const result = await tx.query(`
    UPDATE carbon.case_intake SET status = $6, revision = revision + 1, return_reason = $8${correctionAssignment}
    WHERE tenant_id = $1 AND org_id = $2 AND id = $3 AND revision = $4 AND status = $5
      AND ($7::uuid IS NULL OR created_by = $7)
    RETURNING ${caseDetailFields}
  `, params);
  if (result.rows.length === 0) {
    throw new CarbonError(409, 'CASE_CONFLICT', '任务状态或版本已变化，请刷新后重试。');
  }
  return caseDetail(result.rows[0]);
}

function nextAction(item, scope, customerOnly) {
  if (customerOnly && item.status === 'draft') return 'submit';
  if (customerOnly && item.status === 'returned') return 'resubmit';
  if (!customerOnly && item.status === 'submitted' && item.createdBy !== scope.actorId) return 'review';
  return 'none';
}

async function calculateActivity(tx, scope, orgId, caseId, from, to) {
  const {rows} = await tx.query(`
    WITH factors(source, unit, id, value, position) AS (VALUES
      ('electricity', 'kWh', 'demo-electricity', 0.5::numeric, 1),
      ('natural_gas', 'm3', 'demo-natural-gas', 2::numeric, 2)
    ), latest AS (
      SELECT DISTINCT ON (period, source) period, source, unit, quantity, revision,
        batch_id, preview_revision, source_row, source_type, conversion_version, original_quantity, original_unit
      FROM carbon.activity_record_revision
      WHERE tenant_id = $1 AND org_id = $2 AND case_id = $3 AND period BETWEEN $4::date AND $5::date
      ORDER BY period, source, revision DESC
    ), slots AS (
      SELECT month.period, factors.source, factors.unit, factors.id, factors.value, factors.position,
        latest.quantity, latest.revision, latest.batch_id, latest.preview_revision, latest.source_row,
        latest.source_type, latest.conversion_version, latest.original_quantity, latest.original_unit,
        latest.quantity * factors.value AS emissions
      FROM generate_series($4::date::timestamp, $5::date::timestamp, interval '1 month') AS month(period)
      CROSS JOIN factors
      LEFT JOIN latest ON latest.period = month.period::date AND latest.source = factors.source
        AND latest.unit = factors.unit
    )
    SELECT to_char(period, 'YYYY-MM') AS period, source, unit, trim_scale(quantity)::text AS quantity,
      trim_scale(emissions)::text AS "emissionsKgCO2e",
      jsonb_build_object('id', id, 'version', 1, 'value', value::text,
        'inputUnit', unit, 'outputUnit', 'kgCO2e', 'synthetic', true) AS factor,
      CASE WHEN revision IS NOT NULL THEN jsonb_build_object(
        'activityRevision', revision, 'batchId', batch_id, 'previewRevision', preview_revision,
        'sourceRow', source_row, 'sourceType', source_type, 'conversionVersion', conversion_version,
        'originalQuantity', original_quantity, 'originalUnit', original_unit
      ) END AS lineage,
      trim_scale(sum(emissions) OVER ())::text AS "subtotalKg",
      trim_scale(sum(emissions) OVER () * 0.001::numeric)::text AS "subtotalT"
    FROM slots ORDER BY period, position
  `, [scope.tenantId, orgId, caseId, `${from}-01`, `${to}-01`]);
  const {subtotalKg, subtotalT} = rows[0];
  const items = rows.map(({subtotalKg, subtotalT, ...item}) => ({
    ...item, status: item.quantity === null ? 'missing_activity' : 'calculated'
  }));
  const expectedSlots = items.length;
  const availableSlots = items.filter(item => item.status === 'calculated').length;
  const missingSlots = expectedSlots - availableSlots;
  const status = !availableSlots ? 'empty' : missingSlots ? 'partial' : 'complete';
  return {
    caseId, from, to, mode: 'synthetic', formalReportEligible: false,
    model: {id: 'task-carbon-preview', version: 1, factorSetId: 'synthetic-energy', factorSetVersion: 1, synthetic: true},
    coverage: {status, expectedSlots, availableSlots, missingSlots}, items,
    knownSubtotalKgCO2e: subtotalKg,
    totalKgCO2e: missingSlots ? null : subtotalKg,
    totalTCO2e: missingSlots ? null : subtotalT
  };
}

async function readSnapshot(tx, scope, orgId, caseId, snapshotId) {
  const {rows: [snapshot]} = await tx.query(`
    SELECT ${snapshotFields} FROM carbon.calculation_snapshot
    WHERE tenant_id = $1 AND org_id = $2 AND case_id = $3 AND id = $4
  `, [scope.tenantId, orgId, caseId, snapshotId]);
  if (!snapshot) throw new CarbonError(404, 'CALCULATION_SNAPSHOT_NOT_FOUND', '未找到可访问的计算快照。');
  return {...snapshot, createdAt: new Date(snapshot.createdAt).toISOString()};
}

async function readStoredFactorDecision(tx, key) {
  const {rows: [decision]} = await tx.query(`
    SELECT decision.case_id AS "caseId", decision.submission_revision AS "submissionRevision",
      decision.decided_by AS "decidedBy", decision.decided_at AS "decidedAt",
      decision.method_reference AS "methodReference", decision.rationale, row_to_json(factor) AS factor
    FROM carbon.case_factor_decision AS decision
    JOIN LATERAL (
      SELECT ${factorReferenceFields} FROM catalog.factor_reference_version
      WHERE factor_id = decision.factor_id AND version = decision.factor_version
    ) AS factor ON true
    WHERE decision.tenant_id = $1 AND decision.org_id = $2 AND decision.case_id = $3
      AND decision.submission_revision = $4
  `, key);
  if (!decision) return null;
  return {decision: {...decision, decidedAt: new Date(decision.decidedAt).toISOString(),
    formalReportEligible: false, externalDeliveryEligible: false}};
}

async function calculateSubmittedElectricity(tx, key, from, to, factor) {
  const {rows} = await tx.query(`
    WITH activity AS (
      SELECT * FROM carbon.case_submission_activity
      WHERE tenant_id = $1 AND org_id = $2 AND case_id = $3 AND submission_revision = $4
        AND period BETWEEN $5::date AND $6::date
    ), slots AS (
      SELECT month.period, activity.quantity, activity.unit,
        CASE WHEN extract(year FROM month.period) = $7::integer AND activity.unit = $8
          THEN activity.quantity * $9::numeric END AS emissions,
        CASE WHEN activity.activity_revision IS NOT NULL THEN jsonb_build_object(
          'activityRevision', activity.activity_revision, 'batchId', activity.batch_id,
          'previewRevision', activity.preview_revision, 'sourceRow', activity.source_row,
          'sourceType', activity.source_type, 'conversionVersion', activity.conversion_version,
          'originalQuantity', activity.original_quantity, 'originalUnit', activity.original_unit
        ) END AS lineage
      FROM generate_series($5::date::timestamp, $6::date::timestamp, interval '1 month') AS month(period)
      LEFT JOIN activity ON activity.period = month.period::date AND activity.source = 'electricity'
    )
    SELECT to_char(period, 'YYYY-MM') AS period, trim_scale(quantity)::text AS quantity,
      coalesce(unit, 'kWh') AS unit, trim_scale(emissions)::text AS "emissionsKg", lineage,
      trim_scale(sum(emissions) OVER ())::text AS "subtotalKg",
      trim_scale(sum(emissions) OVER () * 0.001::numeric)::text AS "subtotalT",
      ARRAY(SELECT DISTINCT source FROM activity WHERE source <> 'electricity' ORDER BY source) AS "excludedSources"
    FROM slots ORDER BY period
  `, [...key, `${from}-01`, `${to}-01`, factor?.dataYear ?? null, factor?.inputUnit ?? null, factor?.value ?? null]);
  const {subtotalKg, subtotalT, excludedSources} = rows[0];
  const items = rows.map(({subtotalKg, subtotalT, excludedSources, ...item}) => ({
    ...item, source: 'electricity', factor,
    status: item.quantity === null ? 'missing_activity' : item.emissionsKg === null ? 'missing_factor' : 'calculated'
  }));
  const expectedSlots = items.length;
  const availableSlots = items.filter(item => item.status === 'calculated').length;
  const missingSlots = expectedSlots - availableSlots;
  const status = !availableSlots ? 'empty' : missingSlots ? 'partial' : 'complete';
  return {
    coverage: {status, expectedSlots, availableSlots, missingSlots}, items, excludedSources,
    outputUnit: factor?.outputUnit ?? null, knownSubtotalKg: subtotalKg,
    totalKg: missingSlots ? null : subtotalKg, totalT: missingSlots ? null : subtotalT
  };
}

async function readSubmissionCalculation(tx, key, from, to) {
  const [, , caseId, submissionRevision] = key;
  const {rows: [submission]} = await tx.query(`
    SELECT capture.submission_revision IS NOT NULL AS captured
    FROM carbon.case_submission AS submission
    LEFT JOIN carbon.case_submission_activity_capture AS capture
      ON (capture.tenant_id, capture.org_id, capture.case_id, capture.submission_revision)
       = (submission.tenant_id, submission.org_id, submission.case_id, submission.revision)
    WHERE (submission.tenant_id, submission.org_id, submission.case_id, submission.revision) = ($1, $2, $3, $4)
  `, key);
  if (!submission) throw new CarbonError(404, 'REVISION_NOT_FOUND', '未找到该任务的提交版本。');
  if (!submission.captured) {
    throw new CarbonError(409, 'CALCULATION_INPUT_UNAVAILABLE', '该版本没有固定活动数据，请使用重新提交的版本。');
  }
  const stored = await readStoredFactorDecision(tx, key);
  const factorDecision = stored?.decision ?? null;
  const result = await calculateSubmittedElectricity(tx, key, from, to, factorDecision?.factor ?? null);
  return {caseId, submissionRevision, from, to, mode: 'controlled', scope: 'purchased_electricity',
    formalReportEligible: false, externalDeliveryEligible: false, model: controlledElectricityModel, factorDecision, ...result};
}

async function readProductTask(tx, scope, orgId, caseId, customerOnly, lock) {
  const task = await readVisibleCase(tx, scope, orgId, caseId, customerOnly, lock);
  const {rows: [release]} = await tx.query(`SELECT code FROM carbon.scenario_release
    WHERE tenant_id = $1 AND id = $2`, [scope.tenantId, task.scenarioReleaseId]);
  if (release?.code !== productElectricityScenario || task.scope?.subjectType !== 'product') {
    throw new CarbonError(409, 'PRODUCT_SCOPE_UNAVAILABLE', '仅产品碳足迹场景中已申报产品的任务支持此试算。');
  }
  return task;
}

async function saveSnapshot(tx, scope, key, result, inputs) {
  const fingerprint = createHash('sha256').update(JSON.stringify(inputs)).digest('hex');
  const {rows: [created]} = await tx.query(`
    INSERT INTO carbon.calculation_snapshot (tenant_id, org_id, case_id, id, created_by, request_id,
      schema_version, from_period, to_period, input_fingerprint, payload, submission_revision)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    ON CONFLICT (tenant_id, org_id, case_id, input_fingerprint) DO NOTHING
    RETURNING ${snapshotFields}
  `, [...key, randomUUID(), scope.actorId, scope.requestId, snapshotSchemaVersion,
    `${result.from}-01`, `${result.to}-01`, fingerprint, JSON.stringify(result), result.submissionRevision ?? null]);
  if (created) return {status: 201, body: {...created, createdAt: new Date(created.createdAt).toISOString()}};

  const {rows: [existing]} = await tx.query(`
    SELECT ${snapshotFields} FROM carbon.calculation_snapshot
    WHERE tenant_id = $1 AND org_id = $2 AND case_id = $3 AND input_fingerprint = $4
  `, [...key, fingerprint]);
  return {status: 200, body: {...existing, createdAt: new Date(existing.createdAt).toISOString()}};
}

function draftResponse({draftId, createdAt, payload}) {
  return {draftId, createdAt: new Date(createdAt).toISOString(), ...payload};
}

async function saveDraft(tx, scope, key, payload) {
  const {snapshotId, template} = payload;
  const sourceColumn = payload.mode === 'internal_trial' ? 'trial_snapshot_id' : 'snapshot_id';
  const draftKey = [...key, snapshotId, template.id, template.version];
  const {rows: [created]} = await tx.query(`
    INSERT INTO carbon.internal_report_draft
      (tenant_id, org_id, case_id, ${sourceColumn}, template_id, template_version, id, created_by, request_id, payload)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (tenant_id, org_id, case_id, ${sourceColumn}, template_id, template_version) DO NOTHING
    RETURNING ${draftFields}
  `, [...draftKey, randomUUID(), scope.actorId, scope.requestId, JSON.stringify(payload)]);
  if (created) return {status: 201, body: draftResponse(created)};

  const {rows: [existing]} = await tx.query(`
    SELECT ${draftFields} FROM carbon.internal_report_draft
    WHERE tenant_id = $1 AND org_id = $2 AND case_id = $3 AND ${sourceColumn} = $4
      AND template_id = $5 AND template_version = $6
  `, draftKey);
  return {status: 200, body: draftResponse(existing)};
}

async function readDraft(tx, key) {
  const {rows: [draft]} = await tx.query(`
    SELECT ${draftFields}, CASE WHEN payload->>'mode' = 'controlled'
      THEN carbon.report_delivery_factor_scope($1, $2, $3, $4) END AS "factorDisclosure"
    FROM carbon.internal_report_draft
    WHERE tenant_id = $1 AND org_id = $2 AND case_id = $3 AND id = $4
  `, key);
  if (!draft) throw new CarbonError(404, 'REPORT_DRAFT_NOT_FOUND', '未找到可访问的内部报告稿。');
  const {factorDisclosure} = draft;
  const result = draftResponse(draft);
  return result.mode === 'controlled' ? {...result, deliveryPolicy: {
    factorDisclosure: factorDisclosure ?? 'internal_only',
    allowDelivery: factorDisclosure === 'source_and_value' || factorDisclosure === 'summary_only',
    allowFactor: factorDisclosure === 'source_and_value',
    allowMonthly: factorDisclosure === 'source_and_value'
  }} : result;
}

async function findReportReview(tx, key) {
  const {rows: [review]} = await tx.query(`
    SELECT ${reportReviewFields} FROM carbon.internal_report_review
    WHERE tenant_id = $1 AND org_id = $2 AND case_id = $3 AND draft_id = $4
  `, key);
  return review;
}

function reportReviewResponse(review) {
  if (!review) throw new CarbonError(404, 'REPORT_REVIEW_NOT_FOUND', '未找到该报告稿的复核记录。');
  return {...review, submittedAt: new Date(review.submittedAt).toISOString(),
    reviewedAt: review.reviewedAt === null ? null : new Date(review.reviewedAt).toISOString(),
    formalReportEligible: false, externalDeliveryEligible: false};
}

function isCurrentSubmission(task, submissionRevision) {
  return (task.status === 'submitted' && task.revision === submissionRevision)
    || (task.status === 'approved' && task.revision - 1 === submissionRevision);
}

function deliverySourceConflict() {
  return new CarbonError(409, 'REPORT_DELIVERY_SOURCE_CONFLICT', '交付需要当前有效提交的完整外购电力管理稿，并已通过独立复核。');
}

function permitsDelivery(policy, {includeFactor, includeMonthly}) {
  return policy?.allowDelivery && (!includeFactor || policy.allowFactor) && (!includeMonthly || policy.allowMonthly);
}

function deliveryFactorConflict() {
  return new CarbonError(409, 'REPORT_DELIVERY_FACTOR_DISCLOSURE', '当前因子版本的披露范围不允许生成或交付此文件。');
}

function deliveryResponse(delivery) {
  if (!delivery) throw new CarbonError(404, 'REPORT_DELIVERY_NOT_FOUND', '未找到可访问的交付记录。');
  const {createdAt, recordedAt} = delivery;
  return {...delivery, createdAt: new Date(createdAt).toISOString(),
    recordedAt: recordedAt === null ? null : new Date(recordedAt).toISOString(),
    status: recordedAt === null ? 'prepared' : 'recorded'};
}

async function readRuleAssessment(tx, scope, task, revision) {
  const {id, orgId, scenarioReleaseId, purpose, scope: declared} = task;
  const key = [scope.tenantId, orgId, id];
  const {rows: [release]} = await tx.query(`
    SELECT base.version, base.manifest->'catalog'->>'industryName' AS "industryName",
      base.manifest->'references' AS references,
      latest.id AS "newerReleaseId", latest.version AS "newerVersion",
      (SELECT rule_recalculation_of FROM carbon.case_intake
        WHERE (tenant_id, org_id, id) = ($1, $3, $4)) AS "recalculationOf"
    FROM carbon.scenario_release AS base
    LEFT JOIN LATERAL (
      SELECT id, version FROM carbon.scenario_release
      WHERE tenant_id = base.tenant_id AND code = base.code AND version > base.version
        AND (org_id IS NULL OR org_id = $3)
      ORDER BY version DESC, (org_id IS NOT NULL) DESC LIMIT 1
    ) AS latest ON true
    WHERE base.tenant_id = $1 AND base.id = $2
  `, [scope.tenantId, scenarioReleaseId, orgId, id]);
  const {rows: [submission]} = await tx.query(`
    SELECT submission.revision, decision.status, decision.reference_code AS "referenceCode", decision.rationale,
      decision.decided_by AS "decidedBy", decision.decided_at AS "decidedAt"
    FROM carbon.case_submission AS submission
    LEFT JOIN carbon.case_rule_decision AS decision
      ON (decision.tenant_id, decision.org_id, decision.case_id, decision.submission_revision)
       = (submission.tenant_id, submission.org_id, submission.case_id, submission.revision)
    WHERE (submission.tenant_id, submission.org_id, submission.case_id) = ($1, $2, $3)
      AND ($4::integer IS NULL OR submission.revision = $4)
    ORDER BY submission.revision DESC LIMIT 1
  `, [...key, revision]);
  if (revision !== null && !submission) {
    throw new CarbonError(404, 'REVISION_NOT_FOUND', '未找到该任务的提交版本。');
  }
  const candidates = scenarioReferenceItems(release.references, true);
  const {revision: submissionRevision = null, ...stored} = submission ?? {};
  const decision = stored.status ? {...stored, decidedAt: new Date(stored.decidedAt).toISOString()} : null;
  const gaps = [];
  if (!declared) gaps.push('缺少申报主体、地区或报告年度。');
  if (!release.industryName) gaps.push('该场景版本未配置行业。');
  if (!candidates.some(item => item.publicationStatus === 'effective' || item.publicationStatus === 'pilot')) {
    gaps.push('该场景暂无标记为正式或试行的候选依据。');
  }
  if (!decision) gaps.push('适用性待专业人员结合实际范围和用途确认。');
  const recalculation = task.createdBy === scope.actorId && ['submitted', 'approved'].includes(task.status)
    && release.newerReleaseId ? {scenarioReleaseId: release.newerReleaseId, scenarioVersion: release.newerVersion} : null;
  return {scenarioReleaseId, scenarioVersion: release.version, submissionRevision, candidates, gaps, decision,
    status: decision?.status ?? 'needs_review', recalculation, recalculationOf: release.recalculationOf,
    context: {industryName: release.industryName,
      subjectType: declared?.subjectType ?? null, jurisdiction: declared?.jurisdiction ?? null,
      reportingYear: declared?.reportingYear ?? null, purpose}};
}

async function readRuleProposals(tx, scope, orgId, reviewer, proposalId = null) {
  const {rows} = await tx.query(`
    SELECT p.id AS "proposalId", p.base_release_id AS "scenarioReleaseId", base.version AS "scenarioVersion",
      coalesce(base.manifest->'catalog'->>'title', base.code) AS title,
      CASE WHEN pub.release_id IS NOT NULL THEN 'published' ELSE p.status END AS status,
      p.created_by AS "createdBy", p.created_at AS "createdAt", p.review_note AS "reviewNote",
      pub.release_id AS "publishedReleaseId", base.manifest->'references' AS existing,
      p.references_payload AS proposed
    FROM carbon.scenario_rule_proposal AS p
    JOIN carbon.scenario_release AS base ON (base.tenant_id, base.id) = (p.tenant_id, p.base_release_id)
    LEFT JOIN carbon.scenario_rule_publication AS pub
      ON (pub.tenant_id, pub.org_id, pub.proposal_id) = (p.tenant_id, p.org_id, p.id)
    WHERE (p.tenant_id, p.org_id) = ($1, $2) AND ($3::uuid IS NULL OR p.id = $3)
    ORDER BY p.created_at DESC, p.id DESC LIMIT 50
  `, [scope.tenantId, orgId, proposalId]);
  return rows.map(({createdBy, existing, proposed, ...item}) => ({
    ...item, createdAt: new Date(item.createdAt).toISOString(),
    ...(reviewer && {canReview: item.status === 'submitted' && createdBy !== scope.actorId,
      changes: compareRuleReferences(existing, proposed)})
  }));
}

async function readGasCombustionTask(tx, scope, orgId, caseId, revision, customerOnly, lock = false) {
  const task = await readVisibleCase(tx, scope, orgId, caseId, customerOnly, lock);
  const key = [scope.tenantId, orgId, caseId, revision];
  const {rows: [submission]} = await tx.query(`
    SELECT release.code FROM carbon.case_submission AS submitted
    JOIN carbon.scenario_release AS release ON (release.tenant_id, release.id) = ($1, $5)
    WHERE (submitted.tenant_id, submitted.org_id, submitted.case_id, submitted.revision) = ($1, $2, $3, $4)
  `, [...key, task.scenarioReleaseId]);
  if (!submission) throw new CarbonError(404, 'REVISION_NOT_FOUND', '未找到该任务的提交版本。');
  if (submission.code !== gasCombustionScenario || task.scope?.subjectType !== 'facility'
    || task.scope.reportingYear !== '2026') {
    throw new CarbonError(409, 'GAS_COMBUSTION_SCOPE_UNAVAILABLE', '仅支持已申报为 2026 年发电设施的固定燃烧任务。');
  }
  return {task, key};
}

async function readTrialSnapshot(tx, key, snapshotId) {
  const {rows: [snapshot]} = await tx.query(`
    SELECT ${trialSnapshotFields} FROM carbon.model_trial_snapshot
    WHERE (tenant_id, org_id, case_id, submission_revision, id) = ($1, $2, $3, $4, $5)
  `, [...key, snapshotId]);
  if (!snapshot) throw new CarbonError(404, 'CALCULATION_SNAPSHOT_NOT_FOUND', '未找到可访问的试算快照。');
  return {...snapshot, createdAt: new Date(snapshot.createdAt).toISOString()};
}

function gasJobResponse(job, task) {
  return {...job, createdAt: new Date(job.createdAt).toISOString(), updatedAt: new Date(job.updatedAt).toISOString(),
    freshness: isCurrentSubmission(task, job.submissionRevision) ? 'current' : 'stale'};
}

async function calculateProductElectricity(tx, key) {
  const [, , caseId, revision] = key;
  const {rows: [entry]} = await tx.query(`
    SELECT (SELECT row_to_json(profile) FROM (
      SELECT ${productProfileFields} FROM carbon.product_electricity_profile
      WHERE (tenant_id,org_id,case_id,submission_revision) = ($1,$2,$3,$4)
    ) AS profile) AS profile
    FROM carbon.case_submission WHERE (tenant_id,org_id,case_id,revision) = ($1,$2,$3,$4)
  `, key);
  if (!entry) throw new CarbonError(404, 'REVISION_NOT_FOUND', '未找到该任务的提交版本。');
  const {profile} = entry;
  const base = {caseId, submissionRevision: revision,
    model: {id: profile?.modelTemplateId ?? 'product-electricity-contribution', version: profile?.modelTemplateVersion ?? 1},
    profile, formalReportEligible: false, externalDeliveryEligible: false};
  if (!profile) return {...base, status: 'missing_profile', result: null};
  if (base.model.version !== 1) {
    throw new CarbonError(409, 'PRODUCT_MODEL_UNAVAILABLE', '该模板版本的计算实现尚未安装。');
  }

  const electricity = await readSubmissionCalculation(tx, key, profile.from, profile.to);
  const decision = electricity.factorDecision?.factor;
  if (decision?.accountingBasis !== 'product_footprint') {
    return {...base, status: 'missing_product_factor', result: null};
  }
  const source = {coverage: electricity.coverage, items: electricity.items, factor: decision};
  if (electricity.totalKg === null) return {...base, status: 'missing_months', ...source, result: null};

  const {rows: [result]} = await tx.query(`
    WITH input AS (
      SELECT $1::numeric AS total, $2::numeric AS output,
        coalesce($3::numeric, 1) AS target_mass, coalesce($4::numeric, 1) AS batch_mass
    )
    SELECT trim_scale(round(target_mass / batch_mass, 12))::text AS "allocationShare",
      trim_scale(round(total * target_mass / batch_mass, 6))::text AS "allocatedKgCO2e",
      trim_scale(round(total * target_mass / (batch_mass * output), 6))::text AS "kgCO2ePerFunctionalUnit"
    FROM input
  `, [electricity.totalKg, profile.outputQuantity, profile.productMassKg, profile.batchMassKg]);
  return {...base, ...source, status: 'calculated', result: {...result, electricityKgCO2e: electricity.totalKg}};
}

export function createIntakeService(database, quarantine) {
  function inWorkspace(scope, command) {
    return database.transaction(async tx => {
      await tx.query(`SELECT
        set_config('carbon.tenant_id', $1, true),
        set_config('carbon.actor_id', $2, true),
        set_config('carbon.request_id', $3, true)
      `, [scope.tenantId, scope.actorId, scope.requestId]);
      return command(tx);
    });
  }

  return {
    previewCaseReopen(scope, orgId, caseId, customerOnly) {
      return inWorkspace(scope, async tx => {
        const task = await readLockedCase(tx, scope, orgId, caseId, customerOnly);
        const submissionRevision = task.revision - 1;
        const key = [scope.tenantId, orgId, caseId, submissionRevision];
        const {rows: [impact]} = await tx.query(`
          SELECT (
            SELECT count(*)::integer FROM carbon.case_submission_evidence e
            WHERE (e.tenant_id,e.org_id,e.case_id,e.revision) = ($1,$2,$3,$4)
          ) AS "evidenceCount", (
            SELECT count(*)::integer FROM carbon.case_submission_activity a
            WHERE (a.tenant_id,a.org_id,a.case_id,a.submission_revision) = ($1,$2,$3,$4)
          ) AS "activityCount", (
            SELECT count(*)::integer FROM carbon.review_issue i
            WHERE (i.tenant_id,i.org_id,i.case_id,i.submission_revision) = ($1,$2,$3,$4)
              AND i.status <> 'closed' AND i.severity = 'critical'
          ) AS "openCriticalIssues"
          FROM carbon.case_submission s WHERE (s.tenant_id,s.org_id,s.case_id,s.revision) = ($1,$2,$3,$4)
        `, key);
        if (!impact) throw new CarbonError(409, 'CASE_REOPEN_UNAVAILABLE', '该任务缺少已批准提交的版本记录。');
        const {rows: reports} = await tx.query(`
          SELECT d.id AS "draftId", d.payload->>'mode' AS mode, d.payload#>>'{report,scope,from}' AS "from",
            d.payload#>>'{report,scope,to}' AS "to", r.status AS "reviewStatus"
          FROM carbon.internal_report_draft d
          LEFT JOIN carbon.internal_report_review r
            ON (r.tenant_id,r.org_id,r.case_id,r.draft_id) = (d.tenant_id,d.org_id,d.case_id,d.id)
          WHERE (d.tenant_id,d.org_id,d.case_id) = ($1,$2,$3)
            AND (d.source_submission_key = $4::text OR d.trial_submission_revision = $4::integer)
            AND ($5::boolean OR r.draft_id IS NOT NULL)
          ORDER BY d.created_at DESC, d.id DESC
        `, [...key, customerOnly]);
        return {caseId, status: 'locked', approvedRevision: task.revision, submissionRevision,
          reportingYear: task.scope.reportingYear, ...impact, reports};
      });
    },

    listCaseReopenRequests(scope, orgId, caseId, customerOnly) {
      return inWorkspace(scope, async tx => {
        const task = await readLockedCase(tx, scope, orgId, caseId, customerOnly);
        const items = await readCaseReopenRequests(tx, [scope.tenantId, orgId, caseId], null, customerOnly);
        return {canRequest: customerOnly && !items.some(item => item.status !== 'returned'),
          items: items.map(item => ({...item,
            canReview: !customerOnly && task.createdBy !== scope.actorId && item.status === 'pending',
            canCreateDraft: customerOnly && item.status === 'approved' && item.childCaseId === null}))};
      });
    },

    requestCaseReopen(scope, orgId, caseId, approvedRevision, reason) {
      return inWorkspace(scope, async tx => {
        const task = await readLockedCase(tx, scope, orgId, caseId, true, true);
        if (task.revision !== approvedRevision) {
          throw new CarbonError(409, 'CASE_REOPEN_CONFLICT', '批准版本已变化，请刷新重开影响。');
        }
        const key = [scope.tenantId, orgId, caseId];
        const requestId = randomUUID();
        await tx.query(`
          INSERT INTO carbon.case_reopen_request
            (tenant_id,org_id,case_id,id,approved_revision,reason,created_by,request_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        `, [...key, requestId, approvedRevision, reason, scope.actorId, scope.requestId]);
        const [request] = await readCaseReopenRequests(tx, key, requestId);
        return request;
      });
    },

    reviewCaseReopen(scope, orgId, caseId, requestId, decision, reason) {
      return inWorkspace(scope, async tx => {
        const task = await readLockedCase(tx, scope, orgId, caseId, false, true);
        if (task.createdBy === scope.actorId) {
          throw new CarbonError(403, 'SELF_REVIEW_FORBIDDEN', '发起人不能审批自己的重开申请。');
        }
        const key = [scope.tenantId, orgId, caseId];
        const {rows: [updated]} = await tx.query(`
          UPDATE carbon.case_reopen_request
          SET status = $5, reviewed_by = $6, review_reason = $7, review_request_id = $8
          WHERE (tenant_id,org_id,case_id,id) = ($1,$2,$3,$4) AND status = 'pending' RETURNING id
        `, [...key, requestId, decision, scope.actorId, reason, scope.requestId]);
        const [request] = await readCaseReopenRequests(tx, key, requestId);
        if (!request) throw new CarbonError(404, 'CASE_REOPEN_NOT_FOUND', '未找到可访问的重开申请。');
        if (!updated) throw new CarbonError(409, 'CASE_REOPEN_CONFLICT', '重开申请已经处理，请刷新后查看。');
        return request;
      });
    },

    createReopenedDraft(scope, orgId, caseId, requestId) {
      return inWorkspace(scope, async tx => {
        const task = await readLockedCase(tx, scope, orgId, caseId, true, true);
        const key = [scope.tenantId, orgId, caseId];
        const [request] = await readCaseReopenRequests(tx, key, requestId, true);
        if (!request) throw new CarbonError(404, 'CASE_REOPEN_NOT_FOUND', '未找到可访问的重开申请。');
        if (request.status !== 'approved' || request.approvedRevision !== task.revision) {
          throw new CarbonError(409, 'CASE_REOPEN_NOT_APPROVED', '须经独立批准后才能创建关联草稿。');
        }
        if (request.childCaseId) {
          const existing = await readCase(tx, scope, orgId, request.childCaseId, true);
          return {status: 200, body: {...existing, reopenedFromCaseId: caseId, reopenRequestId: requestId}};
        }
        const {rows: [draft]} = await tx.query(`
          INSERT INTO carbon.case_intake
            (tenant_id,org_id,id,scenario_release_id,created_by,purpose,intake_scope,reopen_request_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${caseDetailFields}
        `, [scope.tenantId, orgId, randomUUID(), task.scenarioReleaseId, scope.actorId, task.purpose, task.scope, requestId]);
        return {status: 201, body: {...caseDetail(draft), reopenedFromCaseId: caseId, reopenRequestId: requestId}};
      });
    },

    readSubmissionReviewSummary(scope, orgId, caseId, submissionRevision) {
      return inWorkspace(scope, async tx => {
        await readVisibleCase(tx, scope, orgId, caseId, false);
        const {rows: [summary]} = await tx.query(`
          WITH versions AS (
            SELECT revision FROM carbon.case_submission
            WHERE (tenant_id, org_id, case_id) = ($1, $2, $3) AND revision <= $4
          ), previous AS (
            SELECT max(revision) AS revision FROM versions WHERE revision < $4
          ), evidence AS (
            SELECT revision, evidence_id, receipt_id FROM carbon.case_submission_evidence
            WHERE (tenant_id, org_id, case_id) = ($1, $2, $3)
              AND revision IN ($4, (SELECT revision FROM previous))
          ), activity AS (
            SELECT submission_revision, period, source, activity_revision FROM carbon.case_submission_activity
            WHERE (tenant_id, org_id, case_id) = ($1, $2, $3)
              AND submission_revision IN ($4, (SELECT revision FROM previous))
          ), captures AS (
            SELECT submission_revision FROM carbon.case_submission_activity_capture
            WHERE (tenant_id, org_id, case_id) = ($1, $2, $3)
              AND submission_revision IN ($4, (SELECT revision FROM previous))
          ), evidence_changes AS (
            SELECT count(*) FILTER (WHERE p.evidence_id IS NULL)::integer AS added,
              count(*) FILTER (WHERE n.evidence_id IS NULL)::integer AS removed,
              count(*) FILTER (WHERE n.receipt_id <> p.receipt_id)::integer AS changed
            FROM (SELECT * FROM evidence WHERE revision = $4) n
            FULL JOIN (SELECT * FROM evidence WHERE revision = (SELECT revision FROM previous)) p USING (evidence_id)
          ), activity_changes AS (
            SELECT count(*) FILTER (WHERE p.period IS NULL)::integer AS added,
              count(*) FILTER (WHERE n.period IS NULL)::integer AS removed,
              count(*) FILTER (WHERE n.activity_revision <> p.activity_revision)::integer AS changed
            FROM (SELECT * FROM activity WHERE submission_revision = $4) n
            FULL JOIN (SELECT * FROM activity WHERE submission_revision = (SELECT revision FROM previous)) p USING (period, source)
          ), outstanding AS (
            SELECT count(*)::integer AS total, count(*) FILTER (WHERE severity = 'critical')::integer AS critical
            FROM carbon.review_issue
            WHERE (tenant_id, org_id, case_id, submission_revision) = ($1, $2, $3, $4) AND status <> 'closed'
          )
          SELECT $4 AS "submissionRevision", previous.revision AS "previousRevision",
            (SELECT count(*)::integer FROM evidence WHERE revision = $4) AS "evidenceCount",
            CASE WHEN EXISTS (SELECT 1 FROM captures WHERE submission_revision = $4)
              THEN 'captured' ELSE 'legacy_unavailable' END AS "activityStatus",
            (SELECT count(*)::integer FROM activity WHERE submission_revision = $4) AS "activityCount",
            coalesce(r.status, 'not_recorded') AS "ruleStatus",
            CASE WHEN f.factor_id IS NOT NULL THEN jsonb_build_object('id', f.factor_id, 'version', f.factor_version) END AS "factorVersion",
            outstanding.total AS "openIssueCount", outstanding.critical AS "criticalIssueCount",
            CASE WHEN previous.revision IS NOT NULL THEN jsonb_build_object('evidence', to_jsonb(evidence_changes),
              'activity', CASE WHEN (SELECT count(*) FROM captures) = 2 THEN to_jsonb(activity_changes) END) END AS changes
          FROM previous CROSS JOIN outstanding CROSS JOIN evidence_changes CROSS JOIN activity_changes
          LEFT JOIN carbon.case_rule_decision r ON (r.tenant_id,r.org_id,r.case_id,r.submission_revision) = ($1,$2,$3,$4)
          LEFT JOIN carbon.case_factor_decision f ON (f.tenant_id,f.org_id,f.case_id,f.submission_revision) = ($1,$2,$3,$4)
          WHERE EXISTS (SELECT 1 FROM versions WHERE revision = $4)
        `, [scope.tenantId, orgId, caseId, submissionRevision]);
        if (!summary) throw new CarbonError(404, 'REVISION_NOT_FOUND', '未找到该任务的提交版本。');
        return summary;
      });
    },

    listReviewIssues(scope, orgId, caseId, customerOnly) {
      return inWorkspace(scope, async tx => {
        const task = await readVisibleCase(tx, scope, orgId, caseId, customerOnly);
        const independent = task.createdBy !== scope.actorId;
        return {canOpen: !customerOnly && independent,
          items: await readReviewIssues(tx, [scope.tenantId, orgId, caseId], customerOnly, independent)};
      });
    },

    openReviewIssue(scope, orgId, caseId, input) {
      return inWorkspace(scope, async tx => {
        const task = await readVisibleCase(tx, scope, orgId, caseId, false);
        if (task.createdBy === scope.actorId) {
          throw new CarbonError(403, 'SELF_REVIEW_FORBIDDEN', '发起人不能为自己的任务发起复核问题。');
        }
        const key = [scope.tenantId, orgId, caseId];
        const {rows: [submission]} = await tx.query(`
          SELECT 1 FROM carbon.case_submission WHERE (tenant_id,org_id,case_id,revision) = ($1,$2,$3,$4)
        `, [...key, input.submissionRevision]);
        if (!submission) throw new CarbonError(404, 'REVISION_NOT_FOUND', '未找到该任务的提交版本。');
        const issueId = randomUUID();
        await tx.query(`
          INSERT INTO carbon.review_issue (tenant_id,org_id,case_id,id,submission_revision,evidence_id,
            title,description,severity,due_date,assignee_id,created_by,last_actor_id,request_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,$13)
        `, [...key, issueId, input.submissionRevision, input.evidenceId, input.title, input.description,
          input.severity, input.dueDate, task.createdBy, scope.actorId, scope.requestId]);
        const [issue] = await readReviewIssues(tx, key, false, true, issueId);
        return issue;
      });
    },

    changeReviewIssue(scope, orgId, caseId, issueId, action, expectedVersion, note) {
      return inWorkspace(scope, async tx => {
        const reply = action === 'reply';
        const task = await readVisibleCase(tx, scope, orgId, caseId, reply);
        if (!reply && task.createdBy === scope.actorId) {
          throw new CarbonError(403, 'SELF_REVIEW_FORBIDDEN', '发起人不能复核自己的整改答复。');
        }
        const key = [scope.tenantId, orgId, caseId];
        const [from, to, event] = reply ? ['open', 'answered', 'replied'] : action === 'close'
          ? ['answered', 'closed', 'closed'] : ['answered', 'open', 'request_follow_up'];
        const {rows: [changed]} = await tx.query(`
          UPDATE carbon.review_issue SET status = $7, version = version + 1, last_action = $8,
            last_actor_id = $9, last_note = $10, request_id = $11
          WHERE (tenant_id,org_id,case_id,id,version,status) = ($1,$2,$3,$4,$5,$6) RETURNING id
        `, [...key, issueId, expectedVersion, from, to, event, scope.actorId, note, scope.requestId]);
        const [issue] = await readReviewIssues(tx, key, reply, !reply, issueId);
        if (!issue) throw new CarbonError(404, 'REVIEW_ISSUE_NOT_FOUND', '未找到可访问的整改问题。');
        if (!changed) throw new CarbonError(409, 'REVIEW_ISSUE_CONFLICT', '问题状态或版本已变更，请刷新后处理。');
        return issue;
      });
    },

    resolveWorkspace(scope, role, preferredOrgId) {
      return inWorkspace(scope, async tx => {
        const {rows} = await tx.query(`
          SELECT org_id AS "orgId" FROM carbon.org_grant
          WHERE tenant_id = $1 AND actor_id = $2 AND role = $3
            AND ($4::uuid IS NULL OR org_id = $4)
          LIMIT 2
        `, [scope.tenantId, scope.actorId, role, preferredOrgId]);
        if (rows.length === 0) throw accessDenied();
        if (rows.length > 1) {
          throw new CarbonError(409, 'WORKSPACE_SELECTION_REQUIRED', '请选择要进入的组织。');
        }
        return rows[0];
      });
    },

    previewActivity(scope, orgId, caseId, csv) {
      return inWorkspace(scope, async tx => {
        const task = await readVisibleCase(tx, scope, orgId, caseId, true);
        requireEditableCase(task, '任务当前不能预检活动数据，请刷新后查看状态。');
        return previewActivityCsv(csv);
      });
    },

    readActivityRevision(scope, orgId, caseId, period, source, revision) {
      return inWorkspace(scope, async tx => {
        await readVisibleCase(tx, scope, orgId, caseId, true);
        const {rows: [activity]} = await tx.query(`
          SELECT to_char(period, 'YYYY-MM') AS period, source, revision, trim_scale(quantity)::text AS quantity, unit,
            jsonb_build_object('batchId', batch_id, 'previewRevision', preview_revision,
              'sourceRow', source_row, 'sourceType', source_type, 'conversionVersion', conversion_version,
              'originalQuantity', original_quantity, 'originalUnit', original_unit) AS lineage
          FROM carbon.activity_record_revision
          WHERE tenant_id = $1 AND org_id = $2 AND case_id = $3 AND period = $4::date AND source = $5
            AND ($6::integer IS NULL OR revision = $6)
          ORDER BY revision DESC LIMIT 1
        `, [scope.tenantId, orgId, caseId, `${period}-01`, source, revision]);
        if (!activity) throw new CarbonError(404, 'ACTIVITY_NOT_FOUND', '未找到该活动的已确认修订。');
        return activity;
      });
    },

    previewCalculation(scope, orgId, caseId, from, to) {
      return inWorkspace(scope, async tx => {
        await readVisibleCase(tx, scope, orgId, caseId, true);
        return calculateActivity(tx, scope, orgId, caseId, from, to);
      });
    },

    saveCalculationSnapshot(scope, orgId, caseId, from, to) {
      return inWorkspace(scope, async tx => {
        await readVisibleCase(tx, scope, orgId, caseId, true);
        const result = await calculateActivity(tx, scope, orgId, caseId, from, to);
        if (result.coverage.status !== 'complete') {
          throw new CarbonError(409, 'CALCULATION_INCOMPLETE', '核算数据未覆盖全部活动，请查看预览中的缺失项。');
        }
        const model = result.model;
        const inputs = [snapshotSchemaVersion, from, to, model.id, model.version, model.factorSetId, model.factorSetVersion,
          result.items.map(item => [item.period, item.source, item.lineage.activityRevision])];
        return saveSnapshot(tx, scope, [scope.tenantId, orgId, caseId], result, inputs);
      });
    },

    readCalculationSnapshot(scope, orgId, caseId, snapshotId) {
      return inWorkspace(scope, async tx => {
        await readVisibleCase(tx, scope, orgId, caseId, true);
        return readSnapshot(tx, scope, orgId, caseId, snapshotId);
      });
    },

    createInternalReportDraft(scope, orgId, caseId, snapshotId) {
      return inWorkspace(scope, async tx => {
        const task = await readVisibleCase(tx, scope, orgId, caseId, true);
        const snapshot = await readSnapshot(tx, scope, orgId, caseId, snapshotId);
        const result = snapshot.result;
        if (snapshot.schemaVersion !== 1 || result.mode !== 'synthetic' || result.formalReportEligible !== false
          || result.coverage.status !== 'complete') {
          throw new CarbonError(409, 'REPORT_DRAFT_SOURCE_UNSUPPORTED', '请选择支持的完整计算快照。');
        }
        const template = {id: 'internal-management-demo', version: task.scope ? 2 : 1, locale: 'zh-CN'};
        const reportScope = {caseId, from: result.from, to: result.to, purpose: task.purpose, snapshotCreatedAt: snapshot.createdAt};
        if (task.scope) {
          const {subjectType, subjectName, jurisdiction, reportingYear, recipient} = task.scope;
          reportScope.declaredScope = {subjectType, subjectName, jurisdiction, reportingYear, recipient};
        }
        const payload = {
          caseId, snapshotId, status: 'draft', mode: 'synthetic', formalReportEligible: false,
          externalDeliveryEligible: false, template,
          report: {
            title: '内部管理报告演示稿', watermark: '内部演示｜合成因子｜禁止外发',
            scope: reportScope,
            summary: {coverage: result.coverage, totalKgCO2e: result.totalKgCO2e, totalTCO2e: result.totalTCO2e},
            model: result.model, items: result.items,
            limitations: [
              '合成因子仅用于内部演示。',
              '覆盖范围按本演示模板计算。',
              '尚未完成正式适用性审核，稿件禁止外发或用于正式报告。'
            ]
          }
        };
        return saveDraft(tx, scope, [scope.tenantId, orgId, caseId], payload);
      });
    },

    createControlledInternalReportDraft(scope, orgId, caseId, submissionRevision, from, to) {
      return inWorkspace(scope, async tx => {
        const task = await readVisibleCase(tx, scope, orgId, caseId, true, true);
        if (!isCurrentSubmission(task, submissionRevision)) {
          throw new CarbonError(409, 'REPORT_DRAFT_REVISION_CONFLICT', '请选择当前有效的提交版本生成报告。');
        }
        const key = [scope.tenantId, orgId, caseId];
        const result = await readSubmissionCalculation(tx, [...key, submissionRevision], from, to);
        if (!result.coverage.availableSlots) {
          throw new CarbonError(409, 'REPORT_DRAFT_SOURCE_UNSUPPORTED', '所选期间没有可试算的外购电力。请核对活动数据、因子年份和月份。');
        }
        const {factorId, version} = result.factorDecision.factor;
        const inputs = [snapshotSchemaVersion, result.model.id, result.model.version, submissionRevision, from, to, factorId, version];
        const {body: snapshot} = await saveSnapshot(tx, scope, key, result, inputs);
        const {model, factorDecision, coverage, outputUnit, knownSubtotalKg, totalKg, totalT, items, excludedSources} = snapshot.result;
        const template = {id: 'internal-management-electricity', version: 1, locale: 'zh-CN'};
        const saved = await saveDraft(tx, scope, key, {
          caseId, snapshotId: snapshot.snapshotId, status: 'draft', mode: 'controlled',
          formalReportEligible: false, externalDeliveryEligible: false, template,
          report: {
            title: '外购电力内部管理报告', watermark: '内部管理｜待授权交付',
            scope: {caseId, from, to, purpose: task.purpose, submissionRevision, snapshotCreatedAt: snapshot.createdAt,
              ...(task.scope && {declaredScope: task.scope})},
            summary: {coverage, outputUnit, knownSubtotalKg, totalKg, totalT},
            model, factorDecision, items, excludedSources,
            limitations: [
              '本稿覆盖所选月份的外购电力，其他排放源不计入。',
              ...(coverage.status === 'partial' ? ['部分月份缺少已提交活动数据或匹配因子，仅列已知小计。'] : []),
              '本稿供内部管理和复核，对外交付须单独授权。'
            ]
          }
        });
        return {status: saved.status, body: await readDraft(tx, [...key, saved.body.draftId])};
      });
    },

    listInternalReportDrafts(scope, orgId, caseId, limit, cursor, customerOnly) {
      return inWorkspace(scope, async tx => {
        const task = await readVisibleCase(tx, scope, orgId, caseId, customerOnly);
        if (!customerOnly && task.createdBy === scope.actorId) {
          throw new CarbonError(403, 'SELF_REVIEW_FORBIDDEN', '发起人不能复核自己的任务。');
        }
        const {rows} = await tx.query(`
          SELECT draft.id AS "draftId", coalesce(draft.snapshot_id, draft.trial_snapshot_id) AS "snapshotId",
            draft.created_at AS "createdAt",
            draft.payload#>>'{report,scope,from}' AS "from", draft.payload#>>'{report,scope,to}' AS "to",
            draft.template_version AS "templateVersion", draft.payload->>'mode' AS mode, review.status AS "reviewStatus"
          FROM carbon.internal_report_draft AS draft
          LEFT JOIN carbon.internal_report_review AS review
            ON NOT $6::boolean AND review.tenant_id = draft.tenant_id AND review.org_id = draft.org_id
            AND review.case_id = draft.case_id AND review.draft_id = draft.id
          LEFT JOIN carbon.internal_report_draft AS anchor
            ON anchor.tenant_id = draft.tenant_id AND anchor.org_id = draft.org_id
            AND anchor.case_id = draft.case_id AND anchor.id = $4::uuid
          WHERE draft.tenant_id = $1 AND draft.org_id = $2 AND draft.case_id = $3
            AND ($6::boolean OR review.draft_id IS NOT NULL)
            AND ($4::uuid IS NULL OR (draft.created_at, draft.id) < (anchor.created_at, anchor.id))
          ORDER BY draft.created_at DESC, draft.id DESC
          LIMIT $5
        `, [scope.tenantId, orgId, caseId, cursor, limit + 1, customerOnly]);
        const items = rows.slice(0, limit).map(({reviewStatus, mode, ...item}) => ({...item,
          createdAt: new Date(item.createdAt).toISOString(), ...(mode !== 'synthetic' && {mode}),
          ...(!customerOnly && {reviewStatus})}));
        return {items, nextCursor: rows.length > limit ? items.at(-1).draftId : null};
      });
    },

    readInternalReportDraft(scope, orgId, caseId, draftId) {
      return inWorkspace(scope, async tx => {
        await readVisibleCase(tx, scope, orgId, caseId, true);
        return readDraft(tx, [scope.tenantId, orgId, caseId, draftId]);
      });
    },

    readReportReleaseReadiness(scope, orgId, caseId, draftId) {
      return inWorkspace(scope, async tx => {
        const task = await readVisibleCase(tx, scope, orgId, caseId, false);
        if (task.createdBy === scope.actorId) {
          throw new CarbonError(403, 'SELF_REVIEW_FORBIDDEN', '发起人不能核对自己的报告发布条件。');
        }
        const key = [scope.tenantId, orgId, caseId];
        const draftKey = [...key, draftId];
        const review = reportReviewResponse(await findReportReview(tx, draftKey));
        const draft = await readDraft(tx, draftKey);
        const {rows: [{criticalIssueCount}]} = await tx.query(`
          SELECT count(*)::integer AS "criticalIssueCount" FROM carbon.review_issue
          WHERE (tenant_id,org_id,case_id) = ($1,$2,$3) AND severity = 'critical' AND status <> 'closed'
        `, key);
        const checks = [
          ['approved_case', task.status === 'approved'],
          ['current_submission', isCurrentSubmission(task, draft.report.scope.submissionRevision)],
          ['declared_scope', Boolean(draft.report.scope.declaredScope?.reportingYear)],
          ['complete_coverage', draft.report.summary.coverage.status === 'complete'],
          ['independent_review', review?.status === 'reviewed'],
          ['no_critical_issues', criticalIssueCount === 0],
          ['formal_eligibility', draft.formalReportEligible === true]
        ].map(([code, passed]) => ({code, passed}));
        return {draftId, canPublish: false, criticalIssueCount, checks};
      });
    },

    submitInternalReportReview(scope, orgId, caseId, draftId) {
      return inWorkspace(scope, async tx => {
        await readVisibleCase(tx, scope, orgId, caseId, true);
        const key = [scope.tenantId, orgId, caseId, draftId];
        const existing = await findReportReview(tx, key);
        if (existing) return {status: 200, body: {review: reportReviewResponse(existing)}};
        await readDraft(tx, key);
        const {rows: [created]} = await tx.query(`
          INSERT INTO carbon.internal_report_review
            (tenant_id, org_id, case_id, draft_id, submitted_by, submitted_request_id)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (tenant_id, org_id, case_id, draft_id) DO NOTHING
          RETURNING ${reportReviewFields}
        `, [...key, scope.actorId, scope.requestId]);
        return {status: created ? 201 : 200, body: {review: reportReviewResponse(created ?? await findReportReview(tx, key))}};
      });
    },

    readInternalReportReview(scope, orgId, caseId, draftId, customerOnly) {
      return inWorkspace(scope, async tx => {
        const task = await readVisibleCase(tx, scope, orgId, caseId, customerOnly);
        if (!customerOnly && task.createdBy === scope.actorId) {
          throw new CarbonError(403, 'SELF_REVIEW_FORBIDDEN', '发起人不能复核自己的任务。');
        }
        const key = [scope.tenantId, orgId, caseId, draftId];
        const review = reportReviewResponse(await findReportReview(tx, key));
        return customerOnly ? {review} : {review, draft: await readDraft(tx, key)};
      });
    },

    decideInternalReportReview(scope, orgId, caseId, draftId, decision, reason) {
      return inWorkspace(scope, async tx => {
        const task = await readVisibleCase(tx, scope, orgId, caseId, false);
        if (task.createdBy === scope.actorId) {
          throw new CarbonError(403, 'SELF_REVIEW_FORBIDDEN', '发起人不能复核自己的任务。');
        }
        const key = [scope.tenantId, orgId, caseId, draftId];
        const {rows: [review]} = await tx.query(`
          UPDATE carbon.internal_report_review
          SET status = $5, reviewed_by = $6, reviewed_request_id = $7, reason = $8
          WHERE tenant_id = $1 AND org_id = $2 AND case_id = $3 AND draft_id = $4 AND status = 'submitted'
          RETURNING ${reportReviewFields}
        `, [...key, decision, scope.actorId, scope.requestId, reason]);
        if (!review && await findReportReview(tx, key)) {
          throw new CarbonError(409, 'REPORT_REVIEW_CONFLICT', '该报告稿已有复核结论。');
        }
        return {review: reportReviewResponse(review)};
      });
    },

    createReportDelivery(scope, orgId, caseId, draftId, input) {
      return inWorkspace(scope, async tx => {
        const task = await readVisibleCase(tx, scope, orgId, caseId, true, true);
        const key = [scope.tenantId, orgId, caseId, draftId];
        const draft = await readDraft(tx, key);
        const review = await findReportReview(tx, key);
        if (draft.mode !== 'controlled' || draft.report.summary.coverage.status !== 'complete'
          || !isCurrentSubmission(task, draft.report.scope.submissionRevision) || review?.status !== 'reviewed') {
          throw deliverySourceConflict();
        }
        if (!permitsDelivery(draft.deliveryPolicy, input)) throw deliveryFactorConflict();
        const {recipient, purpose, includeMonthly, includeFactor} = input;
        const deliveryKey = [...key, recipient, purpose, includeMonthly, includeFactor];
        const deliveryId = randomUUID();
        const factor = includeFactor
          ? (await readStoredFactorDecision(tx, [...key.slice(0, 3), draft.report.scope.submissionRevision])).decision.factor
          : null;
        const documentHtml = renderDeliveryDocument(draft, deliveryId, input, factor);
        const digest = createHash('sha256').update(documentHtml, 'utf8').digest('hex');
        const {rows: [created]} = await tx.query(`
          INSERT INTO carbon.internal_report_delivery
            (tenant_id, org_id, case_id, draft_id, recipient, purpose, include_monthly, include_factor,
              id, created_by, request_id, document_html, document_sha256)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
          ON CONFLICT (tenant_id, org_id, case_id, draft_id, recipient, purpose, include_monthly, include_factor) DO NOTHING
          RETURNING ${deliveryFields}
        `, [...deliveryKey, deliveryId, scope.actorId, scope.requestId, documentHtml, digest]);
        if (created) return {status: 201, body: deliveryResponse(created)};
        const {rows: [existing]} = await tx.query(`
          SELECT ${deliveryFields} FROM carbon.internal_report_delivery
          WHERE (tenant_id, org_id, case_id, draft_id, recipient, purpose, include_monthly, include_factor)
              = ($1, $2, $3, $4, $5, $6, $7, $8)
        `, deliveryKey);
        return {status: 200, body: deliveryResponse(existing)};
      });
    },

    listReportDeliveries(scope, orgId, caseId, draftId) {
      return inWorkspace(scope, async tx => {
        await readVisibleCase(tx, scope, orgId, caseId, true);
        const key = [scope.tenantId, orgId, caseId, draftId];
        await readDraft(tx, key);
        const {rows} = await tx.query(`
          SELECT ${deliveryFields} FROM carbon.internal_report_delivery
          WHERE (tenant_id, org_id, case_id, draft_id) = ($1, $2, $3, $4)
          ORDER BY created_at DESC, id DESC
        `, key);
        return {items: rows.map(deliveryResponse)};
      });
    },

    readReportDelivery(scope, orgId, caseId, draftId, deliveryId) {
      return inWorkspace(scope, async tx => {
        await readVisibleCase(tx, scope, orgId, caseId, true);
        const key = [scope.tenantId, orgId, caseId, draftId];
        const draft = await readDraft(tx, key);
        const {rows: [delivery]} = await tx.query(`
          SELECT ${deliveryFields}, CASE WHEN EXISTS (
            SELECT 1 FROM carbon.case_intake
            WHERE (tenant_id, org_id, id) = ($1, $2, $3)
              AND ((status = 'submitted' AND revision = $6)
                OR (status = 'approved' AND revision = $6 + 1))
          ) THEN document_html END AS "documentHtml"
          FROM carbon.internal_report_delivery
          WHERE (tenant_id, org_id, case_id, draft_id, id) = ($1, $2, $3, $4, $5)
        `, [...key, deliveryId, draft.report.scope.submissionRevision ?? null]);
        if (delivery && !permitsDelivery(draft.deliveryPolicy, delivery)) delivery.documentHtml = null;
        return deliveryResponse(delivery);
      });
    },

    recordReportDelivery(scope, orgId, caseId, draftId, deliveryId, deliveryReference) {
      return inWorkspace(scope, async tx => {
        const task = await readVisibleCase(tx, scope, orgId, caseId, true, true);
        const key = [scope.tenantId, orgId, caseId, draftId];
        const draft = await readDraft(tx, key);
        const {rows: [stored]} = await tx.query(`
          SELECT ${deliveryFields} FROM carbon.internal_report_delivery
          WHERE (tenant_id, org_id, case_id, draft_id, id) = ($1, $2, $3, $4, $5)
        `, [...key, deliveryId]);
        const existing = deliveryResponse(stored);
        if (!isCurrentSubmission(task, draft.report.scope.submissionRevision)) throw deliverySourceConflict();
        if (existing.status === 'recorded') {
          if (existing.deliveryReference === deliveryReference) return existing;
          throw new CarbonError(409, 'REPORT_DELIVERY_ALREADY_RECORDED', '该交付件已记录凭证。');
        }
        if (!permitsDelivery(draft.deliveryPolicy, existing)) throw deliveryFactorConflict();
        const {rows: [recorded]} = await tx.query(`
          UPDATE carbon.internal_report_delivery
          SET recorded_by = $6, recorded_request_id = $7, delivery_reference = $8
          WHERE (tenant_id, org_id, case_id, draft_id, id) = ($1, $2, $3, $4, $5) AND recorded_at IS NULL
          RETURNING ${deliveryFields}
        `, [...key, deliveryId, scope.actorId, scope.requestId, deliveryReference]);
        return deliveryResponse(recorded);
      });
    },

    saveActivityImport(scope, orgId, caseId, csv) {
      return inWorkspace(scope, async tx => {
        await requireRole(tx, scope, orgId, 'customer');
        const task = await readCase(tx, scope, orgId, caseId, true, true);
        const key = [scope.tenantId, orgId, caseId];
        const sha256 = createHash('sha256').update(csv).digest('hex');
        const {rows} = await tx.query(`
          SELECT id FROM carbon.ingestion_batch
          WHERE tenant_id = $1 AND org_id = $2 AND case_id = $3 AND template_version = $4 AND source_sha256 = $5
        `, [...key, activityTemplate, sha256]);
        if (rows.length) return readImport(tx, key, rows[0].id);
        requireEditableCase(task, '任务当前不能保存导入批次。');
        const batchId = randomUUID();
        await tx.query(`
          INSERT INTO carbon.ingestion_batch
            (tenant_id, org_id, case_id, id, source_sha256, template_version, source_csv, created_by, request_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `, [...key, batchId, sha256, activityTemplate, csv, scope.actorId, scope.requestId]);
        return appendImportPreview(tx, key, scope, batchId, 1, csv);
      });
    },

    readActivityImport(scope, orgId, caseId, batchId) {
      return inWorkspace(scope, async tx => {
        await readVisibleCase(tx, scope, orgId, caseId, true);
        return readImport(tx, [scope.tenantId, orgId, caseId], batchId);
      });
    },

    repreviewActivityImport(scope, orgId, caseId, batchId, previewRevision) {
      return inWorkspace(scope, async tx => {
        await requireRole(tx, scope, orgId, 'customer');
        const task = await readCase(tx, scope, orgId, caseId, true, true);
        const key = [scope.tenantId, orgId, caseId];
        const previous = await readImport(tx, key, batchId);
        requireEditableCase(task, '任务当前不能重新预检导入批次。');
        if (previous.receipt || previous.previewRevision !== previewRevision) {
          throw new CarbonError(409, 'IMPORT_STALE_PREVIEW', '预览已变化或完成入账，请刷新后查看。');
        }
        const {rows} = await tx.query(`
          SELECT source_csv FROM carbon.ingestion_batch
          WHERE tenant_id = $1 AND org_id = $2 AND case_id = $3 AND id = $4
        `, [...key, batchId]);
        return appendImportPreview(tx, key, scope, batchId, previewRevision + 1, rows[0].source_csv);
      });
    },

    commitActivityImport(scope, orgId, caseId, batchId, previewRevision) {
      return inWorkspace(scope, async tx => {
        await requireRole(tx, scope, orgId, 'customer');
        const {rows} = await tx.query(`
          SELECT preview_revision AS "previewRevision", inserted, corrected, unchanged, committed_at AS "committedAt"
          FROM carbon.commit_activity_import($1, $2, $3, $4)
        `, [orgId, caseId, batchId, previewRevision]);
        return {batchId, ...rows[0], committedAt: new Date(rows[0].committedAt).toISOString()};
      });
    },

    listFactorReferenceRegions(scope, orgId, {accountingBasis, dataYear}) {
      return inWorkspace(scope, async tx => {
        await requireRole(tx, scope, orgId, 'reviewer');
        const {rows: items} = await tx.query(`
          SELECT DISTINCT ON (region_code) region_code AS "regionCode", region_name AS "regionName"
          FROM catalog.factor_reference_version
          WHERE accounting_basis = $1 AND data_year = $2
          ORDER BY region_code, version DESC, factor_id
        `, [accountingBasis, dataYear]);
        return {items};
      });
    },

    listFactorReferences(scope, orgId, {accountingBasis, regionCode, dataYear}) {
      return inWorkspace(scope, async tx => {
        await requireRole(tx, scope, orgId, 'reviewer');
        const {rows: items} = await tx.query(`
          SELECT ${factorReferenceFields}
          FROM catalog.factor_reference_version
          WHERE accounting_basis = $1 AND region_code = $2 AND data_year = $3
          ORDER BY factor_id, version DESC
        `, [accountingBasis, regionCode, dataYear]);
        return {items};
      });
    },

    readFactorDecision(scope, orgId, caseId, submissionRevision, customerOnly) {
      return inWorkspace(scope, async tx => {
        await readVisibleCase(tx, scope, orgId, caseId, customerOnly);
        const result = await readStoredFactorDecision(tx, [scope.tenantId, orgId, caseId, submissionRevision]);
        if (!result) throw new CarbonError(404, 'FACTOR_DECISION_NOT_FOUND', '未找到该提交的因子选择记录。');
        return result;
      });
    },

    previewSubmissionCalculation(scope, orgId, caseId, submissionRevision, from, to) {
      return inWorkspace(scope, async tx => {
        const task = await readVisibleCase(tx, scope, orgId, caseId, false);
        if (task.createdBy === scope.actorId) {
          throw new CarbonError(403, 'SELF_REVIEW_FORBIDDEN', '发起人不能复核自己的任务。');
        }
        return readSubmissionCalculation(tx, [scope.tenantId, orgId, caseId, submissionRevision], from, to);
      });
    },

    recordFactorDecision(scope, orgId, caseId, submissionRevision, input) {
      return inWorkspace(scope, async tx => {
        const task = await readVisibleCase(tx, scope, orgId, caseId, false);
        if (task.createdBy === scope.actorId) {
          throw new CarbonError(403, 'SELF_REVIEW_FORBIDDEN', '发起人不能复核自己的任务。');
        }
        if (task.status !== 'submitted' || task.revision !== submissionRevision) {
          throw new CarbonError(409, 'FACTOR_DECISION_CONFLICT', '仅当前待复核提交可记录一次因子选择。');
        }
        const key = [scope.tenantId, orgId, caseId, submissionRevision];
        const {rows} = await tx.query(`
          INSERT INTO carbon.case_factor_decision (tenant_id, org_id, case_id, submission_revision,
            factor_id, factor_version, decided_by, request_id, method_reference, rationale)
          SELECT $1, $2, $3, $4, factor_id, version, $10, $11, $12, $13
          FROM catalog.factor_reference_version
          WHERE factor_id = $5 AND version = $6 AND accounting_basis = $7
            AND region_code = $8 AND data_year = $9 AND input_unit = 'kWh'
          RETURNING submission_revision
        `, [...key, input.factorId, input.factorVersion, input.accountingBasis, input.regionCode, input.dataYear,
          scope.actorId, scope.requestId, input.methodReference, input.rationale]);
        if (!rows.length) throw new CarbonError(404, 'FACTOR_REFERENCE_NOT_FOUND', '未找到与所选口径和期间匹配的因子版本。');
        return readStoredFactorDecision(tx, key);
      });
    },

    listScenarioReferences(scope, orgId, scenarioReleaseId) {
      return inWorkspace(scope, async tx => {
        await requireRole(tx, scope, orgId, 'customer');
        const {rows: [release]} = await tx.query(`
          SELECT manifest->'references' AS references FROM carbon.scenario_release
          WHERE tenant_id = $1 AND id = $2 AND (org_id IS NULL OR org_id = $3)
        `, [scope.tenantId, scenarioReleaseId, orgId]);
        if (!release) throw new CarbonError(404, 'SCENARIO_NOT_FOUND', '未找到可访问的场景版本。');
        return {scenarioReleaseId, ruleStatus: 'needs_review', items: scenarioReferenceItems(release.references)};
      });
    },

    readRuleAssessment(scope, orgId, caseId, revision, customerOnly) {
      return inWorkspace(scope, async tx => {
        const task = await readVisibleCase(tx, scope, orgId, caseId, customerOnly);
        return readRuleAssessment(tx, scope, task, revision);
      });
    },

    recordRuleAssessment(scope, orgId, caseId, revision, {status, referenceCode, rationale}) {
      return inWorkspace(scope, async tx => {
        const task = await readVisibleCase(tx, scope, orgId, caseId, false);
        if (task.createdBy === scope.actorId) {
          throw new CarbonError(403, 'SELF_REVIEW_FORBIDDEN', '发起人不能确认自己的任务规则。');
        }
        if (task.status !== 'submitted' || task.revision !== revision) {
          throw new CarbonError(409, 'RULE_ASSESSMENT_CONFLICT', '仅当前待复核提交可记录一次规则判断。');
        }
        if (status === 'confirmed') {
          const current = await readRuleAssessment(tx, scope, task, revision);
          if (!task.scope || !current.candidates.some(item => item.code === referenceCode
            && (item.publicationStatus === 'effective' || item.publicationStatus === 'pilot'))) {
            throw new CarbonError(409, 'RULE_REFERENCE_UNAVAILABLE', '请先核对申报范围及可确认的候选依据。');
          }
        }
        await tx.query(`
          INSERT INTO carbon.case_rule_decision
            (tenant_id, org_id, case_id, submission_revision, status, reference_code, rationale, decided_by, request_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `, [scope.tenantId, orgId, caseId, revision, status, referenceCode, rationale, scope.actorId, scope.requestId]);
        return readRuleAssessment(tx, scope, task, revision);
      });
    },

    recordProductElectricity(scope, orgId, caseId, revision, input) {
      return inWorkspace(scope, async tx => {
        const task = await readProductTask(tx, scope, orgId, caseId, false, true);
        if (task.createdBy === scope.actorId) {
          throw new CarbonError(403, 'SELF_REVIEW_FORBIDDEN', '发起人不能确认自己的试算口径。');
        }
        if (task.status !== 'submitted' || task.revision !== revision) {
          throw new CarbonError(409, 'PRODUCT_PROFILE_CONFLICT', '仅当前待复核提交可记录试算口径。');
        }
        if (input.from.slice(0, 4) !== task.scope.reportingYear || input.to.slice(0, 4) !== task.scope.reportingYear) {
          throw new CarbonError(409, 'PRODUCT_PERIOD_MISMATCH', '用电和产出须采用同一期间，且位于任务的申报年度。');
        }
        const {rows: [profile]} = await tx.query(`
          INSERT INTO carbon.product_electricity_profile
            (tenant_id, org_id, case_id, submission_revision, from_period, to_period, boundary_note,
             functional_unit, output_quantity, allocation_method, product_mass_kg, batch_mass_kg,
             allocation_basis, created_by, request_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
          RETURNING ${productProfileFields}
        `, [scope.tenantId, orgId, caseId, revision, `${input.from}-01`, `${input.to}-01`, input.boundaryNote,
          input.functionalUnit, input.outputQuantity, input.allocationMethod, input.productMassKg, input.batchMassKg,
          input.allocationBasis, scope.actorId, scope.requestId]);
        return {profile};
      });
    },

    readProductElectricity(scope, orgId, caseId, revision, customerOnly) {
      return inWorkspace(scope, async tx => {
        await readProductTask(tx, scope, orgId, caseId, customerOnly);
        const key = [scope.tenantId, orgId, caseId, revision];
        return calculateProductElectricity(tx, key);
      });
    },

    compareProductElectricity(scope, orgId, caseId, baselineRevision, targetRevision, customerOnly) {
      return inWorkspace(scope, async tx => {
        await readProductTask(tx, scope, orgId, caseId, customerOnly);
        const key = [scope.tenantId, orgId, caseId];
        const baseline = await calculateProductElectricity(tx, [...key, baselineRevision]);
        const target = await calculateProductElectricity(tx, [...key, targetRevision]);
        const incomplete = [baseline, target].filter(item => item.status !== 'calculated');
        if (incomplete.length) {
          const reasons = {missing_profile: '缺少用电口径', missing_product_factor: '缺少适用的产品电力因子',
            missing_months: '月份数据或因子不齐'};
          const details = incomplete.map(item => `第 ${item.submissionRevision} 版${reasons[item.status]}`).join('，');
          throw new CarbonError(409, 'PRODUCT_COMPARISON_INCOMPLETE', `${details}，暂不能比较。`);
        }
        const {from, to, functionalUnit, boundaryNote} = baseline.profile;
        const labels = {from: '期间', to: '期间', functionalUnit: '功能单位', boundaryNote: '用电边界'};
        const differences = [...new Set(Object.entries(labels)
          .filter(([field]) => baseline.profile[field] !== target.profile[field]).map(([, label]) => label))];
        if (baseline.model.id !== target.model.id || baseline.model.version !== target.model.version) differences.push('模型版本');
        if (differences.length) {
          throw new CarbonError(409, 'PRODUCT_COMPARISON_INCOMPATIBLE', `${differences.join('、')}不一致，不能比较。`);
        }
        const {rows: [delta]} = await tx.query(`
          SELECT trim_scale($2::numeric - $1::numeric)::text AS "kgCO2ePerFunctionalUnit",
            trim_scale($4::numeric - $3::numeric)::text AS "allocatedKgCO2e",
            trim_scale($6::numeric - $5::numeric)::text AS "electricityKgCO2e"
        `, [baseline.result.kgCO2ePerFunctionalUnit, target.result.kgCO2ePerFunctionalUnit,
          baseline.result.allocatedKgCO2e, target.result.allocatedKgCO2e,
          baseline.result.electricityKgCO2e, target.result.electricityKgCO2e]);
        const profileFields = ['outputQuantity', 'allocationMethod', 'productMassKg', 'batchMassKg', 'allocationBasis']
          .filter(field => baseline.profile[field] !== target.profile[field]);
        const factorChanged = baseline.factor.factorId !== target.factor.factorId || baseline.factor.version !== target.factor.version;
        const months = baseline.items.flatMap((item, index) => {
          const targetKwh = target.items[index].quantity;
          return item.quantity === targetKwh ? [] : [{period: item.period, baselineKwh: item.quantity, targetKwh}];
        });
        return {baselineRevision, targetRevision, from, to, functionalUnit, boundaryNote, delta,
          baseline: {profile: baseline.profile, factor: baseline.factor, result: baseline.result},
          target: {profile: target.profile, factor: target.factor, result: target.result},
          changes: {profileFields, factorChanged, months}, formalReportEligible: false, externalDeliveryEligible: false};
      });
    },

    listModelTemplates(scope, orgId) {
      return inWorkspace(scope, async tx => {
        await requireRole(tx, scope, orgId, 'reviewer');
        const {rows: items} = await tx.query(`
          SELECT t.template_id AS "templateId", t.version, t.title,
            coalesce((SELECT jsonb_agg(jsonb_build_object('templateId', d.dependency_id, 'version', d.dependency_version)
              ORDER BY d.dependency_id, d.dependency_version)
              FROM catalog.model_template_dependency d
              WHERE (d.template_id,d.version) = (t.template_id,t.version)), '[]'::jsonb) AS dependencies
          FROM catalog.model_template_version t WHERE t.sealed ORDER BY t.template_id, t.version DESC
        `);
        return {items};
      });
    },

    previewModelTemplateImpact(scope, orgId, templateId, version) {
      return inWorkspace(scope, async tx => {
        await requireRole(tx, scope, orgId, 'reviewer');
        const {rows: [found]} = await tx.query(`
          SELECT 1 FROM catalog.model_template_version WHERE (template_id,version) = ($1,$2) AND sealed
        `, [templateId, version]);
        if (!found) throw new CarbonError(404, 'MODEL_TEMPLATE_NOT_FOUND', '未找到这个模型模板版本。');
        const {rows} = await tx.query(`
          WITH RECURSIVE affected(template_id, version) AS (
            SELECT $1::text, $2::integer
            UNION
            SELECT d.template_id, d.version FROM catalog.model_template_dependency d
            JOIN affected a ON (d.dependency_id,d.dependency_version) = (a.template_id,a.version)
            JOIN catalog.model_template_version t ON (t.template_id,t.version) = (d.template_id,d.version) AND t.sealed
          )
          SELECT p.case_id AS "caseId", task.purpose, p.submission_revision AS "submissionRevision",
            p.model_template_id AS "modelTemplateId", p.model_template_version AS "modelTemplateVersion",
            count(*) OVER ()::integer AS total
          FROM carbon.product_electricity_profile p
          JOIN affected a ON (a.template_id,a.version) = (p.model_template_id,p.model_template_version)
          JOIN carbon.case_intake task ON (task.tenant_id,task.org_id,task.id) = (p.tenant_id,p.org_id,p.case_id)
          WHERE (p.tenant_id,p.org_id) = ($3,$4)
          ORDER BY p.created_at DESC, p.case_id, p.submission_revision DESC LIMIT 50
        `, [templateId, version, scope.tenantId, orgId]);
        return {templateId, version, total: rows[0]?.total ?? 0, items: rows.map(({total, ...item}) => item)};
      });
    },

    previewGasCombustion(scope, orgId, caseId, revision, from, to, customerOnly) {
      return inWorkspace(scope, async tx => {
        const {task, key} = await readGasCombustionTask(tx, scope, orgId, caseId, revision, customerOnly);
        return calculateGasCombustion(tx, key, from, to, task.scope.subjectName);
      });
    },

    recordGasCombustion(scope, orgId, caseId, revision, input) {
      return inWorkspace(scope, async tx => {
        const {task, key} = await readGasCombustionTask(tx, scope, orgId, caseId, revision, false);
        if (task.createdBy === scope.actorId) {
          throw new CarbonError(403, 'SELF_REVIEW_FORBIDDEN', '发起人不能确认自己的燃烧数据。');
        }
        const {period, standardVolumeNm3, methodBranch, ncvGjPer10kNm3, carbonTcPerGj,
          elementalCarbonTcPer10kNm3, oxidationFraction,
          activityEvidenceId, parameterEvidenceId, parameterBasis} = input;
        await tx.query(`
          INSERT INTO carbon.gas_combustion_input
            (tenant_id, org_id, case_id, submission_revision, period, standard_volume_nm3, method_branch,
              ncv_gj_per_10k_nm3, carbon_tc_per_gj, elemental_carbon_tc_per_10k_nm3, oxidation_fraction, activity_evidence_id,
              parameter_evidence_id, parameter_basis, recorded_by, request_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        `, [...key, `${period}-01`, standardVolumeNm3, methodBranch, ncvGjPer10kNm3, carbonTcPerGj,
          elementalCarbonTcPer10kNm3, oxidationFraction,
          activityEvidenceId, parameterEvidenceId, parameterBasis, scope.actorId, scope.requestId]);
        return calculateGasCombustion(tx, key, period, period, task.scope.subjectName);
      });
    },

    saveGasCombustionSnapshot(scope, orgId, caseId, revision, from, to) {
      return inWorkspace(scope, async tx => {
        const {task, key} = await readGasCombustionTask(tx, scope, orgId, caseId, revision, true);
        if (!isCurrentSubmission(task, revision)) {
          throw new CarbonError(409, 'GAS_COMBUSTION_CONFLICT', '请选择当前有效提交冻结结果。');
        }
        const result = await calculateGasCombustion(tx, key, from, to, task.scope.subjectName);
        if (result.coverage.status !== 'complete') {
          throw new CarbonError(409, 'CALCULATION_INCOMPLETE', '所选月份仍缺少燃烧输入。');
        }
        const snapshotKey = [...key, result.model.id, result.model.version, `${from}-01`, `${to}-01`];
        const {rows: [created]} = await tx.query(`
          INSERT INTO carbon.model_trial_snapshot
            (tenant_id, org_id, case_id, submission_revision, model_id, model_version, from_period, to_period,
              id, created_by, request_id, payload)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          ON CONFLICT (tenant_id, org_id, case_id, submission_revision, model_id, model_version, from_period, to_period)
          DO NOTHING RETURNING ${trialSnapshotFields}
        `, [...snapshotKey, randomUUID(), scope.actorId, scope.requestId, JSON.stringify(result)]);
        if (created) return {status: 201, body: {...created, createdAt: new Date(created.createdAt).toISOString()}};
        const {rows: [existing]} = await tx.query(`
          SELECT ${trialSnapshotFields} FROM carbon.model_trial_snapshot
          WHERE (tenant_id, org_id, case_id, submission_revision, model_id, model_version, from_period, to_period)
              = ($1, $2, $3, $4, $5, $6, $7, $8)
        `, snapshotKey);
        return {status: 200, body: {...existing, createdAt: new Date(existing.createdAt).toISOString()}};
      });
    },

    listGasCombustionSnapshots(scope, orgId, caseId, revision, customerOnly) {
      return inWorkspace(scope, async tx => {
        const {key} = await readGasCombustionTask(tx, scope, orgId, caseId, revision, customerOnly);
        const {rows} = await tx.query(`
          SELECT id AS "snapshotId", created_at AS "createdAt", payload->>'from' AS "from",
            payload->>'to' AS "to", payload->>'totalKgCO2' AS "totalKgCO2"
          FROM carbon.model_trial_snapshot
          WHERE (tenant_id, org_id, case_id, submission_revision) = ($1, $2, $3, $4)
          ORDER BY created_at DESC, id DESC
        `, key);
        return {items: rows.map(item => ({...item, createdAt: new Date(item.createdAt).toISOString()}))};
      });
    },

    readGasCombustionSnapshot(scope, orgId, caseId, revision, snapshotId, customerOnly) {
      return inWorkspace(scope, async tx => {
        const {key} = await readGasCombustionTask(tx, scope, orgId, caseId, revision, customerOnly);
        return readTrialSnapshot(tx, key, snapshotId);
      });
    },

    createGasCombustionReportDraft(scope, orgId, caseId, revision, snapshotId) {
      return inWorkspace(scope, async tx => {
        const {task, key} = await readGasCombustionTask(tx, scope, orgId, caseId, revision, true, true);
        if (!isCurrentSubmission(task, revision)) {
          throw new CarbonError(409, 'REPORT_DRAFT_REVISION_CONFLICT', '请选择当前有效的试算快照。');
        }
        const snapshot = await readTrialSnapshot(tx, key, snapshotId);
        const {from, to, coverage, model, totalKgCO2, totalTCO2, items} = snapshot.result;
        const {rows: [restatement]} = await tx.query(`
          SELECT r.id, r.reason, r.reviewed_at AS "reviewedAt", baseline.submission_revision AS "baselineRevision",
            trim_scale($5::numeric - (baseline.payload->>'totalKgCO2')::numeric)::text AS "deltaKgCO2"
          FROM carbon.gas_report_restatement r
          JOIN carbon.model_trial_snapshot baseline ON
            (baseline.tenant_id,baseline.org_id,baseline.case_id,baseline.id) =
            (r.tenant_id,r.org_id,r.case_id,r.baseline_snapshot_id)
          WHERE (r.tenant_id,r.org_id,r.case_id,r.target_snapshot_id) = ($1,$2,$3,$4) AND r.status = 'approved'
        `, [...key.slice(0, 3), snapshotId, totalKgCO2]);
        return saveDraft(tx, scope, key.slice(0, 3), {
          caseId, snapshotId, status: 'draft', mode: 'internal_trial', formalReportEligible: false, externalDeliveryEligible: false,
          template: {id: 'internal-management-gas-combustion', version: 1, locale: 'zh-CN'},
          report: {
            title: '天然气固定燃烧内部试算报告', watermark: '内部试算｜禁止外发',
            scope: {caseId, from, to, purpose: task.purpose, submissionRevision: revision,
              snapshotCreatedAt: snapshot.createdAt, declaredScope: task.scope},
            summary: {coverage, outputUnit: 'kgCO2', totalKg: totalKgCO2, totalT: totalTCO2, knownSubtotalKg: totalKgCO2},
            ...(restatement && {restatement}),
            model, items: items.map(item => ({...item, source: 'natural_gas', quantity: item.standardVolumeNm3,
              unit: 'Nm³', emissionsKg: item.emissionsKgCO2})),
            limitations: [
              '仅覆盖所列设施、月份和天然气固定燃烧的二氧化碳排放。',
              '活动量和参数由独立专业人员按本提交的固定凭证记录。',
              '仅供内部试算及复核，禁止外发。'
            ]
          }
        });
      });
    },

    compareGasCombustionSnapshots(scope, orgId, caseId, baselineId, targetId, customerOnly) {
      return inWorkspace(scope, async tx => {
        await readVisibleCase(tx, scope, orgId, caseId, customerOnly);
        const {rows} = await tx.query(`
          SELECT id, payload FROM carbon.model_trial_snapshot
          WHERE (tenant_id, org_id, case_id) = ($1, $2, $3) AND id = ANY($4::uuid[])
        `, [scope.tenantId, orgId, caseId, [baselineId, targetId]]);
        const snapshots = new Map(rows.map(({id, payload}) => [id, payload]));
        const baseline = snapshots.get(baselineId);
        const target = snapshots.get(targetId);
        if (!baseline || !target) throw new CarbonError(404, 'CALCULATION_SNAPSHOT_NOT_FOUND', '未找到可访问的试算快照。');
        if (baseline.from !== target.from || baseline.to !== target.to || baseline.facility !== target.facility
          || baseline.model.id !== target.model.id || baseline.model.version !== target.model.version
          || baseline.items.length !== target.items.length
          || baseline.items.some((item, index) => item.period !== target.items[index].period)) {
          throw new CarbonError(409, 'CALCULATION_COMPARISON_INCOMPATIBLE', '只可比较同一设施、期间和模型的快照。');
        }
        const difference = await compareGasCombustion(tx, baseline, target);
        return {baselineId, targetId, facility: baseline.facility, from: baseline.from, to: baseline.to,
          model: baseline.model, baselineKgCO2: baseline.totalKgCO2, targetKgCO2: target.totalKgCO2,
          ...difference, mode: 'internal_trial', formalReportEligible: false, externalDeliveryEligible: false};
      });
    },

    listGasRestatements(scope, orgId, caseId, customerOnly) {
      return inWorkspace(scope, async tx => {
        const task = await readVisibleCase(tx, scope, orgId, caseId, customerOnly);
        const key = [scope.tenantId, orgId, caseId];
        const revision = task.status === 'submitted' ? task.revision
          : task.status === 'approved' ? task.revision - 1 : null;
        const {rows} = await tx.query(`
          SELECT r.id, r.status, r.reason, r.review_reason AS "reviewReason",
            r.created_at AS "createdAt", r.reviewed_at AS "reviewedAt",
            r.created_by AS "createdBy", r.reviewed_by AS "reviewedBy",
            r.baseline_snapshot_id AS "baselineSnapshotId", r.target_snapshot_id AS "targetSnapshotId",
            baseline.submission_revision AS "baselineRevision", target.submission_revision AS "targetRevision",
            to_char(target.from_period, 'YYYY-MM') AS "from", to_char(target.to_period, 'YYYY-MM') AS "to",
            trim_scale((target.payload->>'totalKgCO2')::numeric - (baseline.payload->>'totalKgCO2')::numeric)::text AS "deltaKgCO2",
            ARRAY(SELECT d.id FROM carbon.internal_report_draft d
              WHERE (d.tenant_id,d.org_id,d.case_id,d.trial_snapshot_id) =
                (r.tenant_id,r.org_id,r.case_id,r.baseline_snapshot_id) ORDER BY d.created_at) AS "baselineDraftIds",
            ARRAY(SELECT d.id FROM carbon.internal_report_draft d
              WHERE (d.tenant_id,d.org_id,d.case_id,d.trial_snapshot_id) =
                (r.tenant_id,r.org_id,r.case_id,r.target_snapshot_id) ORDER BY d.created_at) AS "targetDraftIds"
          FROM carbon.gas_report_restatement r
          JOIN carbon.model_trial_snapshot baseline ON
            (baseline.tenant_id,baseline.org_id,baseline.case_id,baseline.id) =
            (r.tenant_id,r.org_id,r.case_id,r.baseline_snapshot_id)
          JOIN carbon.model_trial_snapshot target ON
            (target.tenant_id,target.org_id,target.case_id,target.id) =
            (r.tenant_id,r.org_id,r.case_id,r.target_snapshot_id)
          WHERE (r.tenant_id,r.org_id,r.case_id) = ($1,$2,$3)
          ORDER BY r.created_at DESC, r.id DESC
        `, key);
        const items = rows.map(item => ({...item, createdAt: new Date(item.createdAt).toISOString(),
          reviewedAt: item.reviewedAt ? new Date(item.reviewedAt).toISOString() : null,
          canReview: !customerOnly && item.status === 'pending' && item.targetRevision === revision
            && item.createdBy !== scope.actorId && task.createdBy !== scope.actorId}));
        if (!customerOnly || revision === null) return {items, candidates: []};

        const {rows: candidates} = await tx.query(`
          SELECT baseline.id AS "baselineSnapshotId", target.id AS "targetSnapshotId",
            baseline.submission_revision AS "baselineRevision", target.submission_revision AS "targetRevision",
            to_char(target.from_period, 'YYYY-MM') AS "from", to_char(target.to_period, 'YYYY-MM') AS "to"
          FROM carbon.model_trial_snapshot target
          JOIN carbon.model_trial_snapshot baseline
            ON (baseline.tenant_id,baseline.org_id,baseline.case_id) = (target.tenant_id,target.org_id,target.case_id)
            AND baseline.id = carbon.latest_prior_gas_report_snapshot(target.tenant_id,target.org_id,target.case_id,target.id)
          WHERE (target.tenant_id,target.org_id,target.case_id,target.submission_revision) = ($1,$2,$3,$4)
            AND NOT EXISTS (SELECT 1 FROM carbon.internal_report_draft d
              WHERE (d.tenant_id,d.org_id,d.case_id,d.trial_snapshot_id) =
                (target.tenant_id,target.org_id,target.case_id,target.id))
            AND NOT EXISTS (SELECT 1 FROM carbon.gas_report_restatement r
              WHERE (r.tenant_id,r.org_id,r.case_id,r.target_snapshot_id) =
                (target.tenant_id,target.org_id,target.case_id,target.id) AND r.status IN ('pending','approved'))
          ORDER BY target.from_period, target.to_period
        `, [...key, revision]);
        return {items, candidates};
      });
    },

    requestGasRestatement(scope, orgId, caseId, baselineId, targetId, reason) {
      return inWorkspace(scope, async tx => {
        await readVisibleCase(tx, scope, orgId, caseId, true, true);
        const key = [scope.tenantId, orgId, caseId];
        const {rows: available} = await tx.query(`
          SELECT id FROM carbon.model_trial_snapshot
          WHERE (tenant_id,org_id,case_id) = ($1,$2,$3) AND id = ANY($4::uuid[])
        `, [...key, [baselineId, targetId]]);
        if ([baselineId, targetId].some(id => !available.some(item => item.id === id))) {
          throw new CarbonError(404, 'CALCULATION_SNAPSHOT_NOT_FOUND', '未找到可访问的试算快照。');
        }
        const {rows: [request]} = await tx.query(`
          INSERT INTO carbon.gas_report_restatement
            (tenant_id,org_id,case_id,id,baseline_snapshot_id,target_snapshot_id,reason,created_by,request_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, status
        `, [...key, randomUUID(), baselineId, targetId, reason, scope.actorId, scope.requestId]);
        return request;
      });
    },

    reviewGasRestatement(scope, orgId, caseId, id, decision, reason) {
      return inWorkspace(scope, async tx => {
        const task = await readVisibleCase(tx, scope, orgId, caseId, false, true);
        if (task.createdBy === scope.actorId) {
          throw new CarbonError(403, 'SELF_REVIEW_FORBIDDEN', '发起人不能审批自己的重述。');
        }
        const key = [scope.tenantId, orgId, caseId, id];
        const {rows: [review]} = await tx.query(`
          UPDATE carbon.gas_report_restatement
          SET status = $5, reviewed_by = $6, review_reason = $7, review_request_id = $8
          WHERE (tenant_id,org_id,case_id,id) = ($1,$2,$3,$4) AND status = 'pending'
          RETURNING id, status
        `, [...key, decision, scope.actorId, reason, scope.requestId]);
        if (review) return review;
        const {rows: [existing]} = await tx.query(`
          SELECT id FROM carbon.gas_report_restatement WHERE (tenant_id,org_id,case_id,id) = ($1,$2,$3,$4)
        `, key);
        if (!existing) throw new CarbonError(404, 'GAS_RESTATEMENT_NOT_FOUND', '未找到可访问的重述申请。');
        throw new CarbonError(409, 'GAS_RESTATEMENT_CONFLICT', '重述申请已经处理，请刷新后查看。');
      });
    },

    enqueueGasCalculationJob(scope, orgId, caseId, revision, from, to) {
      return inWorkspace(scope, async tx => {
        const {task, key} = await readGasCombustionTask(tx, scope, orgId, caseId, revision, true, true);
        if (!isCurrentSubmission(task, revision)) {
          throw new CarbonError(409, 'GAS_CALCULATION_JOB_STALE', '请选择当前有效的提交版本发起计算。');
        }
        const inputKey = [...key, `${from}-01`, `${to}-01`];
        const {rows: [created]} = await tx.query(`
          INSERT INTO carbon.gas_calculation_job
            (tenant_id, org_id, case_id, submission_revision, from_period, to_period, id, created_by, request_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (tenant_id, org_id, case_id, submission_revision, from_period, to_period) DO NOTHING
          RETURNING ${gasJobFields}
        `, [...inputKey, randomUUID(), scope.actorId, scope.requestId]);
        if (created) return {status: 202, body: gasJobResponse(created, task)};
        const {rows: [existing]} = await tx.query(`
          SELECT ${gasJobFields} FROM carbon.gas_calculation_job
          WHERE (tenant_id, org_id, case_id, submission_revision, from_period, to_period) = ($1, $2, $3, $4, $5, $6)
        `, inputKey);
        return {status: 200, body: gasJobResponse(existing, task)};
      });
    },

    readGasCalculationJobs(scope, orgId, caseId, jobId) {
      return inWorkspace(scope, async tx => {
        const task = await readVisibleCase(tx, scope, orgId, caseId, true);
        const {rows} = await tx.query(`
          SELECT ${gasJobFields} FROM carbon.gas_calculation_job
          WHERE (tenant_id, org_id, case_id) = ($1, $2, $3) AND ($4::uuid IS NULL OR id = $4)
          ORDER BY created_at DESC, id DESC LIMIT 100
        `, [scope.tenantId, orgId, caseId, jobId]);
        if (jobId) {
          if (!rows.length) throw new CarbonError(404, 'GAS_CALCULATION_JOB_NOT_FOUND', '未找到可访问的计算作业。');
          return gasJobResponse(rows[0], task);
        }
        return {items: rows.map(job => gasJobResponse(job, task))};
      });
    },

    changeGasCalculationJob(scope, orgId, caseId, jobId, action) {
      return inWorkspace(scope, async tx => {
        const task = await readVisibleCase(tx, scope, orgId, caseId, true, true);
        const key = [scope.tenantId, orgId, caseId, jobId];
        const {rows: [existing]} = await tx.query(`
          SELECT ${gasJobFields} FROM carbon.gas_calculation_job
          WHERE (tenant_id, org_id, case_id, id) = ($1, $2, $3, $4)
        `, key);
        if (!existing) throw new CarbonError(404, 'GAS_CALCULATION_JOB_NOT_FOUND', '未找到可访问的计算作业。');
        const retry = action === 'retry';
        if (retry && !isCurrentSubmission(task, existing.submissionRevision)) {
          throw new CarbonError(409, 'GAS_CALCULATION_JOB_STALE', '该提交已过时，请用当前版本发起计算。');
        }
        const {rows: [job]} = await tx.query(`
          UPDATE carbon.gas_calculation_job SET status = $5, error_code = NULL
          WHERE (tenant_id, org_id, case_id, id) = ($1, $2, $3, $4) AND status = ANY($6::text[])
          RETURNING ${gasJobFields}
        `, [...key, retry ? 'queued' : 'cancelled', retry ? ['failed', 'cancelled'] : ['queued']]);
        if (!job) throw new CarbonError(409, 'GAS_CALCULATION_JOB_CONFLICT', '作业状态已变化，请刷新后重试。');
        return gasJobResponse(job, task);
      });
    },

    previewRuleImpact(scope, orgId, scenarioReleaseId, references) {
      return inWorkspace(scope, async tx => {
        await requireRole(tx, scope, orgId, 'admin');
        const {rows: [release]} = await tx.query(`
          SELECT version, manifest->'references' AS references FROM carbon.scenario_release
          WHERE tenant_id = $1 AND id = $2 AND (org_id IS NULL OR org_id = $3)
        `, [scope.tenantId, scenarioReleaseId, orgId]);
        if (!release) throw new CarbonError(404, 'SCENARIO_NOT_FOUND', '未找到可访问的场景版本。');
        const changes = compareRuleReferences(release.references, references);
        const {rows: taskCounts} = changes.length ? await tx.query(`
          SELECT status, count(*)::integer AS count FROM carbon.case_intake
          WHERE tenant_id = $1 AND org_id = $2 AND scenario_release_id = $3
          GROUP BY status ORDER BY status
        `, [scope.tenantId, orgId, scenarioReleaseId]) : {rows: []};
        const {rows: [dependencies]} = changes.length ? await tx.query(`
          SELECT factor_count AS "factorCount", model_count AS "modelCount", report_count AS "reportCount"
          FROM carbon.rule_impact_dependencies($1, $2)
        `, [orgId, scenarioReleaseId]) : {rows: [{factorCount: 0, modelCount: 0, reportCount: 0}]};
        return {scenarioReleaseId, scenarioVersion: release.version, changes, taskCounts, dependencies};
      });
    },

    listRuleCatalog(scope, orgId) {
      return inWorkspace(scope, async tx => {
        await requireRole(tx, scope, orgId, 'admin');
        const {rows} = await tx.query(`
          SELECT DISTINCT ON (code) id AS "scenarioReleaseId", version AS "scenarioVersion", code,
            manifest->'catalog'->>'title' AS title, manifest->'references' AS references
          FROM carbon.scenario_release WHERE tenant_id = $1 AND (org_id IS NULL OR org_id = $2)
          ORDER BY code, version DESC, (org_id IS NOT NULL) DESC
        `, [scope.tenantId, orgId]);
        return {items: rows.map(({references, title, ...release}) => ({
          ...release, title: title ?? release.code, references: scenarioReferenceItems(references, true)
        }))};
      });
    },

    listRuleProposals(scope, orgId, reviewer) {
      return inWorkspace(scope, async tx => {
        await requireRole(tx, scope, orgId, reviewer ? 'reviewer' : 'admin');
        return {items: await readRuleProposals(tx, scope, orgId, reviewer)};
      });
    },

    submitRuleProposal(scope, orgId, scenarioReleaseId, references) {
      return inWorkspace(scope, async tx => {
        await requireRole(tx, scope, orgId, 'admin');
        const {rows: [release]} = await tx.query(`
          SELECT base.manifest->'references' AS references,
            base.id = (SELECT newer.id FROM carbon.scenario_release AS newer
              WHERE newer.tenant_id = base.tenant_id AND newer.code = base.code
                AND (newer.org_id IS NULL OR newer.org_id = $3)
              ORDER BY newer.version DESC, (newer.org_id IS NOT NULL) DESC LIMIT 1) AS latest
          FROM carbon.scenario_release AS base
          WHERE base.tenant_id = $1 AND base.id = $2 AND (base.org_id IS NULL OR base.org_id = $3)
        `, [scope.tenantId, scenarioReleaseId, orgId]);
        if (!release) throw new CarbonError(404, 'SCENARIO_NOT_FOUND', '未找到可访问的场景版本。');
        if (!release.latest || !compareRuleReferences(release.references, references).length) {
          throw new CarbonError(409, 'RULE_PROPOSAL_CONFLICT', '请选择当前场景版本并至少修改一项候选依据。');
        }
        const proposalId = randomUUID();
        await tx.query(`
          INSERT INTO carbon.scenario_rule_proposal
            (tenant_id, org_id, id, base_release_id, references_payload, created_by, request_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [scope.tenantId, orgId, proposalId, scenarioReleaseId, JSON.stringify(references), scope.actorId, scope.requestId]);
        const [proposal] = await readRuleProposals(tx, scope, orgId, false, proposalId);
        return proposal;
      });
    },

    reviewRuleProposal(scope, orgId, proposalId, decision, reason) {
      return inWorkspace(scope, async tx => {
        await requireRole(tx, scope, orgId, 'reviewer');
        const key = [scope.tenantId, orgId, proposalId];
        const {rows: [stored]} = await tx.query(`
          SELECT created_by AS "createdBy" FROM carbon.scenario_rule_proposal
          WHERE (tenant_id, org_id, id) = ($1, $2, $3)
        `, key);
        if (!stored) throw new CarbonError(404, 'RULE_PROPOSAL_NOT_FOUND', '未找到可访问的规则草案。');
        if (stored.createdBy === scope.actorId) {
          throw new CarbonError(403, 'SELF_REVIEW_FORBIDDEN', '提交人不能审批自己的规则草案。');
        }
        const {rows} = await tx.query(`
          UPDATE carbon.scenario_rule_proposal
          SET status = $4, review_note = $5, reviewed_by = $6, review_request_id = $7
          WHERE (tenant_id, org_id, id) = ($1, $2, $3) AND status = 'submitted'
          RETURNING id
        `, [...key, decision, reason, scope.actorId, scope.requestId]);
        if (!rows.length) throw new CarbonError(409, 'RULE_PROPOSAL_CONFLICT', '该规则草案已有审批结论。');
        const [proposal] = await readRuleProposals(tx, scope, orgId, true, proposalId);
        return proposal;
      });
    },

    createRuleRecalculation(scope, orgId, caseId, scenarioReleaseId) {
      return inWorkspace(scope, async tx => {
        const task = await readVisibleCase(tx, scope, orgId, caseId, true, true);
        const {rows: [latest]} = await tx.query(`
          SELECT newer.id FROM carbon.scenario_release AS original
          JOIN carbon.scenario_release AS newer
            ON newer.tenant_id = original.tenant_id AND newer.code = original.code AND newer.version > original.version
          WHERE original.tenant_id = $1 AND original.id = $2 AND (newer.org_id IS NULL OR newer.org_id = $3)
          ORDER BY newer.version DESC, (newer.org_id IS NOT NULL) DESC LIMIT 1
        `, [scope.tenantId, task.scenarioReleaseId, orgId]);
        if (!['submitted', 'approved'].includes(task.status) || latest?.id !== scenarioReleaseId) {
          throw new CarbonError(409, 'RULE_RECALCULATION_CONFLICT', '原任务或新版场景已变化，请刷新后重试。');
        }
        const key = [scope.tenantId, orgId, caseId, scenarioReleaseId];
        const {rows: [existing]} = await tx.query(`
          SELECT ${caseDetailFields} FROM carbon.case_intake
          WHERE (tenant_id, org_id, rule_recalculation_of, scenario_release_id) = ($1, $2, $3, $4)
            AND created_by = $5
          ORDER BY id LIMIT 1
        `, [...key, scope.actorId]);
        if (existing) return {status: 200, body: {...caseDetail(existing), ruleRecalculationOf: caseId}};
        const {rows: [created]} = await tx.query(`
          INSERT INTO carbon.case_intake
            (tenant_id, org_id, rule_recalculation_of, scenario_release_id, created_by, id, purpose, intake_scope)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          RETURNING ${caseDetailFields}
        `, [...key, scope.actorId, randomUUID(), task.purpose, task.scope ?? null]);
        return {status: 201, body: {...caseDetail(created), ruleRecalculationOf: caseId}};
      });
    },

    listScenarios(scope, orgId) {
      return inWorkspace(scope, async tx => {
        await requireRole(tx, scope, orgId, 'customer');
        const {rows} = await tx.query(`
          SELECT DISTINCT ON (code) id, code, version, manifest->'catalog' AS catalog
          FROM carbon.scenario_release
          WHERE tenant_id = $1 AND (org_id IS NULL OR org_id = $2)
          ORDER BY code, version DESC, (org_id IS NOT NULL) DESC
        `, [scope.tenantId, orgId]);
        const items = [];
        for (const {id, code, version, catalog} of rows) {
          if (!catalogFields.every(field => typeof catalog?.[field] === 'string' && catalog[field].trim())) continue;
          const details = Object.fromEntries(catalogFields.map(field => [field, catalog[field]]));
          const preparation = catalogPreparation(catalog);
          if (preparation) details.preparation = preparation;
          items.push({id, code, version, ...details, ruleStatus: 'needs_review'});
        }
        return {items};
      });
    },

    create(scope, input) {
      return inWorkspace(scope, async tx => {
        await requireRole(tx, scope, input.orgId, 'customer');
        const {rows: [release]} = await tx.query(`
          SELECT version, code, manifest->'catalog' AS catalog FROM carbon.scenario_release
          WHERE tenant_id = $1 AND id = $2
        `, [scope.tenantId, input.scenarioReleaseId]);
        if (!release) {
          throw new CarbonError(404, 'SCENARIO_NOT_FOUND', '未找到可访问的场景版本。');
        }
        const result = await tx.query(`
          INSERT INTO carbon.case_intake
            (tenant_id, id, org_id, scenario_release_id, created_by, purpose, intake_scope)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          RETURNING ${caseDetailFields}
        `, [scope.tenantId, randomUUID(), input.orgId, input.scenarioReleaseId, scope.actorId, input.purpose, input.intakeScope]);
        return withScenarioPreparation(caseDetail(result.rows[0]), release);
      });
    },

    read(scope, orgId, id, customerOnly) {
      return inWorkspace(scope, async tx => {
        const task = await readVisibleCase(tx, scope, orgId, id, customerOnly);
        const {rows: [release]} = await tx.query(`
          SELECT version, code, manifest->'catalog' AS catalog FROM carbon.scenario_release WHERE tenant_id = $1 AND id = $2
        `, [scope.tenantId, task.scenarioReleaseId]);
        return withScenarioPreparation(task, release);
      });
    },

    listCases(scope, orgId, customerOnly, limit, cursor) {
      return inWorkspace(scope, async tx => {
        await requireRole(tx, scope, orgId, customerOnly ? 'customer' : 'reviewer');
        const result = await tx.query(`
          SELECT * FROM (
            SELECT ${caseFields},
              CASE WHEN $3::boolean OR (status = 'submitted' AND created_by <> $4) THEN 0 ELSE 1 END AS priority
            FROM carbon.case_intake
            WHERE tenant_id = $1 AND org_id = $2
              AND (($3::boolean AND created_by = $4) OR (NOT $3::boolean AND status <> 'draft'))
          ) AS visible_cases
          WHERE $6::uuid IS NULL OR (priority, id) > ($5::integer, $6::uuid)
          ORDER BY priority, id LIMIT $7
        `, [scope.tenantId, orgId, customerOnly, scope.actorId, cursor?.priority ?? null, cursor?.id ?? null, limit + 1]);
        const page = result.rows.slice(0, limit);
        const last = page.at(-1);
        return {
          cases: page.map(({priority, ...item}) => ({...item, nextAction: nextAction(item, scope, customerOnly)})),
          nextCursor: result.rows.length > limit ? `${last.priority}:${last.id}` : null
        };
      });
    },

    history(scope, orgId, id, customerOnly) {
      return inWorkspace(scope, async tx => {
        await readVisibleCase(tx, scope, orgId, id, customerOnly);
        const result = await tx.query(`
          SELECT ${eventFields} FROM carbon.audit_event
          WHERE tenant_id = $1 AND org_id = $2 AND case_id = $3
          ORDER BY revision, id
        `, [scope.tenantId, orgId, id]);
        return {events: result.rows};
      });
    },

    registerEvidence(scope, orgId, id, title, sourceDescription) {
      return inWorkspace(scope, async tx => {
        const task = await readVisibleCase(tx, scope, orgId, id, true);
        requireEditableCase(task, '任务当前不能登记材料，请刷新后查看状态。');
        const result = await tx.query(`
          INSERT INTO carbon.case_evidence AS evidence
            (tenant_id, org_id, case_id, id, registered_by, title, source_description)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          RETURNING ${evidenceFields}, 'pending_file' AS status
        `, [scope.tenantId, orgId, id, randomUUID(), scope.actorId, title, sourceDescription]);
        return result.rows[0];
      });
    },

    listEvidence(scope, orgId, id, customerOnly) {
      return inWorkspace(scope, async tx => {
        await readVisibleCase(tx, scope, orgId, id, customerOnly);
        const result = await tx.query(`
          SELECT ${evidenceFields},
            CASE
              WHEN receipt.id IS NULL THEN 'pending_file'
              WHEN scan.verdict = 'pass' THEN 'passed'
              WHEN scan.verdict = 'rejected' THEN 'rejected'
              ELSE 'pending_scan'
            END AS status
          FROM carbon.case_evidence AS evidence
          LEFT JOIN carbon.evidence_receipt AS receipt
            ON receipt.tenant_id = evidence.tenant_id AND receipt.org_id = evidence.org_id
            AND receipt.case_id = evidence.case_id AND receipt.evidence_id = evidence.id
          LEFT JOIN carbon.evidence_scan AS scan ON scan.receipt_id = receipt.id
          WHERE evidence.tenant_id = $1 AND evidence.org_id = $2 AND evidence.case_id = $3
          ORDER BY evidence.created_at, evidence.id
        `, [scope.tenantId, orgId, id]);
        return {items: result.rows};
      });
    },

    receiveEvidenceFile(scope, orgId, caseId, evidenceId, mediaType, bytes) {
      return inWorkspace(scope, async tx => {
        const task = await readVisibleCase(tx, scope, orgId, caseId, true);
        requireEditableCase(task, '任务当前不能接收文件，请刷新后查看状态。');
        const evidence = await tx.query(`
          SELECT 1 FROM carbon.case_evidence
          WHERE tenant_id = $1 AND org_id = $2 AND case_id = $3 AND id = $4
        `, [scope.tenantId, orgId, caseId, evidenceId]);
        if (evidence.rows.length === 0) {
          throw new CarbonError(404, 'EVIDENCE_NOT_FOUND', '未找到该任务的材料登记。');
        }
        if (typeof quarantine?.write !== 'function') {
          throw new CarbonError(503, 'QUARANTINE_UNAVAILABLE', '文件隔离区暂不可用。');
        }
        const id = randomUUID();
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        let result;
        try {
          result = await tx.query(`
            INSERT INTO carbon.evidence_receipt
              (tenant_id, org_id, case_id, evidence_id, id, received_by, media_type, byte_size, sha256)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING id, org_id AS "orgId", case_id AS "caseId", evidence_id AS "evidenceId",
              received_by AS "receivedBy", media_type AS "mediaType", byte_size AS "byteSize",
              sha256, created_at AS "createdAt", 'pending_scan' AS status
          `, [scope.tenantId, orgId, caseId, evidenceId, id, scope.actorId, mediaType, bytes.length, sha256]);
        } catch (error) {
          if (error?.code === '23505') {
            throw new CarbonError(409, 'FILE_ALREADY_RECEIVED', '这份材料已经接收过文件。');
          }
          throw error;
        }
        try {
          await quarantine.write(id, bytes);
        } catch {
          throw new CarbonError(503, 'QUARANTINE_UNAVAILABLE', '文件暂未接收，请稍后重试。');
        }
        return result.rows[0];
      });
    },

    listRevisionEvidence(scope, orgId, id, revision, customerOnly) {
      return inWorkspace(scope, async tx => {
        await readVisibleCase(tx, scope, orgId, id, customerOnly);
        const {rows} = await tx.query(`
          SELECT ref.evidence_id AS "evidenceId", ref.receipt_id AS "receiptId", ref.sha256,
            evidence.title, evidence.source_description AS "sourceDescription"
          FROM carbon.case_submission AS submission
          LEFT JOIN carbon.case_submission_evidence AS ref USING (tenant_id, org_id, case_id, revision)
          LEFT JOIN carbon.case_evidence AS evidence
            ON evidence.tenant_id = ref.tenant_id AND evidence.org_id = ref.org_id
            AND evidence.case_id = ref.case_id AND evidence.id = ref.evidence_id
          WHERE submission.tenant_id = $1 AND submission.org_id = $2 AND submission.case_id = $3
            AND submission.revision = $4
          ORDER BY evidence.created_at, ref.evidence_id
        `, [scope.tenantId, orgId, id, revision]);
        if (rows.length === 0) {
          throw new CarbonError(404, 'REVISION_NOT_FOUND', '未找到该任务的提交版本。');
        }
        return {items: rows.filter(item => item.evidenceId !== null)};
      });
    },

    listSubmissionActivities(scope, orgId, caseId, submissionRevision, customerOnly) {
      return inWorkspace(scope, async tx => {
        await readVisibleCase(tx, scope, orgId, caseId, customerOnly);
        const {rows} = await tx.query(`
          SELECT capture.submission_revision IS NOT NULL AS captured,
            to_char(activity.period, 'YYYY-MM') AS period, activity.source, activity.activity_revision AS revision,
            trim_scale(activity.quantity)::text AS quantity, activity.unit,
            jsonb_build_object('batchId', activity.batch_id, 'previewRevision', activity.preview_revision,
              'sourceRow', activity.source_row, 'sourceType', activity.source_type, 'conversionVersion', activity.conversion_version,
              'originalQuantity', activity.original_quantity, 'originalUnit', activity.original_unit) AS lineage
          FROM carbon.case_submission AS submission
          LEFT JOIN carbon.case_submission_activity_capture AS capture
            ON capture.tenant_id = submission.tenant_id AND capture.org_id = submission.org_id
            AND capture.case_id = submission.case_id AND capture.submission_revision = submission.revision
          LEFT JOIN carbon.case_submission_activity AS activity
            ON activity.tenant_id = capture.tenant_id AND activity.org_id = capture.org_id
            AND activity.case_id = capture.case_id AND activity.submission_revision = capture.submission_revision
          WHERE submission.tenant_id = $1 AND submission.org_id = $2 AND submission.case_id = $3
            AND submission.revision = $4
          ORDER BY activity.period, activity.source
        `, [scope.tenantId, orgId, caseId, submissionRevision]);
        if (!rows.length) throw new CarbonError(404, 'REVISION_NOT_FOUND', '未找到该任务的提交版本。');
        return {submissionRevision, status: rows[0].captured ? 'captured' : 'legacy_unavailable',
          items: rows.filter(row => row.period !== null).map(({captured, ...item}) => item)};
      });
    },

    submit(scope, orgId, id, revision, evidenceIds) {
      return inWorkspace(scope, async tx => {
        await requireRole(tx, scope, orgId, 'customer');
        return transition(tx, scope, orgId, id, revision, 'draft', 'submitted', true, {evidenceIds});
      });
    },

    resubmit(scope, orgId, id, revision, correctionNote, evidenceIds) {
      return inWorkspace(scope, async tx => {
        await requireRole(tx, scope, orgId, 'customer');
        return transition(tx, scope, orgId, id, revision, 'returned', 'submitted', true, {correctionNote, evidenceIds});
      });
    },

    review(scope, orgId, id, revision, decision, reason) {
      return inWorkspace(scope, async tx => {
        await requireRole(tx, scope, orgId, 'reviewer');
        return transition(tx, scope, orgId, id, revision, 'submitted', decision, false, {reason});
      });
    },

    listGrants(scope, orgId, limit, offset) {
      return inWorkspace(scope, async tx => {
        await requireRole(tx, scope, orgId, 'admin');
        const result = await tx.query(`
          SELECT actor_id AS "actorId", role FROM carbon.org_grant
          WHERE tenant_id = $1 AND org_id = $2 AND actor_id = $3 ORDER BY role
          LIMIT $4 OFFSET $5
        `, [scope.tenantId, orgId, scope.actorId, limit + 1, offset]);
        return {
          grants: result.rows.slice(0, limit),
          nextOffset: result.rows.length > limit ? offset + limit : null
        };
      });
    },

    listAudit(scope, orgId, limit, offset) {
      return inWorkspace(scope, async tx => {
        await requireRole(tx, scope, orgId, 'admin');
        const result = await tx.query(`
          SELECT ${eventFields}
          FROM carbon.audit_event WHERE tenant_id = $1 AND org_id = $2
          ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4
        `, [scope.tenantId, orgId, limit + 1, offset]);
        return {
          events: result.rows.slice(0, limit),
          nextOffset: result.rows.length > limit ? offset + limit : null
        };
      });
    }
  };
}
