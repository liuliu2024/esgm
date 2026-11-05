import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { createEmbeddedDatabase } from '../infra/embedded.mjs';
import { migrate } from '../infra/migrations.mjs';
import { createCarbonApi } from '../src/index.mjs';

const [tenantId, orgId, otherOrgId, otherTenantId, otherTenantOrgId, releaseId, customer, peer, otherCustomer] =
  Array.from({length: 9}, () => randomUUID());
let db;
let api;

before(async () => {
  db = await createEmbeddedDatabase();
  await migrate(db.admin);
  await db.admin.transaction(async tx => {
    await tx.query("INSERT INTO carbon.workspace (id, name) VALUES ($1, 'Primary'), ($2, 'Other')", [tenantId, otherTenantId]);
    await tx.query(`INSERT INTO carbon.organization (tenant_id, id, name) VALUES
      ($1, $2, 'Primary'), ($1, $3, 'Other org'), ($4, $5, 'Other tenant')`,
    [tenantId, orgId, otherOrgId, otherTenantId, otherTenantOrgId]);
    await tx.query(`INSERT INTO carbon.scenario_release (tenant_id, id, code, version, manifest)
      VALUES ($1, $2, 'inventory', 1, '{}')`, [tenantId, releaseId]);
    await tx.query(`INSERT INTO carbon.org_grant (tenant_id, org_id, actor_id, role) VALUES
      ($1, $2, $3, 'customer'), ($1, $2, $4, 'customer'), ($1, $5, $3, 'customer'), ($6, $7, $8, 'customer')`,
    [tenantId, orgId, customer, peer, otherOrgId, otherTenantId, otherTenantOrgId, otherCustomer]);
  });
  api = createCarbonApi(db.runtime);
});
after(async () => { await db?.close(); });

function dispatch(method, path, body, actor = customer, workspace = tenantId) {
  return api.dispatch({method, path, body}, {tenantId: workspace, actorId: actor, requestId: randomUUID()});
}

async function newCase(actor = customer) {
  const response = await dispatch('POST', '/v1/customer/cases', {orgId, scenarioReleaseId: releaseId, purpose: '核算预览'}, actor);
  assert.equal(response.status, 201);
  return `/v1/customer/cases/${response.body.id}`;
}

async function save(path, content, actor = customer) {
  const response = await dispatch('POST', `${path}/imports`, {orgId, csv: `period,source,quantity,unit\n${content}`}, actor);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body;
}

async function commit(path, {batchId, previewRevision}) {
  const response = await dispatch('POST', `${path}/imports/${batchId}/commit`, {orgId, previewRevision});
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body;
}

function read(path, from = '2026-01', to = from, actor = customer, workspace = tenantId, organization = orgId) {
  return dispatch('GET', `${path}/calculation-preview?orgId=${organization}&from=${from}&to=${to}`, undefined, actor, workspace);
}

test('synthetic preview computes exact results from latest committed revisions with source lineage', async () => {
  const path = await newCase();
  const batch = await save(path, '2026-01,electricity,1,MWh\n2026-01,natural_gas,200,m3');
  assert.equal((await read(path)).body.coverage.status, 'empty');
  await commit(path, batch);
  const before = await read(path);
  assert.equal(before.status, 200, JSON.stringify(before.body));
  const initial = before.body;
  assert.equal(initial.formalReportEligible, false);
  assert.equal(initial.mode, 'synthetic');
  assert.deepEqual(initial.coverage, {status: 'complete', expectedSlots: 2, availableSlots: 2, missingSlots: 0});
  assert.equal(initial.knownSubtotalKgCO2e, '900');
  assert.equal(initial.totalKgCO2e, '900');
  assert.equal(initial.totalTCO2e, '0.9');
  assert.deepEqual(initial.items.map(({source, quantity, unit, emissionsKgCO2e, factor}) =>
    [source, quantity, unit, emissionsKgCO2e, factor.value, factor.synthetic]), [
    ['electricity', '1000', 'kWh', '500', '0.5', true], ['natural_gas', '200', 'm3', '400', '2', true]
  ]);
  assert.deepEqual(initial.items[0].lineage, {
    activityRevision: 1, batchId: batch.batchId, previewRevision: 1, sourceRow: 2,
    sourceType: 'manual_csv', conversionVersion: 'activity-csv-v1', originalQuantity: '1', originalUnit: 'MWh'
  });
  assert.deepEqual(await read(path), before);
  const correction = await save(path, '2026-01,electricity,1000.0000000000001,kWh');
  await commit(path, correction);
  const {body: revised} = await read(path);
  assert.equal(revised.items[0].lineage.activityRevision, 2);
  assert.equal(revised.items[0].lineage.batchId, correction.batchId);
  assert.equal(revised.items[0].emissionsKgCO2e, '500.00000000000005');
  assert.equal(revised.totalTCO2e, '0.90000000000000005');
  const {rows} = await db.admin.transaction(tx => tx.query(`
    SELECT revision FROM carbon.activity_record_revision WHERE case_id = $1 AND source = 'electricity' ORDER BY revision
  `, [initial.caseId]));
  assert.deepEqual(rows.map(({revision}) => revision), [1, 2]);
});

test('preview separates confirmed zero from missing values and validates scope and month range', async () => {
  const path = await newCase();
  await commit(path, await save(path, '2026-01,electricity,0,kWh'));
  const {body: partial} = await read(path);
  assert.deepEqual(partial.coverage, {status: 'partial', expectedSlots: 2, availableSlots: 1, missingSlots: 1});
  assert.equal(partial.knownSubtotalKgCO2e, '0');
  assert.equal(partial.totalKgCO2e, null);
  assert.equal(partial.totalTCO2e, null);
  assert.equal(partial.items[0].status, 'calculated');
  assert.equal(partial.items[0].emissionsKgCO2e, '0');
  assert.equal(partial.items[1].status, 'missing_activity');
  assert.equal(partial.items[1].quantity, null);
  assert.equal(partial.items[1].emissionsKgCO2e, null);
  assert.equal(partial.items[1].lineage, null);
  const crossYear = (await read(path, '2025-12', '2026-01')).body;
  assert.deepEqual(crossYear.items.map(({period}) => period), ['2025-12', '2025-12', '2026-01', '2026-01']);
  const empty = (await read(path, '2026-02')).body;
  assert.equal(empty.coverage.status, 'empty');
  assert.equal(empty.knownSubtotalKgCO2e, null);
  for (const [from, to] of [['2026-00', '2026-01'], ['0000-01', '0000-01'], ['2026-02', '2026-01'], ['2026-01', '2027-01']]) {
    assert.equal((await read(path, from, to)).status, 400);
  }
  assert.equal((await read(path, '2026-01', '2026-01', peer)).status, 404);
  assert.equal((await read(path, '2026-01', '2026-01', customer, tenantId, otherOrgId)).status, 404);
  assert.equal((await read(path, '2026-01', '2026-01', otherCustomer, otherTenantId, otherTenantOrgId)).status, 404);
  await db.admin.transaction(tx => tx.query(`DELETE FROM carbon.org_grant
    WHERE tenant_id = $1 AND org_id = $2 AND actor_id = $3 AND role = 'customer'`, [tenantId, orgId, customer]));
  assert.equal((await read(path)).status, 403);
});
