import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { createEmbeddedDatabase } from '../infra/embedded.mjs';
import { migrate } from '../infra/migrations.mjs';
import { createCarbonApi } from '../src/index.mjs';

const [tenantId, orgId, releaseId, owner, peer] = Array.from({length: 5}, () => randomUUID());
let db;
let api;

before(async () => {
  db = await createEmbeddedDatabase();
  await migrate(db.admin);
  await db.admin.transaction(async tx => {
    await tx.query("INSERT INTO carbon.workspace (id, name) VALUES ($1, 'Activity history')", [tenantId]);
    await tx.query("INSERT INTO carbon.organization (tenant_id, id, name) VALUES ($1, $2, 'Primary')", [tenantId, orgId]);
    await tx.query(`INSERT INTO carbon.scenario_release (tenant_id, id, code, version, manifest)
      VALUES ($1, $2, 'inventory', 1, '{}')`, [tenantId, releaseId]);
    await tx.query(`INSERT INTO carbon.org_grant (tenant_id, org_id, actor_id, role)
      VALUES ($1, $2, $3, 'customer'), ($1, $2, $4, 'customer')`, [tenantId, orgId, owner, peer]);
  });
  api = createCarbonApi(db.runtime);
});

after(async () => { await db?.close(); });

function dispatch(method, path, body, actorId = owner) {
  return api.dispatch({method, path, body}, {tenantId, actorId, requestId: randomUUID()});
}

async function newCase() {
  const response = await dispatch('POST', '/v1/customer/cases', {orgId, scenarioReleaseId: releaseId, purpose: '追溯活动'});
  assert.equal(response.status, 201);
  return `/v1/customer/cases/${response.body.id}`;
}

async function save(path, data) {
  const csv = `period,source,quantity,unit\n${data}`;
  const result = await dispatch('POST', `${path}/imports`, {orgId, csv});
  assert.equal(result.status, 200);
  return result.body;
}

async function commit(path, {batchId, previewRevision}) {
  const result = await dispatch('POST', `${path}/imports/${batchId}/commit`, {orgId, previewRevision});
  assert.equal(result.status, 200);
}

function activity(path, query = 'period=2026-01&source=electricity', actor = owner) {
  return dispatch('GET', `${path}/activities?orgId=${orgId}&${query}`, undefined, actor);
}

test('activity lineage only reads confirmed revisions and preserves exact zero and pre-correction quantities', async () => {
  const path = await newCase();
  const first = await save(path, '2026-01,electricity,0,MWh');
  assert.equal((await activity(path)).body.error.code, 'ACTIVITY_NOT_FOUND');
  await commit(path, first);
  const original = await activity(path);
  assert.deepEqual(original, {status: 200, body: {
    period: '2026-01', source: 'electricity', revision: 1, quantity: '0', unit: 'kWh',
    lineage: {batchId: first.batchId, previewRevision: 1, sourceRow: 2, sourceType: 'manual_csv',
      conversionVersion: 'activity-csv-v1', originalQuantity: '0', originalUnit: 'MWh'}
  }});
  const next = await save(path, '2026-01,electricity,1.0000000000000000001,MWh');
  await commit(path, next);
  const latest = await activity(path);
  assert.equal(latest.body.revision, 2);
  assert.equal(latest.body.quantity, '1000.0000000000000001');
  assert.equal(latest.body.lineage.batchId, next.batchId);
  assert.deepEqual(await activity(path, 'period=2026-01&source=electricity&revision=1'), original);
  assert.equal((await activity(path, 'period=2026-01&source=electricity&revision=3')).body.error.code, 'ACTIVITY_NOT_FOUND');
});

test('activity lineage validates query inputs and follows the task owner and current organization grant', async () => {
  const path = await newCase();
  await commit(path, await save(path, '2026-01,natural_gas,0,m3'));
  for (const query of ['period=2026-13&source=natural_gas', 'period=0000-01&source=natural_gas', 'source=natural_gas',
    'period=2026-01&source=unknown', 'period=2026-01&source=natural_gas&revision=0',
    'period=2026-01&source=natural_gas&revision=1e0', 'period=2026-01&source=natural_gas&revision=2147483648',
    'period=2026-01&source=natural_gas&revision=1&revision=1']) {
    assert.equal((await activity(path, query)).status, 400);
  }
  const query = 'period=2026-01&source=natural_gas';
  assert.equal((await activity(path, query)).body.quantity, '0');
  assert.equal((await activity(path, query, peer)).status, 404);
  assert.equal((await activity(await newCase(), query)).body.error.code, 'ACTIVITY_NOT_FOUND');
  await db.admin.transaction(tx => tx.query(`DELETE FROM carbon.org_grant
    WHERE tenant_id = $1 AND org_id = $2 AND actor_id = $3 AND role = 'customer'`, [tenantId, orgId, owner]));
  assert.equal((await activity(path, query)).status, 403);
});
