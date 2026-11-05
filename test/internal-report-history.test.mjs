import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { createEmbeddedDatabase } from '../infra/embedded.mjs';
import { migrate } from '../infra/migrations.mjs';
import { createCarbonApi } from '../src/index.mjs';

const [tenantId, orgId, releaseId, customer, peer] = Array.from({length: 5}, () => randomUUID());
let db;
let api;

before(async () => {
  db = await createEmbeddedDatabase();
  await migrate(db.admin);
  await db.admin.transaction(async tx => {
    await tx.query("INSERT INTO carbon.workspace (id, name) VALUES ($1, 'History')", [tenantId]);
    await tx.query("INSERT INTO carbon.organization (tenant_id, id, name) VALUES ($1, $2, 'Primary')", [tenantId, orgId]);
    await tx.query(`INSERT INTO carbon.scenario_release (tenant_id, id, code, version, manifest)
      VALUES ($1, $2, 'inventory', 1, '{}')`, [tenantId, releaseId]);
    await tx.query(`INSERT INTO carbon.org_grant (tenant_id, org_id, actor_id, role)
      VALUES ($1, $2, $3, 'customer'), ($1, $2, $4, 'customer')`, [tenantId, orgId, customer, peer]);
  });
  api = createCarbonApi(db.runtime);
});

after(async () => { await db?.close(); });

function dispatch(method, path, body, actorId = customer) {
  return api.dispatch({method, path, body}, {tenantId, actorId, requestId: randomUUID()});
}

async function newCase() {
  const created = await dispatch('POST', '/v1/customer/cases', {orgId, scenarioReleaseId: releaseId, purpose: '版本目录测试'});
  assert.equal(created.status, 201);
  return created.body.id;
}

function list(caseId, query = '', actorId = customer) {
  return dispatch('GET', `/v1/customer/cases/${caseId}/internal-report-drafts?orgId=${orgId}${query}`, undefined, actorId);
}

async function seedDraft(caseId, draftId, createdAt) {
  const snapshotId = randomUUID();
  const common = {caseId, mode: 'synthetic', formalReportEligible: false};
  await db.admin.transaction(async tx => {
    await tx.query(`INSERT INTO carbon.calculation_snapshot
      (tenant_id, org_id, case_id, id, created_by, request_id, schema_version, from_period, to_period, input_fingerprint, payload)
      VALUES ($1, $2, $3, $4, $5, 'test', 1, '2026-01-01', '2026-02-01', $6, $7)`,
    [tenantId, orgId, caseId, snapshotId, customer, snapshotId.replaceAll('-', '').repeat(2),
      {...common, coverage: {status: 'complete'}}]);
    await tx.query(`INSERT INTO carbon.internal_report_draft
      (tenant_id, org_id, case_id, id, snapshot_id, template_id, template_version, created_by, request_id, created_at, payload)
      VALUES ($1, $2, $3, $4, $5, 'internal-management-demo', 1, $6, 'test', $7, $8)`,
    [tenantId, orgId, caseId, draftId, snapshotId, customer, createdAt, {
      ...common, snapshotId, status: 'draft', externalDeliveryEligible: false, report: {
        watermark: '内部演示｜合成因子｜禁止外发', scope: {from: '2026-01', to: '2026-02'}, items: ['private detail']
      }
    }]);
  });
  return {draftId, snapshotId, createdAt, from: '2026-01', to: '2026-02', templateVersion: 1};
}

test('report history returns only summaries in stable keyset order, including equal timestamps', async () => {
  const caseId = await newCase();
  assert.deepEqual(await list(caseId), {status: 200, body: {items: [], nextCursor: null}});
  const tiedTime = '2026-02-03T04:05:06.000Z';
  const tiedLow = await seedDraft(caseId, '00000000-0000-4000-8000-000000000001', tiedTime);
  const tiedHigh = await seedDraft(caseId, '00000000-0000-4000-8000-000000000002', tiedTime);
  const newer = await seedDraft(caseId, randomUUID(), '2026-02-04T04:05:06.000Z');
  assert.deepEqual((await list(caseId)).body, {items: [newer, tiedHigh, tiedLow], nextCursor: null});
  assert.deepEqual((await list(caseId, '&limit=2')).body, {items: [newer, tiedHigh], nextCursor: tiedHigh.draftId});
  assert.deepEqual((await list(caseId, `&limit=2&cursor=${tiedHigh.draftId}`)).body, {items: [tiedLow], nextCursor: null});
  assert.deepEqual((await list(caseId, `&cursor=${tiedLow.draftId}`)).body, {items: [], nextCursor: null});
  assert.equal((await list(caseId, '&limit=101')).status, 400);
  assert.equal((await list(caseId, '&cursor=invalid')).status, 400);
});

test('report history rejects scope escalation and does not accept another case as a cursor anchor', async () => {
  const caseId = await newCase();
  const secondCaseId = await newCase();
  const earlier = '2026-03-02T04:05:06.000Z';
  await seedDraft(caseId, randomUUID(), earlier);
  const other = await seedDraft(secondCaseId, randomUUID(), '2026-03-03T04:05:06.000Z');
  assert.deepEqual((await list(caseId, `&cursor=${other.draftId}`)).body, {items: [], nextCursor: null});
  assert.deepEqual((await list(caseId, `&cursor=${randomUUID()}`)).body, {items: [], nextCursor: null});
  assert.equal((await list(caseId, '', peer)).status, 404);
  await db.admin.transaction(tx => tx.query(`DELETE FROM carbon.org_grant
    WHERE tenant_id = $1 AND org_id = $2 AND actor_id = $3 AND role = 'customer'`, [tenantId, orgId, customer]));
  assert.equal((await list(caseId)).status, 403);
});
