import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { createEmbeddedDatabase } from '../infra/embedded.mjs';
import { migrate } from '../infra/migrations.mjs';
import { createCarbonApi } from '../src/index.mjs';

const [tenant, org, otherOrg, release, customer, peer, reviewer, otherReviewer] =
  Array.from({length: 8}, () => randomUUID());
const customerPath = '/v1/customer/cases';
const reviewPath = '/v1/professional/cases';
let db;
let api;

before(async () => {
  db = await createEmbeddedDatabase();
  await migrate(db.admin);
  await db.admin.transaction(async tx => {
    await tx.query('INSERT INTO carbon.workspace VALUES ($1, $2)', [tenant, '企业工作区']);
    await tx.query('INSERT INTO carbon.organization VALUES ($1, $2, $3), ($1, $4, $5)',
      [tenant, org, '受理组织', otherOrg, '同租户其他组织']);
    await tx.query("INSERT INTO carbon.scenario_release VALUES ($1, $2, 'inventory', 1, '{}')", [tenant, release]);
    for (const [organization, actor, role] of [
      [org, customer, 'customer'], [org, customer, 'reviewer'], [org, peer, 'customer'],
      [org, reviewer, 'reviewer'], [otherOrg, otherReviewer, 'reviewer']
    ]) {
      await tx.query('INSERT INTO carbon.org_grant VALUES ($1, $2, $3, $4)', [tenant, organization, actor, role]);
    }
  });
  api = createCarbonApi(db.runtime);
});

after(async () => { await db?.close(); });

function send(method, path, actorId, body) {
  return api.dispatch({method, path, body}, {actorId, tenantId: tenant, requestId: randomUUID()});
}

async function create(actor = customer) {
  const response = await send('POST', customerPath, actor, {
    orgId: org, scenarioReleaseId: release, purpose: '组织碳盘查受理'
  });
  assert.equal(response.status, 201);
  return response.body.id;
}

function submit(id, actor = customer) {
  return send('POST', `${customerPath}/${id}/submit`, actor, {orgId: org, revision: 1});
}

function review(id, revision, decision, reason, actor = reviewer) {
  const body = {orgId: org, revision, decision};
  if (reason !== undefined) body.reason = reason;
  return send('POST', `${reviewPath}/${id}/review`, actor, body);
}

function resubmit(id, revision, correctionNote, actor = customer) {
  return send('POST', `${customerPath}/${id}/resubmit`, actor, {orgId: org, revision, correctionNote});
}

function history(path, id, actor, organization = org) {
  return send('GET', `${path}/${id}/history?orgId=${organization}`, actor);
}

function expectError(response, status, code) {
  assert.equal(response.status, status);
  assert.deepEqual(Object.keys(response.body), ['error']);
  assert.equal(response.body.error.code, code);
}

test('two correction cycles retain each return and resubmission before independent approval', async () => {
  const id = await create();
  expectError(await history(reviewPath, id, reviewer), 404, 'CASE_NOT_FOUND');
  expectError(await resubmit(id, 1, '草稿不能补正'), 409, 'CASE_CONFLICT');
  assert.equal((await submit(id)).status, 200);

  const firstReturn = await review(id, 2, 'returned', '请补齐核算期间');
  assert.equal(firstReturn.status, 200);
  assert.equal(firstReturn.body.revision, 3);
  assert.equal(firstReturn.body.returnReason, '请补齐核算期间');
  expectError(await resubmit(id, 3, '  '), 400, 'INVALID_REQUEST');
  expectError(await resubmit(id, 2, '历史版本不能补正'), 409, 'CASE_CONFLICT');
  expectError(await resubmit(id, 3, '他人不能补正', peer), 404, 'CASE_NOT_FOUND');
  const firstCorrection = await resubmit(id, 3, '  已补齐核算期间  ');
  assert.equal(firstCorrection.status, 200);
  assert.equal(firstCorrection.body.status, 'submitted');
  assert.equal(firstCorrection.body.revision, 4);
  assert.equal(firstCorrection.body.correctionNote, '已补齐核算期间');
  assert.equal(firstCorrection.body.returnReason, null);
  expectError(await resubmit(id, 3, '旧版本不可再次提交'), 409, 'CASE_CONFLICT');
  expectError(await review(id, 4, 'approved', undefined, customer), 403, 'SELF_REVIEW_FORBIDDEN');

  const secondReturn = await review(id, 4, 'returned', '请说明排放边界');
  assert.equal(secondReturn.status, 200);
  assert.equal(secondReturn.body.revision, 5);
  const secondCorrection = await resubmit(id, 5, '已补齐排放边界');
  assert.equal(secondCorrection.status, 200);
  assert.equal(secondCorrection.body.revision, 6);
  assert.equal(secondCorrection.body.correctionNote, '已补齐排放边界');
  const approved = await review(id, 6, 'approved');
  assert.equal(approved.status, 200);
  assert.equal(approved.body.status, 'approved');
  assert.equal(approved.body.revision, 7);
  assert.equal(approved.body.scenarioReleaseId, release);
  assert.equal(approved.body.purpose, '组织碳盘查受理');

  const customerHistory = await history(customerPath, id, customer);
  const reviewerHistory = await history(reviewPath, id, reviewer);
  assert.equal(customerHistory.status, 200);
  assert.equal(reviewerHistory.status, 200);
  assert.deepEqual(reviewerHistory.body.events, customerHistory.body.events);
  assert.deepEqual(customerHistory.body.events.map(event => [
    event.revision, event.action, event.actorId, event.reason, event.correctionNote
  ]), [
    [1, 'created', customer, null, null],
    [2, 'submitted', customer, null, null],
    [3, 'returned', reviewer, '请补齐核算期间', null],
    [4, 'submitted', customer, null, '已补齐核算期间'],
    [5, 'returned', reviewer, '请说明排放边界', null],
    [6, 'submitted', customer, null, '已补齐排放边界'],
    [7, 'approved', reviewer, null, null]
  ]);
  expectError(await history(customerPath, id, peer), 404, 'CASE_NOT_FOUND');
  expectError(await history(reviewPath, id, otherReviewer), 403, 'ACCESS_DENIED');
  expectError(await history(reviewPath, id, otherReviewer, otherOrg), 404, 'CASE_NOT_FOUND');
});

test('case lists use organization and actor scope with stable cursor pages', async () => {
  const ownDraft = await create();
  const peerDraft = await create(peer);
  const ownPending = await create();
  const peerPending = await create(peer);
  const ownReturned = await create();
  assert.equal((await submit(ownPending)).status, 200);
  assert.equal((await submit(peerPending, peer)).status, 200);
  assert.equal((await submit(ownReturned)).status, 200);
  assert.equal((await review(ownReturned, 2, 'returned', '请补齐边界')).status, 200);

  const customerList = await send('GET', `${customerPath}?orgId=${org}`, customer);
  assert.equal(customerList.status, 200);
  const own = new Map(customerList.body.cases.map(item => [item.id, item.nextAction]));
  assert.equal(own.get(ownDraft), 'submit');
  assert.equal(own.get(ownPending), 'none');
  assert.equal(own.get(ownReturned), 'resubmit');
  assert.equal(own.has(peerDraft), false);
  assert.equal(own.has(peerPending), false);

  const professionalList = `${reviewPath}?orgId=${org}`;
  const all = await send('GET', professionalList, reviewer);
  assert.equal(all.status, 200);
  assert.equal(all.body.nextCursor, null);
  assert.equal(all.body.cases.some(item => item.status === 'draft'), false);
  assert.deepEqual(all.body.cases.filter(item => item.nextAction === 'review').map(item => item.id).sort(),
    [ownPending, peerPending].sort());
  assert.deepEqual(all.body.cases.slice(0, 2).map(item => item.status), ['submitted', 'submitted']);

  const first = await send('GET', `${professionalList}&limit=1`, reviewer);
  assert.equal(first.status, 200);
  assert.equal(first.body.cases.length, 1);
  assert.match(first.body.nextCursor, /^0:/);
  const rest = await send('GET', `${professionalList}&cursor=${encodeURIComponent(first.body.nextCursor)}`, reviewer);
  assert.equal(rest.status, 200);
  assert.deepEqual([...first.body.cases, ...rest.body.cases].map(item => item.id), all.body.cases.map(item => item.id));
  assert.equal(rest.body.nextCursor, null);
  const dualRole = await send('GET', professionalList, customer);
  assert.equal(dualRole.status, 200);
  assert.equal(dualRole.body.cases[0].id, peerPending);
  assert.equal(dualRole.body.cases[0].nextAction, 'review');
  assert.equal(dualRole.body.cases.find(item => item.id === ownPending).nextAction, 'none');
  expectError(await send('GET', `${professionalList}&cursor=invalid`, reviewer), 400, 'INVALID_REQUEST');
  expectError(await send('GET', professionalList, otherReviewer), 403, 'ACCESS_DENIED');
  const elsewhere = await send('GET', `${reviewPath}?orgId=${otherOrg}`, otherReviewer);
  assert.equal(elsewhere.status, 200);
  assert.deepEqual(elsewhere.body, {cases: [], nextCursor: null});
});
