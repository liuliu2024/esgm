import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { startDemo } from '../infra/demo-data.mjs';
import { previewActivityCsv } from '../src/activity-preview.mjs';

const header = 'period,source,quantity,unit';

test('activity preview distinguishes zero and missing values and converts MWh as an exact decimal', () => {
  const result = previewActivityCsv(`\ufeff${header}\r\n2026-01,electricity,"1.0000000000000000001",MWh\r\n` +
    '2026-02,electricity,0,kWh\r\n\r\n2026-02,natural_gas,,m3\r\n2026-03,natural_gas,001.250,m3');
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.summary, {totalRows: 4, validRows: 3, blockedRows: 1});
  assert.deepEqual(result.preview.map(({row, originalQuantity, originalUnit, quantity, unit}) =>
    [row, originalQuantity, originalUnit, quantity, unit]), [
    [2, '1.0000000000000000001', 'MWh', '1000.0000000000000001', 'kWh'],
    [3, '0', 'kWh', '0', 'kWh'],
    [6, '001.250', 'm3', '1.25', 'm3']
  ]);
  assert.deepEqual(result.issues.map(({row, column, code, severity}) => [row, column, code, severity]),
    [[5, 'quantity', 'MISSING_QUANTITY', 'error']]);
  assert.equal(previewActivityCsv(`${header}\n2026-01,electricity,1,MWh`).preview[0].quantity,
    previewActivityCsv(`${header}\n2026-01,electricity,1000,kWh`).preview[0].quantity);
});

test('activity preview blocks bad formats and duplicates with row and column positions', () => {
  const result = previewActivityCsv(`${header}\n2026-01,electricity,1,kWh\n2026-01,electricity,1,MWh\n` +
    '2026-13,natural_gas,1e3,kWh\n2026-02,"unknown\nsource",1,m3\n2026-03,electricity,1');
  assert.deepEqual(result.issues.map(({row, column, code}) => [row, column, code]), [
    [3, 'source', 'DUPLICATE_ACTIVITY'], [4, 'period', 'INVALID_PERIOD'],
    [4, 'quantity', 'INVALID_QUANTITY'], [4, 'unit', 'INVALID_UNIT'],
    [5, 'source', 'INVALID_SOURCE'], [7, 'record', 'INVALID_COLUMN_COUNT']
  ]);
  assert.equal(previewActivityCsv(`${header}\n2026-01,electricity,"unterminated`).issues[0].code, 'INVALID_CSV');
  assert.equal(previewActivityCsv('period,source,quantity').issues[0].code, 'INVALID_HEADER');
  assert.equal(previewActivityCsv(header).issues[0].code, 'EMPTY_ACTIVITY');
});

test('only the editable case owner can precheck activity and preview does not change the case', async t => {
  const demo = await startDemo();
  t.after(() => demo.close());
  const {orgId, scenarioReleaseId} = demo;
  const created = await demo.dispatch('customer', 'POST', '/v1/customer/cases', {
    orgId, scenarioReleaseId, purpose: '预检测试'
  });
  assert.equal(created.status, 201);
  const casePath = `/v1/customer/cases/${created.body.id}`;
  const url = `${casePath}/imports/preview`;
  const body = {orgId, csv: `${header}\n2026-01,electricity,0,kWh`};
  assert.equal((await demo.dispatch('reviewer', 'POST', url, body)).status, 403);
  assert.equal((await demo.dispatch('customer', 'POST', url, {...body, orgId: randomUUID()})).status, 403);
  assert.equal((await demo.dispatch('customer', 'POST', url, {...body, csv: '量'.repeat(2731)})).status, 413);
  assert.equal((await demo.dispatch('customer', 'POST', url, {...body, csv: []})).status, 400);
  const preview = await demo.dispatch('customer', 'POST', url, body);
  assert.equal(preview.status, 200);
  assert.equal(preview.body.status, 'ready');
  assert.equal(Object.hasOwn(preview.body, 'batchId'), false);
  const read = await demo.dispatch('customer', 'GET', `${casePath}?orgId=${orgId}`);
  assert.deepEqual(read.body, created.body);
  assert.equal((await demo.dispatch('customer', 'POST', `${casePath}/submit`, {orgId, revision: 1})).status, 200);
  assert.equal((await demo.dispatch('customer', 'POST', url, body)).status, 409);
});
