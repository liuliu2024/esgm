import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { startDemo } from '../infra/demo-data.mjs';

let demo;
before(async () => { demo = await startDemo(); });
after(async () => { await demo?.close(); });

async function newCase() {
  const {orgId, scenarioReleaseId} = demo;
  const response = await demo.dispatch('customer', 'POST', '/v1/customer/cases', {orgId, scenarioReleaseId, purpose: '冻结核算'});
  assert.equal(response.status, 201);
  return `/v1/customer/cases/${response.body.id}`;
}

async function prepareImport(path, content) {
  const {orgId} = demo;
  const csv = `period,source,quantity,unit\n${content}`;
  const response = await demo.dispatch('customer', 'POST', `${path}/imports`, {orgId, csv});
  assert.equal(response.status, 200);
  return response.body;
}

async function commitImport(path, {batchId, previewRevision}) {
  const result = await demo.dispatch('customer', 'POST', `${path}/imports/${batchId}/commit`, {orgId: demo.orgId, previewRevision});
  assert.equal(result.status, 200);
}

function save(path, role = 'customer', options = {}) {
  return demo.dispatch(role, 'POST', `${path}/calculation-snapshots`, {
    orgId: demo.orgId, from: '2026-01', to: '2026-01', ...options
  });
}

function read(path, snapshotId, role = 'customer') {
  return demo.dispatch(role, 'GET', `${path}/calculation-snapshots/${snapshotId}?orgId=${demo.orgId}`);
}

test('calculation snapshot freezes exact results and concurrent same-input saves reuse the first snapshot', async () => {
  const path = await newCase();
  const batch = await prepareImport(path, '2026-01,electricity,1,MWh\n2026-01,natural_gas,200,m3');
  assert.equal((await save(path)).body.error.code, 'CALCULATION_INCOMPLETE');
  await commitImport(path, batch);
  const caseBefore = await demo.dispatch('customer', 'GET', `${path}?orgId=${demo.orgId}`);
  const auditBefore = await demo.dispatch('customer', 'GET', `${path}/history?orgId=${demo.orgId}`);
  const saves = await Promise.all([save(path), save(path)]);
  assert.deepEqual(saves.map(response => response.status).sort(), [200, 201]);
  assert.deepEqual(saves[0].body, saves[1].body);
  const first = saves[0].body;
  assert.equal(first.schemaVersion, 1);
  assert.equal(first.result.totalKgCO2e, '900');
  assert.equal(first.result.totalTCO2e, '0.9');
  assert.equal(first.result.formalReportEligible, false);
  assert.deepEqual(first.result.items.map(item => [item.factor.id, item.lineage.activityRevision]),
    [['demo-electricity', 1], ['demo-natural-gas', 1]]);
  assert.equal((await read(path, first.snapshotId)).status, 200);
  assert.deepEqual((await read(path, first.snapshotId)).body, first);

  await commitImport(path, await prepareImport(path, '2026-01,electricity,1000.0000000000001,kWh'));
  const revised = await save(path);
  assert.equal(revised.status, 201);
  assert.notEqual(revised.body.snapshotId, first.snapshotId);
  assert.equal(revised.body.result.totalKgCO2e, '900.00000000000005');
  assert.equal(revised.body.result.items[0].lineage.activityRevision, 2);
  assert.deepEqual((await read(path, first.snapshotId)).body, first);
  assert.deepEqual(await demo.dispatch('customer', 'GET', `${path}?orgId=${demo.orgId}`), caseBefore);
  assert.deepEqual(await demo.dispatch('customer', 'GET', `${path}/history?orgId=${demo.orgId}`), auditBefore);
});

test('calculation snapshot requires complete coverage and protects the case and snapshot scope', async () => {
  const path = await newCase();
  assert.equal((await save(path)).status, 409);
  await commitImport(path, await prepareImport(path, '2026-01,electricity,0,kWh'));
  assert.equal((await save(path)).body.error.code, 'CALCULATION_INCOMPLETE');
  await commitImport(path, await prepareImport(path, '2026-01,natural_gas,0,m3'));
  const saved = await save(path);
  assert.equal(saved.status, 201);
  assert.equal(saved.body.result.totalKgCO2e, '0');
  assert.equal((await save(path, 'customer', {from: ['2026-01']})).status, 400);
  assert.equal((await save(path, 'customer', {factor: 'forged'})).status, 400);
  assert.equal((await save(path, 'reviewer')).status, 403);
  assert.equal((await save(path, 'customer', {orgId: randomUUID()})).status, 403);
  assert.equal((await read(path, saved.body.snapshotId, 'reviewer')).status, 403);
  assert.equal((await read(await newCase(), saved.body.snapshotId)).body.error.code, 'CALCULATION_SNAPSHOT_NOT_FOUND');
});
