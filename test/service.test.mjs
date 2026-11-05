import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createEmbeddedDatabase } from '../infra/embedded.mjs';
import { migrate } from '../infra/migrations.mjs';
import { createCarbonApi } from '../src/index.mjs';

const id = value => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const [tenant, foreignTenant, org, siblingOrg, foreignOrg, release, foreignRelease,
  customer, reviewer, administrator, peer, siblingReviewer, foreignReviewer, revocableReviewer, foreignCustomer] =
  Array.from({length: 15}, (_, index) => id(index + 1));
const createPath = '/v1/customer/cases';
const auditPath = `/v1/admin/organizations/${org}/audit`;
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
    await tx.query(`INSERT INTO carbon.scenario_release VALUES
      ($1, $2, 'inventory', 1, '{}'), ($3, $4, 'inventory', 1, '{}')`,
    [tenant, release, foreignTenant, foreignRelease]);
    for (const [workspace, organization, actor, role] of [
      [tenant, org, customer, 'customer'], [tenant, org, customer, 'reviewer'],
      [tenant, org, reviewer, 'reviewer'], [tenant, org, administrator, 'admin'],
      [tenant, org, peer, 'customer'], [tenant, siblingOrg, siblingReviewer, 'reviewer'],
      [foreignTenant, foreignOrg, foreignReviewer, 'reviewer'], [tenant, org, revocableReviewer, 'reviewer'],
      [foreignTenant, foreignOrg, foreignCustomer, 'customer']
    ]) {
      await tx.query('INSERT INTO carbon.org_grant VALUES ($1, $2, $3, $4)', [workspace, organization, actor, role]);
    }
  });
  api = createCarbonApi(db.runtime);
});

after(async () => { await db?.close(); });

function send(method, path, actorId, requestId, body, tenantId = tenant) {
  return api.dispatch({method, path, body}, {actorId, tenantId, requestId});
}

async function draft(requestId) {
  const created = await send('POST', createPath, customer, requestId, {
    orgId: org, scenarioReleaseId: release, purpose: '  组织碳盘查受理  '
  });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body, {
    id: created.body.id, orgId: org, scenarioReleaseId: release, createdBy: customer,
    purpose: '组织碳盘查受理', status: 'draft', revision: 1, returnReason: null, correctionNote: null
  });
  return created.body.id;
}

function submit(caseId, requestId, actor = customer, revision = 1) {
  return send('POST', `${createPath}/${caseId}/submit`, actor, requestId, {orgId: org, revision});
}

function review(caseId, requestId, actor, decision, revision = 2, reason) {
  const body = {orgId: org, revision, decision};
  if (reason !== undefined) body.reason = reason;
  return send('POST', `/v1/professional/cases/${caseId}/review`, actor, requestId, body);
}

async function history(caseId) {
  const response = await send('GET', auditPath, administrator, 'read-audit');
  assert.equal(response.status, 200);
  return response.body.events.filter(event => event.caseId === caseId).sort((a, b) => a.revision - b.revision);
}

test('activity precheck does not change audit and denies customers outside the case', async () => {
  const caseId = await draft('preview-create');
  const url = `${createPath}/${caseId}/imports/preview`;
  const csv = 'period,source,quantity,unit\n2026-01,electricity,0,kWh';
  const original = await history(caseId);
  expectError(await send('POST', url, peer, 'preview-peer', {orgId: org, csv}), 404, 'CASE_NOT_FOUND');
  expectError(await send('POST', url, foreignCustomer, 'preview-foreign', {orgId: foreignOrg, csv}, foreignTenant),
    404, 'CASE_NOT_FOUND');
  const preview = await send('POST', url, customer, 'preview-own', {orgId: org, csv});
  assert.equal(preview.status, 200);
  assert.equal(preview.body.status, 'ready');
  assert.deepEqual(await history(caseId), original);
});

function expectError(response, status, code) {
  assert.equal(response.status, status);
  assert.deepEqual(Object.keys(response.body), ['error']);
  assert.equal(response.body.error.code, code);
  assert.equal(typeof response.body.error.message, 'string');
}

test('customer submits a fixed scenario and an independent reviewer approves, with scoped audit', async () => {
  const caseId = await draft('approve-create');
  const professional = `/v1/professional/cases/${caseId}?orgId=${org}`;
  expectError(await send('GET', professional, reviewer, 'inspect-draft'), 404, 'CASE_NOT_FOUND');
  const submitted = await submit(caseId, 'approve-submit');
  assert.equal(submitted.status, 200);
  assert.equal(submitted.body.status, 'submitted');
  assert.equal(submitted.body.revision, 2);
  const visible = await send('GET', professional, reviewer, 'inspect-submission');
  assert.equal(visible.status, 200);
  assert.equal(visible.body.scenarioReleaseId, release);
  const approved = await review(caseId, 'approve-review', reviewer, 'approved');
  assert.equal(approved.status, 200);
  assert.equal(approved.body.status, 'approved');
  assert.equal(approved.body.revision, 3);
  assert.deepEqual((await history(caseId)).map(({action, actorId, revision, requestId}) => [
    action, actorId, revision, requestId
  ]), [
    ['created', customer, 1, 'approve-create'],
    ['submitted', customer, 2, 'approve-submit'],
    ['approved', reviewer, 3, 'approve-review']
  ]);
  const limited = await send('GET', `${auditPath}?limit=1`, administrator, 'audit-page');
  assert.equal(limited.status, 200);
  assert.equal(limited.body.events.length, 1);
  assert.equal(limited.body.nextOffset, 1);
  expectError(await send('GET', auditPath, reviewer, 'reviewer-reads-audit'), 403, 'ACCESS_DENIED');
});

test('independent reviewer returns a case with a reason visible to customer and in audit', async () => {
  const caseId = await draft('return-create');
  assert.equal((await submit(caseId, 'return-submit')).status, 200);
  expectError(await review(caseId, 'return-missing-reason', reviewer, 'returned'), 400, 'INVALID_REQUEST');
  expectError(await review(caseId, 'return-blank-reason', reviewer, 'returned', 2, '  '), 400, 'INVALID_REQUEST');
  expectError(await review(caseId, 'approve-with-reason', reviewer, 'approved', 2, '退回理由不适用于批准'), 400, 'INVALID_REQUEST');
  const reason = '补齐申请材料中的核算期间';
  const returned = await review(caseId, 'return-review', reviewer, 'returned', 2, reason);
  assert.equal(returned.status, 200);
  assert.equal(returned.body.status, 'returned');
  assert.equal(returned.body.revision, 3);
  assert.equal(returned.body.returnReason, reason);
  const customerView = await send('GET', `${createPath}/${caseId}?orgId=${org}`, customer, 'read-return');
  assert.equal(customerView.status, 200);
  assert.equal(customerView.body.returnReason, reason);
  assert.equal(customerView.body.scenarioReleaseId, release);
  const events = await history(caseId);
  assert.deepEqual(events.map(event => event.action), ['created', 'submitted', 'returned']);
  assert.equal(events[2].reason, reason);
});

test('known IDs do not bypass organization, tenant, creator or independent-review boundaries', async () => {
  const caseId = await draft('isolation-create');
  expectError(await submit(caseId, 'peer-submit', peer), 404, 'CASE_NOT_FOUND');
  expectError(await submit(caseId, 'admin-submit', administrator), 403, 'ACCESS_DENIED');
  assert.equal((await submit(caseId, 'isolation-submit')).status, 200);
  expectError(await review(caseId, 'self-review', customer, 'approved'), 403, 'SELF_REVIEW_FORBIDDEN');
  expectError(await review(caseId, 'admin-review', administrator, 'approved'), 403, 'ACCESS_DENIED');
  expectError(await review(caseId, 'sibling-review', siblingReviewer, 'approved'), 403, 'ACCESS_DENIED');
  const reviewPath = `/v1/professional/cases/${caseId}/review`;
  expectError(await send('POST', reviewPath, siblingReviewer, 'sibling-id-review', {
    orgId: siblingOrg, revision: 2, decision: 'approved'
  }), 404, 'CASE_NOT_FOUND');
  expectError(await send('POST', reviewPath, foreignReviewer, 'foreign-id-review', {
    orgId: foreignOrg, revision: 2, decision: 'approved'
  }, foreignTenant), 404, 'CASE_NOT_FOUND');
  expectError(await send('GET', `/v1/professional/cases/${caseId}?orgId=${foreignOrg}`,
    foreignReviewer, 'foreign-id-read', undefined, foreignTenant), 404, 'CASE_NOT_FOUND');
  expectError(await send('POST', createPath, customer, 'foreign-release', {
    orgId: org, scenarioReleaseId: foreignRelease, purpose: '不可跨租户引用场景'
  }), 404, 'SCENARIO_NOT_FOUND');
  assert.deepEqual((await history(caseId)).map(event => event.action), ['created', 'submitted']);
});

test('stale revisions and repeat decisions leave one success event per transition', async () => {
  const caseId = await draft('stale-create');
  assert.equal((await submit(caseId, 'stale-submit')).status, 200);
  expectError(await submit(caseId, 'repeat-submit'), 409, 'CASE_CONFLICT');
  expectError(await review(caseId, 'stale-review', reviewer, 'approved', 1), 409, 'CASE_CONFLICT');
  assert.equal((await review(caseId, 'stale-approve', reviewer, 'approved')).status, 200);
  expectError(await review(caseId, 'repeat-review', reviewer, 'approved'), 409, 'CASE_CONFLICT');
  assert.deepEqual((await history(caseId)).map(event => event.requestId), ['stale-create', 'stale-submit', 'stale-approve']);
});

test('a reviewer loses read and review access after its organization grant is removed', async () => {
  const caseId = await draft('revoke-create');
  assert.equal((await submit(caseId, 'revoke-submit')).status, 200);
  const detail = `/v1/professional/cases/${caseId}?orgId=${org}`;
  assert.equal((await send('GET', detail, revocableReviewer, 'read-before-revoke')).status, 200);
  await db.admin.transaction(tx => tx.query(
    'DELETE FROM carbon.org_grant WHERE tenant_id = $1 AND org_id = $2 AND actor_id = $3 AND role = $4',
    [tenant, org, revocableReviewer, 'reviewer']
  ));
  expectError(await send('GET', detail, revocableReviewer, 'read-after-revoke'), 403, 'ACCESS_DENIED');
  expectError(await review(caseId, 'review-after-revoke', revocableReviewer, 'approved'), 403, 'ACCESS_DENIED');
  assert.deepEqual((await history(caseId)).map(event => event.action), ['created', 'submitted']);
});

test('rejects a spoofed body role and requires trusted context', async () => {
  expectError(await send('POST', createPath, customer, 'spoof-role', {
    orgId: org, scenarioReleaseId: release, purpose: '组织碳盘查受理', role: 'admin'
  }), 400, 'INVALID_REQUEST');
  expectError(await api.dispatch({method: 'GET', path: auditPath, headers: {
    'x-actor-id': administrator, 'x-tenant-id': tenant, 'x-role': 'admin'
  }}), 401, 'AUTHENTICATION_REQUIRED');
});
