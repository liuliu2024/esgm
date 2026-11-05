import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { createEmbeddedDatabase } from '../infra/embedded.mjs';
import { migrate } from '../infra/migrations.mjs';
import { createCarbonApi } from '../src/index.mjs';

const [tenant, foreignTenant, org, siblingOrg, foreignOrg, release,
  customer, peer, reviewer, siblingReviewer, foreignReviewer] =
  Array.from({length: 11}, () => randomUUID());
const customerPath = '/v1/customer/cases';
const reviewerPath = '/v1/professional/cases';
let db;
let api;

before(async () => {
  db = await createEmbeddedDatabase();
  await migrate(db.admin);
  await db.admin.transaction(async tx => {
    await tx.query('INSERT INTO carbon.workspace VALUES ($1, $2), ($3, $4)',
      [tenant, '第一租户', foreignTenant, '第二租户']);
    await tx.query('INSERT INTO carbon.organization VALUES ($1, $2, $3), ($1, $4, $5), ($6, $7, $8)',
      [tenant, org, '受理组织', siblingOrg, '同租户其他组织', foreignTenant, foreignOrg, '其他租户组织']);
    await tx.query("INSERT INTO carbon.scenario_release VALUES ($1, $2, 'inventory', 1, '{}')", [tenant, release]);
    for (const [workspace, organization, actor, role] of [
      [tenant, org, customer, 'customer'], [tenant, org, peer, 'customer'], [tenant, org, reviewer, 'reviewer'],
      [tenant, siblingOrg, siblingReviewer, 'reviewer'], [foreignTenant, foreignOrg, foreignReviewer, 'reviewer']
    ]) {
      await tx.query('INSERT INTO carbon.org_grant VALUES ($1, $2, $3, $4)', [workspace, organization, actor, role]);
    }
  });
  api = createCarbonApi(db.runtime);
});

after(async () => { await db?.close(); });

function send(method, path, actorId, body, tenantId = tenant) {
  return api.dispatch({method, path, body}, {tenantId, actorId, requestId: randomUUID()});
}

async function create() {
  const response = await send('POST', customerPath, customer, {
    orgId: org, scenarioReleaseId: release, purpose: '组织碳盘查受理'
  });
  assert.equal(response.status, 201);
  return response.body.id;
}

function expectError(response, status, code) {
  assert.equal(response.status, status);
  assert.deepEqual(Object.keys(response.body), ['error']);
  assert.equal(response.body.error.code, code);
}

test('draft and returned intake can register pending materials without changing intake revision or history', async () => {
  const id = await create();
  const evidence = `${customerPath}/${id}/evidence`;
  const details = `${customerPath}/${id}?orgId=${org}`;
  const history = `${customerPath}/${id}/history?orgId=${org}`;
  const reviewerEvidence = `${reviewerPath}/${id}/evidence?orgId=${org}`;
  const register = (title, sourceDescription, actor = customer) =>
    send('POST', evidence, actor, {orgId: org, title, sourceDescription});
  const draftHistory = await send('GET', history, customer);
  assert.equal(draftHistory.status, 200);
  const first = await register('  能源账单  ', '  财务部台账  ');
  assert.equal(first.status, 201);
  assert.deepEqual(first.body, {
    id: first.body.id, caseId: id, orgId: org, registeredBy: customer, title: '能源账单',
    sourceDescription: '财务部台账', createdAt: first.body.createdAt, status: 'pending_file'
  });
  assert.ok(Number.isFinite(new Date(first.body.createdAt).getTime()));
  assert.deepEqual(await send('GET', `${evidence}?orgId=${org}`, customer), {
    status: 200, body: {items: [first.body]}
  });
  expectError(await send('GET', reviewerEvidence, reviewer), 404, 'CASE_NOT_FOUND');
  assert.equal((await send('GET', details, customer)).body.revision, 1);
  assert.deepEqual((await send('GET', history, customer)).body.events, draftHistory.body.events);

  assert.equal((await send('POST', `${customerPath}/${id}/submit`, customer, {orgId: org, revision: 1})).status, 200);
  assert.deepEqual(await send('GET', reviewerEvidence, reviewer), {status: 200, body: {items: [first.body]}});
  expectError(await register('迟交材料', '提交后的补件'), 409, 'CASE_CONFLICT');
  assert.equal((await send('POST', `${reviewerPath}/${id}/review`, reviewer, {
    orgId: org, revision: 2, decision: 'returned', reason: '请补充计量表'
  })).status, 200);
  const returnedHistory = await send('GET', history, customer);
  assert.equal(returnedHistory.status, 200);
  const second = await register('电表计量表', '运维部台账');
  assert.equal(second.status, 201);
  assert.equal(second.body.status, 'pending_file');
  const returnedDetail = await send('GET', details, customer);
  assert.equal(returnedDetail.status, 200);
  assert.equal(returnedDetail.body.status, 'returned');
  assert.equal(returnedDetail.body.revision, 3);
  assert.deepEqual((await send('GET', history, customer)).body.events, returnedHistory.body.events);
  const expectedOrder = [first.body, second.body].sort((a, b) =>
    new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() || a.id.localeCompare(b.id));
  assert.deepEqual((await send('GET', reviewerEvidence, reviewer)).body.items, expectedOrder);
});

test('rejects forged and blank input and denies known IDs outside the visible intake scope', async () => {
  const id = await create();
  const evidence = `${customerPath}/${id}/evidence`;
  const valid = {orgId: org, title: '能源账单', sourceDescription: '财务部台账'};
  expectError(await send('POST', evidence, customer, {...valid, status: 'verified'}), 400, 'INVALID_REQUEST');
  expectError(await send('POST', evidence, customer, {...valid, title: ' \t '}), 400, 'INVALID_REQUEST');
  expectError(await send('POST', evidence, customer, {...valid, sourceDescription: ' '}), 400, 'INVALID_REQUEST');
  expectError(await send('POST', evidence, peer, valid), 404, 'CASE_NOT_FOUND');
  assert.deepEqual((await send('GET', `${evidence}?orgId=${org}`, customer)).body.items, []);
  assert.equal((await send('POST', evidence, customer, valid)).status, 201);
  assert.equal((await send('POST', `${customerPath}/${id}/submit`, customer, {orgId: org, revision: 1})).status, 200);
  expectError(await send('GET', `${evidence}?orgId=${org}`, peer), 404, 'CASE_NOT_FOUND');
  const reviewEvidence = `${reviewerPath}/${id}/evidence`;
  expectError(await send('GET', `${reviewEvidence}?orgId=${org}`, siblingReviewer), 403, 'ACCESS_DENIED');
  expectError(await send('GET', `${reviewEvidence}?orgId=${siblingOrg}`, siblingReviewer), 404, 'CASE_NOT_FOUND');
  expectError(await send('GET', `${reviewEvidence}?orgId=${foreignOrg}`,
    foreignReviewer, undefined, foreignTenant), 404, 'CASE_NOT_FOUND');
});

test('the database denies application updates and keeps registrations immutable for privileged writes', async () => {
  const caseId = await create();
  const created = await send('POST', `${customerPath}/${caseId}/evidence`, customer,
    {orgId: org, title: '能源账单', sourceDescription: '财务部台账'});
  assert.equal(created.status, 201);
  const mutation = tx => tx.query('UPDATE carbon.case_evidence SET title = $2 WHERE id = $1',
    [created.body.id, '改写材料']);
  await assert.rejects(db.runtime.transaction(async tx => {
    await tx.query("SELECT set_config('carbon.tenant_id', $1, true), set_config('carbon.actor_id', $2, true)", [tenant, customer]);
    await mutation(tx);
  }), {code: '42501'});
  await assert.rejects(db.admin.transaction(mutation), {code: '55000'});
  await assert.rejects(db.admin.transaction(tx => tx.query('DELETE FROM carbon.case_evidence WHERE id = $1',
    [created.body.id])), {code: '55000'});
  assert.deepEqual((await send('GET', `${customerPath}/${caseId}/evidence?orgId=${org}`, customer)).body.items,
    [created.body]);
});
