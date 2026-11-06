import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { startDemo } from '../infra/demo-data.mjs';

let demo;
before(async () => { demo = await startDemo(); });
after(async () => { await demo?.close(); });

async function newCase(scenarioReleaseId = demo.scenarioReleaseId) {
  const created = await demo.dispatch('customer', 'POST', '/v1/customer/cases', {
    orgId: demo.orgId, scenarioReleaseId, purpose: '内部管理编制'
  });
  assert.equal(created.status, 201);
  return `/v1/customer/cases/${created.body.id}`;
}

async function commitImport(path, rows) {
  const {orgId} = demo;
  const saved = await demo.dispatch('customer', 'POST', `${path}/imports`, {
    orgId, csv: `period,source,quantity,unit\n${rows}`
  });
  assert.equal(saved.status, 200);
  const {batchId, previewRevision} = saved.body;
  const result = await demo.dispatch('customer', 'POST', `${path}/imports/${batchId}/commit`, {orgId, previewRevision});
  assert.equal(result.status, 200);
}

async function snapshot(path) {
  const saved = await demo.dispatch('customer', 'POST', `${path}/calculation-snapshots`, {
    orgId: demo.orgId, from: '2026-01', to: '2026-01'
  });
  assert.equal(saved.status, 201);
  return saved.body;
}

function generate(path, snapshotId, role = 'customer', options = {}) {
  return demo.dispatch(role, 'POST', `${path}/internal-report-drafts`, {orgId: demo.orgId, snapshotId, ...options});
}

function read(path, draftId, role = 'customer', orgId = demo.orgId) {
  return demo.dispatch(role, 'GET', `${path}/internal-report-drafts/${draftId}?orgId=${orgId}`);
}

test('report draft reads frozen results after ledger corrections and reuses one draft per template and source', async () => {
  const path = await newCase();
  const auditPath = `${path}/history?orgId=${demo.orgId}`;
  const audit = await demo.dispatch('customer', 'GET', auditPath);
  await commitImport(path, '2026-01,electricity,1,MWh\n2026-01,natural_gas,200,m3');
  const original = await snapshot(path);
  await commitImport(path, '2026-01,electricity,1200,kWh');
  const attempts = await Promise.all([generate(path, original.snapshotId), generate(path, original.snapshotId)]);
  assert.deepEqual(attempts.map(response => response.status).sort(), [200, 201]);
  assert.deepEqual(attempts[0].body, attempts[1].body);
  const draft = attempts[0].body;
  assert.equal(draft.snapshotId, original.snapshotId);
  assert.equal(draft.caseId, original.caseId);
  assert.equal(draft.status, 'draft');
  assert.equal(draft.mode, 'synthetic');
  assert.equal(draft.formalReportEligible, false);
  assert.equal(draft.externalDeliveryEligible, false);
  assert.deepEqual(draft.template, {id: 'internal-management-demo', version: 1, locale: 'zh-CN'});
  assert.equal(draft.report.watermark, '内部演示｜合成因子｜禁止外发');
  assert.equal(draft.report.scope.snapshotCreatedAt, original.createdAt);
  assert.equal(draft.report.scope.purpose, '内部管理编制');
  assert.equal(draft.report.summary.totalKgCO2e, '900');
  assert.equal(draft.report.summary.totalTCO2e, '0.9');
  assert.deepEqual(draft.report.items, original.result.items);
  assert.equal(draft.report.items[0].lineage.activityRevision, 1);

  const revised = await snapshot(path);
  const newerDraft = await generate(path, revised.snapshotId);
  assert.equal(newerDraft.status, 201);
  assert.notEqual(newerDraft.body.draftId, draft.draftId);
  assert.equal(newerDraft.body.report.summary.totalKgCO2e, '1000');
  assert.deepEqual(await read(path, draft.draftId), {status: 200, body: draft});
  assert.deepEqual(await demo.dispatch('customer', 'GET', auditPath), audit);
});

test('draft is reusable for a second industry and remains within the task and authorized creator scope', async () => {
  const catalog = await demo.dispatch('customer', 'GET', `/v1/customer/scenarios?orgId=${demo.orgId}`);
  const building = catalog.body.items.find(item => item.code === 'building-inventory');
  const path = await newCase(building.id);
  await commitImport(path, '2026-01,electricity,0,kWh\n2026-01,natural_gas,0,m3');
  const source = await snapshot(path);
  const created = await generate(path, source.snapshotId);
  assert.equal(created.status, 201);
  assert.equal(created.body.report.summary.totalKgCO2e, '0');
  const foreignTask = await newCase();
  assert.equal((await generate(foreignTask, source.snapshotId)).status, 404);
  assert.equal((await read(foreignTask, created.body.draftId)).status, 404);
  assert.equal((await generate(path, source.snapshotId, 'reviewer')).status, 403);
  assert.equal((await read(path, created.body.draftId, 'reviewer')).status, 403);
  assert.equal((await read(path, created.body.draftId, 'customer', randomUUID())).status, 403);
  assert.equal((await generate(path, source.snapshotId, 'customer', {externalDeliveryEligible: true})).status, 400);
  assert.equal((await generate(path, randomUUID())).status, 404);
});
