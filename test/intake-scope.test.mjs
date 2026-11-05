import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { startDemo } from '../infra/demo-data.mjs';

let demo;
before(async () => { demo = await startDemo(); });
after(async () => { await demo?.close(); });

const product = {
  subjectType: 'product', subjectName: '示例电机', jurisdiction: '浙江', reportingYear: '2025', recipient: '采购方'
};
const building = {
  subjectType: 'facility', subjectName: '物业园区', jurisdiction: '上海', reportingYear: '2026', recipient: '内部管理团队'
};

function create({scenarioReleaseId = demo.scenarioReleaseId, ...fields} = {}) {
  return demo.dispatch('customer', 'POST', '/v1/customer/cases', {
    orgId: demo.orgId, scenarioReleaseId, purpose: '申报范围测试', ...fields
  });
}

test('intake scope persists through correction and review while the legacy and list shapes stay unchanged', async () => {
  const {orgId} = demo;
  const created = await create({scope: {...product, subjectName: ` ${product.subjectName} `}});
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.scope, product);
  const path = `/v1/customer/cases/${created.body.id}`;
  const professional = `/v1/professional/cases/${created.body.id}`;
  assert.deepEqual((await demo.dispatch('customer', 'GET', `${path}?orgId=${orgId}`)).body.scope, product);
  assert.equal((await demo.dispatch('reviewer', 'GET', `${professional}?orgId=${orgId}`)).status, 404);
  assert.equal((await demo.dispatch('customer', 'GET', `${path}?orgId=${randomUUID()}`)).status, 403);
  const listed = await demo.dispatch('customer', 'GET', `/v1/customer/cases?orgId=${orgId}`);
  assert.equal(Object.hasOwn(listed.body.cases.find(item => item.id === created.body.id), 'scope'), false);

  const submitted = await demo.dispatch('customer', 'POST', `${path}/submit`, {orgId, revision: 1});
  assert.deepEqual(submitted.body.scope, product);
  assert.deepEqual((await demo.dispatch('reviewer', 'GET', `${professional}?orgId=${orgId}`)).body.scope, product);
  const returned = await demo.dispatch('reviewer', 'POST', `${professional}/review`, {
    orgId, revision: 2, decision: 'returned', reason: '补充月度活动数据'
  });
  assert.deepEqual(returned.body.scope, product);
  const resubmitted = await demo.dispatch('customer', 'POST', `${path}/resubmit`, {
    orgId, revision: 3, correctionNote: '已补充活动数据'
  });
  assert.deepEqual(resubmitted.body.scope, product);
  const approved = await demo.dispatch('reviewer', 'POST', `${professional}/review`, {orgId, revision: 4, decision: 'approved'});
  assert.deepEqual(approved.body.scope, product);
  const history = await demo.dispatch('customer', 'GET', `${path}/history?orgId=${orgId}`);
  assert.deepEqual(history.body.events.map(item => item.action), ['created', 'submitted', 'returned', 'submitted', 'approved']);

  const legacy = await create();
  assert.equal(legacy.status, 201);
  assert.equal(Object.hasOwn(legacy.body, 'scope'), false);
  const legacyPath = `/v1/customer/cases/${legacy.body.id}`;
  assert.equal(Object.hasOwn((await demo.dispatch('customer', 'GET', `${legacyPath}?orgId=${orgId}`)).body, 'scope'), false);
  const legacySubmitted = await demo.dispatch('customer', 'POST', `${legacyPath}/submit`, {orgId, revision: 1});
  assert.equal(legacySubmitted.status, 200);
  assert.equal(Object.hasOwn(legacySubmitted.body, 'scope'), false);
});

test('scope accepts a second industry and rejects incomplete or invalid registration fields', async () => {
  const catalog = await demo.dispatch('customer', 'GET', `/v1/customer/scenarios?orgId=${demo.orgId}`);
  const scenarioReleaseId = catalog.body.items.find(item => item.code === 'building-inventory').id;
  const created = await create({scenarioReleaseId, scope: building});
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.scope, building);
  const {recipient, ...missingRecipient} = building;
  for (const scope of [null, [], {}, missingRecipient, {...building, extra: 'unsupported'},
    {...building, subjectType: 'supply_chain'}, {...building, reportingYear: 2026},
    {...building, reportingYear: '0000'}, {...building, reportingYear: '26'},
    {...building, recipient: ' '}, {...building, jurisdiction: '地'.repeat(81)},
    {...building, subjectName: '名'.repeat(121)}, {...building, recipient: '人'.repeat(121)}]) {
    const invalid = await create({scenarioReleaseId, scope});
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, 'INVALID_REQUEST');
  }
});
