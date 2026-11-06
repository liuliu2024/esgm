import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createEmbeddedDatabase } from '../infra/embedded.mjs';
import { migrate } from '../infra/migrations.mjs';
import { createCarbonApi } from '../src/index.mjs';

test('scoped report uses template V2 and retains the previous template draft for the same snapshot', async t => {
  const db = await createEmbeddedDatabase();
  t.after(() => db.close());
  await migrate(db.admin);
  const [tenantId, orgId, releaseId, actorId, snapshotId, oldDraftId] = Array.from({length: 6}, () => randomUUID());
  await db.admin.transaction(async tx => {
    await tx.query("INSERT INTO carbon.workspace (id, name) VALUES ($1, 'Report scope')", [tenantId]);
    await tx.query("INSERT INTO carbon.organization (tenant_id, id, name) VALUES ($1, $2, 'Primary')", [tenantId, orgId]);
    await tx.query(`INSERT INTO carbon.scenario_release (tenant_id, id, code, version, manifest)
      VALUES ($1, $2, 'inventory', 1, '{}')`, [tenantId, releaseId]);
    await tx.query(`INSERT INTO carbon.org_grant (tenant_id, org_id, actor_id, role)
      VALUES ($1, $2, $3, 'customer')`, [tenantId, orgId, actorId]);
  });
  const api = createCarbonApi(db.runtime);
  const dispatch = (method, path, body) => api.dispatch({method, path, body}, {tenantId, actorId, requestId: randomUUID()});
  const declaredScope = {subjectType: 'product', subjectName: '示例电机', jurisdiction: '浙江', reportingYear: '2025', recipient: '示例采购方'};
  const createdCase = await dispatch('POST', '/v1/customer/cases', {
    orgId, scenarioReleaseId: releaseId, purpose: '内部范围说明', scope: declaredScope
  });
  assert.equal(createdCase.status, 201);
  const caseId = createdCase.body.id;
  const scope = {caseId, from: '2026-01', to: '2026-01', purpose: '内部范围说明', snapshotCreatedAt: '2026-02-01T00:00:00.000Z'};
  const synthetic = {caseId, mode: 'synthetic', formalReportEligible: false};
  const coverage = {status: 'complete', expectedSlots: 2, availableSlots: 2, missingSlots: 0};
  const v1 = {...synthetic, snapshotId, status: 'draft', externalDeliveryEligible: false,
    template: {id: 'internal-management-demo', version: 1, locale: 'zh-CN'},
    report: {title: '内部管理报告演示稿', watermark: '内部演示｜合成因子｜禁止外发', scope}};
  await db.admin.transaction(async tx => {
    await tx.query(`INSERT INTO carbon.calculation_snapshot
      (tenant_id, org_id, case_id, id, created_by, request_id, created_at, schema_version, from_period, to_period, input_fingerprint, payload)
      VALUES ($1, $2, $3, $4, $5, 'test', $6, 1, '2026-01-01', '2026-01-01', $7, $8)`,
    [tenantId, orgId, caseId, snapshotId, actorId, scope.snapshotCreatedAt, 'a'.repeat(64), {
      ...synthetic, from: scope.from, to: scope.to, coverage, totalKgCO2e: '900', totalTCO2e: '0.9', model: {}, items: []
    }]);
    await tx.query(`INSERT INTO carbon.internal_report_draft
      (tenant_id, org_id, case_id, id, snapshot_id, template_id, template_version, created_by, request_id, payload)
      VALUES ($1, $2, $3, $4, $5, 'internal-management-demo', 1, $6, 'test', $7)`,
    [tenantId, orgId, caseId, oldDraftId, snapshotId, actorId, v1]);
  });

  const collection = `/v1/customer/cases/${caseId}/internal-report-drafts`;
  const generated = await dispatch('POST', collection, {orgId, snapshotId});
  assert.equal(generated.status, 201);
  assert.notEqual(generated.body.draftId, oldDraftId);
  assert.deepEqual(generated.body.template, {...v1.template, version: 2});
  assert.deepEqual(generated.body.report.scope, {...scope, declaredScope});
  assert.equal(generated.body.report.summary.totalKgCO2e, '900');
  assert.equal(generated.body.formalReportEligible, false);
  assert.equal(generated.body.externalDeliveryEligible, false);
  assert.equal(generated.body.report.watermark, v1.report.watermark);
  const replayed = await dispatch('POST', collection, {orgId, snapshotId});
  assert.deepEqual(replayed, {status: 200, body: generated.body});
  const prior = await dispatch('GET', `${collection}/${oldDraftId}?orgId=${orgId}`);
  assert.equal(prior.status, 200);
  assert.deepEqual(prior.body.report, v1.report);
  assert.deepEqual(prior.body.template, v1.template);
  const history = await dispatch('GET', `${collection}?orgId=${orgId}`);
  assert.deepEqual(history.body.items.map(item => item.templateVersion), [2, 1]);
});
