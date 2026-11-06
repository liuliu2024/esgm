import { createHash, randomUUID } from 'node:crypto';
import { previewActivityCsv } from './activity-preview.mjs';

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
const evidenceFields = `id, case_id AS "caseId", org_id AS "orgId", registered_by AS "registeredBy",
  title, source_description AS "sourceDescription", created_at AS "createdAt"`;
const catalogFields = ['industryCode', 'industryName', 'title', 'purpose', 'recipient'];
const referenceFields = ['code', 'title', 'publisher', 'sourceUrl', 'scopeNote'];
const activityTemplate = 'activity-csv-v1';
const snapshotSchemaVersion = 1;
const snapshotFields = `id AS "snapshotId", case_id AS "caseId", created_at AS "createdAt",
  schema_version AS "schemaVersion", payload AS result`;
const draftFields = `id AS "draftId", created_at AS "createdAt", payload`;
const reportReviewFields = `draft_id AS "draftId", case_id AS "caseId", status,
  submitted_by AS "submittedBy", submitted_at AS "submittedAt", reviewed_by AS "reviewedBy",
  reviewed_at AS "reviewedAt", reason`;

function accessDenied() {
  return new CarbonError(403, 'ACCESS_DENIED', '你没有该组织的操作权限。');
}

function caseMissing() {
  return new CarbonError(404, 'CASE_NOT_FOUND', '未找到可访问的受理任务。');
}

function caseDetail({scope, ...task}) {
  return scope === null ? task : {...task, scope};
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

async function readVisibleCase(tx, scope, orgId, id, customerOnly) {
  await requireRole(tx, scope, orgId, customerOnly ? 'customer' : 'reviewer');
  const result = await readCase(tx, scope, orgId, id, customerOnly);
  if (!customerOnly && result.status === 'draft') throw caseMissing();
  return result;
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

function draftResponse({draftId, createdAt, payload}) {
  return {draftId, createdAt: new Date(createdAt).toISOString(), ...payload};
}

async function readDraft(tx, key) {
  const {rows: [draft]} = await tx.query(`
    SELECT ${draftFields} FROM carbon.internal_report_draft
    WHERE tenant_id = $1 AND org_id = $2 AND case_id = $3 AND id = $4
  `, key);
  if (!draft) throw new CarbonError(404, 'REPORT_DRAFT_NOT_FOUND', '未找到可访问的内部演示稿。');
  return draftResponse(draft);
}

async function findReportReview(tx, key) {
  const {rows: [review]} = await tx.query(`
    SELECT ${reportReviewFields} FROM carbon.internal_report_review
    WHERE tenant_id = $1 AND org_id = $2 AND case_id = $3 AND draft_id = $4
  `, key);
  return review;
}

function reportReviewResponse(review) {
  if (!review) throw new CarbonError(404, 'REPORT_REVIEW_NOT_FOUND', '未找到该演示稿的复核记录。');
  return {...review, submittedAt: new Date(review.submittedAt).toISOString(),
    reviewedAt: review.reviewedAt === null ? null : new Date(review.reviewedAt).toISOString(),
    formalReportEligible: false, externalDeliveryEligible: false};
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
        const fingerprint = createHash('sha256').update(JSON.stringify(inputs)).digest('hex');
        const key = [scope.tenantId, orgId, caseId];
        const {rows: [created]} = await tx.query(`
          INSERT INTO carbon.calculation_snapshot (tenant_id, org_id, case_id, id, created_by, request_id,
            schema_version, from_period, to_period, input_fingerprint, payload)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          ON CONFLICT (tenant_id, org_id, case_id, input_fingerprint) DO NOTHING
          RETURNING ${snapshotFields}
        `, [...key, randomUUID(), scope.actorId, scope.requestId, snapshotSchemaVersion,
          `${from}-01`, `${to}-01`, fingerprint, JSON.stringify(result)]);
        if (created) return {status: 201, body: {...created, createdAt: new Date(created.createdAt).toISOString()}};

        const {rows: [existing]} = await tx.query(`
          SELECT ${snapshotFields} FROM carbon.calculation_snapshot
          WHERE tenant_id = $1 AND org_id = $2 AND case_id = $3 AND input_fingerprint = $4
        `, [...key, fingerprint]);
        return {status: 200, body: {...existing, createdAt: new Date(existing.createdAt).toISOString()}};
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
        const key = [scope.tenantId, orgId, caseId, snapshotId, template.id, template.version];
        const {rows: [created]} = await tx.query(`
          INSERT INTO carbon.internal_report_draft
            (tenant_id, org_id, case_id, snapshot_id, template_id, template_version, id, created_by, request_id, payload)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          ON CONFLICT (tenant_id, org_id, case_id, snapshot_id, template_id, template_version) DO NOTHING
          RETURNING ${draftFields}
        `, [...key, randomUUID(), scope.actorId, scope.requestId, JSON.stringify(payload)]);
        if (created) return {status: 201, body: draftResponse(created)};

        const {rows: [existing]} = await tx.query(`
          SELECT ${draftFields} FROM carbon.internal_report_draft
          WHERE tenant_id = $1 AND org_id = $2 AND case_id = $3 AND snapshot_id = $4
            AND template_id = $5 AND template_version = $6
        `, key);
        return {status: 200, body: draftResponse(existing)};
      });
    },

    listInternalReportDrafts(scope, orgId, caseId, limit, cursor, customerOnly) {
      return inWorkspace(scope, async tx => {
        const task = await readVisibleCase(tx, scope, orgId, caseId, customerOnly);
        if (!customerOnly && task.createdBy === scope.actorId) {
          throw new CarbonError(403, 'SELF_REVIEW_FORBIDDEN', '发起人不能复核自己的任务。');
        }
        const {rows} = await tx.query(`
          SELECT draft.id AS "draftId", draft.snapshot_id AS "snapshotId", draft.created_at AS "createdAt",
            draft.payload#>>'{report,scope,from}' AS "from", draft.payload#>>'{report,scope,to}' AS "to",
            draft.template_version AS "templateVersion", review.status AS "reviewStatus"
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
        const items = rows.slice(0, limit).map(({reviewStatus, ...item}) => ({...item,
          createdAt: new Date(item.createdAt).toISOString(), ...(!customerOnly && {reviewStatus})}));
        return {items, nextCursor: rows.length > limit ? items.at(-1).draftId : null};
      });
    },

    readInternalReportDraft(scope, orgId, caseId, draftId) {
      return inWorkspace(scope, async tx => {
        await readVisibleCase(tx, scope, orgId, caseId, true);
        return readDraft(tx, [scope.tenantId, orgId, caseId, draftId]);
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
          throw new CarbonError(409, 'REPORT_REVIEW_CONFLICT', '该演示稿已有复核结论。');
        }
        return {review: reportReviewResponse(review)};
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

    listFactorReferences(scope, orgId, accountingBasis, regionCode, dataYear) {
      return inWorkspace(scope, async tx => {
        await requireRole(tx, scope, orgId, 'reviewer');
        const {rows: items} = await tx.query(`
          SELECT factor_id AS "factorId", version, accounting_basis AS "accountingBasis", region_code AS "regionCode",
            data_year AS "dataYear", value::text AS value, input_unit AS "inputUnit", output_unit AS "outputUnit",
            source_title AS "sourceTitle", source_url AS "sourceUrl", source_locator AS "sourceLocator", usage_note AS "usageNote"
          FROM catalog.factor_reference_version
          WHERE accounting_basis = $1 AND region_code = $2 AND data_year = $3
          ORDER BY factor_id, version DESC
        `, [accountingBasis, regionCode, dataYear]);
        return {items};
      });
    },

    listScenarioReferences(scope, orgId, scenarioReleaseId) {
      return inWorkspace(scope, async tx => {
        await requireRole(tx, scope, orgId, 'customer');
        const {rows: [release]} = await tx.query(`
          SELECT manifest->'references' AS references FROM carbon.scenario_release
          WHERE tenant_id = $1 AND id = $2
        `, [scope.tenantId, scenarioReleaseId]);
        if (!release) throw new CarbonError(404, 'SCENARIO_NOT_FOUND', '未找到可访问的场景版本。');
        const items = [];
        if (Array.isArray(release.references)) {
          for (const entry of release.references) {
            if (!referenceFields.every(field => typeof entry?.[field] === 'string' && entry[field].trim())) continue;
            const url = URL.parse(entry.sourceUrl);
            if (url?.protocol !== 'https:' || url.username || url.password) continue;
            items.push({...Object.fromEntries(referenceFields.map(field => [field, entry[field]])), sourceUrl: url.href});
          }
        }
        return {scenarioReleaseId, ruleStatus: 'needs_review', items};
      });
    },

    listScenarios(scope, orgId) {
      return inWorkspace(scope, async tx => {
        await requireRole(tx, scope, orgId, 'customer');
        const {rows} = await tx.query(`
          SELECT DISTINCT ON (code) id, code, version, manifest->'catalog' AS catalog
          FROM carbon.scenario_release
          WHERE tenant_id = $1
          ORDER BY code, version DESC
        `, [scope.tenantId]);
        const items = [];
        for (const {id, code, version, catalog} of rows) {
          if (!catalogFields.every(field => typeof catalog?.[field] === 'string' && catalog[field].trim())) continue;
          const details = Object.fromEntries(catalogFields.map(field => [field, catalog[field]]));
          const {materials, reportRequirements} = catalog.preparation ?? {};
          if ([materials, reportRequirements].every(lines => Array.isArray(lines) && lines.length &&
              lines.every(line => typeof line === 'string' && line.trim()))) {
            details.preparation = {materials, reportRequirements};
          }
          items.push({id, code, version, ...details, ruleStatus: 'needs_review'});
        }
        return {items};
      });
    },

    create(scope, input) {
      return inWorkspace(scope, async tx => {
        await requireRole(tx, scope, input.orgId, 'customer');
        const scenario = await tx.query(`
          SELECT 1 FROM carbon.scenario_release WHERE tenant_id = $1 AND id = $2
        `, [scope.tenantId, input.scenarioReleaseId]);
        if (scenario.rows.length === 0) {
          throw new CarbonError(404, 'SCENARIO_NOT_FOUND', '未找到可访问的场景版本。');
        }
        const result = await tx.query(`
          INSERT INTO carbon.case_intake
            (tenant_id, id, org_id, scenario_release_id, created_by, purpose, intake_scope)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          RETURNING ${caseDetailFields}
        `, [scope.tenantId, randomUUID(), input.orgId, input.scenarioReleaseId, scope.actorId, input.purpose, input.intakeScope]);
        return caseDetail(result.rows[0]);
      });
    },

    read(scope, orgId, id, customerOnly) {
      return inWorkspace(scope, tx => readVisibleCase(tx, scope, orgId, id, customerOnly));
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
          INSERT INTO carbon.case_evidence (tenant_id, org_id, case_id, id, registered_by, title, source_description)
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
            CASE WHEN EXISTS (
              SELECT 1 FROM carbon.evidence_receipt AS receipt
              WHERE receipt.tenant_id = evidence.tenant_id
                AND receipt.org_id = evidence.org_id
                AND receipt.case_id = evidence.case_id
                AND receipt.evidence_id = evidence.id
            ) THEN 'pending_scan' ELSE 'pending_file' END AS status
          FROM carbon.case_evidence AS evidence
          WHERE tenant_id = $1 AND org_id = $2 AND case_id = $3
          ORDER BY created_at, id
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
