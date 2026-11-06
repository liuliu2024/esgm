import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { startDemo } from '../infra/demo-data.mjs';

const header = 'period,source,quantity,unit\n';
let demo;

before(async () => { demo = await startDemo(); });
after(async () => { await demo?.close(); });

async function newCase() {
  const {orgId, scenarioReleaseId} = demo;
  const response = await demo.dispatch('customer', 'POST', '/v1/customer/cases', {orgId, scenarioReleaseId, purpose: '活动台账'});
  assert.equal(response.status, 201);
  return `/v1/customer/cases/${response.body.id}`;
}

async function save(path, csv) {
  const response = await demo.dispatch('customer', 'POST', `${path}/imports`, {orgId: demo.orgId, csv: header + csv});
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body;
}

function act(path, batch, action, previewRevision = batch.previewRevision) {
  return demo.dispatch('customer', 'POST', `${path}/imports/${batch.batchId}/${action}`, {orgId: demo.orgId, previewRevision});
}

test('activity import pins baselines, rolls back stale batches and records exact, idempotent revisions', async () => {
  const path = await newCase();
  const firstSource = '2026-01,electricity,1,MWh\n2026-01,natural_gas,0,m3';
  const first = await save(path, firstSource);
  assert.deepEqual(await save(path, firstSource), first);
  const competing = await save(path, '2026-01,electricity,1300,kWh\n2026-02,natural_gas,1,m3');
  assert.deepEqual(competing.preview.map(({action, baseRevision}) => [action, baseRevision]), [['insert', null], ['insert', null]]);

  const committed = await act(path, first, 'commit');
  assert.equal(committed.status, 200, JSON.stringify(committed.body));
  assert.equal(committed.body.inserted, 2);
  assert.deepEqual(await act(path, first, 'commit'), committed);
  assert.deepEqual((await save(path, firstSource)).receipt, committed.body);
  const stale = await act(path, competing, 'commit');
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'IMPORT_STALE_BASELINE');

  const sameAmount = await save(path, '2026-01,electricity,1000,kWh');
  assert.deepEqual(sameAmount.preview.map(({action, baseRevision}) => [action, baseRevision]), [['unchanged', 1]]);
  assert.equal((await act(path, sameAmount, 'commit')).body.unchanged, 1);
  const rerun = await act(path, competing, 'repreview');
  assert.equal(rerun.status, 200, JSON.stringify(rerun.body));
  assert.equal(rerun.body.previewRevision, 2);
  assert.deepEqual(rerun.body.preview.map(({action, baseRevision, baseQuantity}) => [action, baseRevision, baseQuantity]),
    [['correct', 1, '1000'], ['insert', null, null]]);
  assert.equal((await act(path, competing, 'repreview')).body.error.code, 'IMPORT_STALE_PREVIEW');
  assert.equal((await act(path, competing, 'commit')).body.error.code, 'IMPORT_STALE_PREVIEW');
  const updated = await act(path, rerun.body, 'commit');
  assert.equal(updated.status, 200);
  assert.deepEqual([updated.body.inserted, updated.body.corrected, updated.body.unchanged], [1, 1, 0]);
  assert.equal((await save(path, '2026-01,electricity,1300.0,kWh')).preview[0].baseRevision, 2);
});

test('blocked imports cannot enter the ledger and stored receipts remain readable after submission', async () => {
  const path = await newCase();
  const {orgId} = demo;
  const invalid = await save(path, '2026-01,natural_gas,,m3');
  assert.equal(invalid.status, 'blocked');
  assert.equal((await act(path, invalid, 'commit')).body.error.code, 'IMPORT_BLOCKED');
  const batch = await save(path, '2026-01,natural_gas,0,m3');
  const receipt = await act(path, batch, 'commit');
  assert.equal(receipt.status, 200);
  const url = `${path}/imports/${batch.batchId}?orgId=${orgId}`;
  assert.equal((await demo.dispatch('reviewer', 'GET', url)).status, 403);
  assert.equal((await demo.dispatch('customer', 'GET', `${path}/imports/${randomUUID()}?orgId=${orgId}`)).status, 404);
  assert.equal((await demo.dispatch('customer', 'POST', `${path}/submit`, {orgId, revision: 1})).status, 200);
  assert.deepEqual((await demo.dispatch('customer', 'GET', url)).body.receipt, receipt.body);
  assert.deepEqual(await act(path, batch, 'commit'), receipt);
  assert.equal((await act(path, invalid, 'commit')).body.error.code, 'CASE_CONFLICT');
  assert.equal((await demo.dispatch('customer', 'POST', `${path}/imports`, {orgId, csv: `${header}2026-02,natural_gas,0,m3`})).status, 409);
});
