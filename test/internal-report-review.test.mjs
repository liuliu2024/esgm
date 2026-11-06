import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { createEmbeddedDatabase } from '../infra/embedded.mjs';
import { migrate } from '../infra/migrations.mjs';
import { createCarbonApi } from '../src/index.mjs';

const [tenantId, orgId, otherOrgId, releaseId, author, reviewer, peer, otherReviewer] =
  Array.from({length: 8}, () => randomUUID());
let db;
let api;

before(async () => {
  db = await createEmbeddedDatabase();
  await migrate(db.admin);
  await db.admin.transaction(async tx => {
    await tx.query("INSERT INTO carbon.workspace (id, name) VALUES ($1, 'Review tests')", [tenantId]);
    await tx.query(`INSERT INTO carbon.organization (tenant_id, id, name)
      VALUES ($1, $2, 'Primary'), ($1, $3, 'Other')`, [tenantId, orgId, otherOrgId]);
    await tx.query(`INSERT INTO carbon.scenario_release (tenant_id, id, code, version, manifest)
      VALUES ($1, $2, 'inventory', 1, '{}')`, [tenantId, releaseId]);
    await tx.query(`INSERT INTO carbon.org_grant (tenant_id, org_id, actor_id, role)
      VALUES ($1, $2, $3, 'customer'), ($1, $2, $3, 'reviewer'), ($1, $2, $4, 'reviewer'),
        ($1, $2, $5, 'customer'), ($1, $6, $7, 'reviewer')`,
    [tenantId, orgId, author, reviewer, peer, otherOrgId, otherReviewer]);
  });
  api = createCarbonApi(db.runtime);
});

after(async () => { await db?.close(); });

function dispatch(method, path, body, actorId = author) {
  return api.dispatch({method, path, body}, {tenantId, actorId, requestId: randomUUID()});
}

async function post(path, body, status, actorId = author) {
  const response = await dispatch('POST', path, body, actorId);
  assert.equal(response.status, status, JSON.stringify(response.body));
  return response.body;
}

function reviewPath(caseId, draftId, role = 'customer') {
  return `/v1/${role}/cases/${caseId}/internal-report-drafts/${draftId}/review`;
}

function submitReport(caseId, draftId, status, actorId = author) {
  return post(`/v1/customer/cases/${caseId}/internal-report-drafts/${draftId}/submit-review`, {orgId}, status, actorId);
}

function readReview(caseId, draftId, role = 'customer', actorId = author, organization = orgId) {
  return dispatch('GET', `${reviewPath(caseId, draftId, role)}?orgId=${organization}`, undefined, actorId);
}

function reviewCollection(caseId, query = '', actorId = reviewer) {
  return dispatch('GET', `/v1/professional/cases/${caseId}/internal-report-drafts?orgId=${orgId}${query}`, undefined, actorId);
}

async function newDraft(caseId, electricity) {
  const path = `/v1/customer/cases/${caseId}`;
  const batch = await post(`${path}/imports`, {
    orgId, csv: `period,source,quantity,unit\n2026-01,electricity,${electricity},kWh\n2026-01,natural_gas,200,m3`
  }, 200);
  await post(`${path}/imports/${batch.batchId}/commit`, {orgId, previewRevision: batch.previewRevision}, 200);
  const {snapshotId} = await post(`${path}/calculation-snapshots`, {orgId, from: '2026-01', to: '2026-01'}, 201);
  return post(`${path}/internal-report-drafts`, {orgId, snapshotId}, 201);
}

async function newCase() {
  return post('/v1/customer/cases', {orgId, scenarioReleaseId: releaseId, purpose: '演示稿独立复核'}, 201);
}

test('submitted report review reveals only the selected frozen draft and preserves its synthetic eligibility', async () => {
  const task = await newCase();
  const first = await newDraft(task.id, '1000');
  const second = await newDraft(task.id, '1200');
  const customer = `/v1/customer/cases/${task.id}`;
  const professional = reviewPath(task.id, first.draftId, 'professional');

  assert.equal((await readReview(task.id, first.draftId)).status, 404);
  assert.equal((await readReview(task.id, first.draftId, 'professional', reviewer)).status, 404);
  assert.equal((await submitReport(task.id, first.draftId, 409)).error.code, 'REPORT_REVIEW_CONFLICT');
  await post(`${customer}/submit`, {orgId, revision: task.revision}, 200);
  assert.deepEqual(await reviewCollection(task.id), {status: 200, body: {items: [], nextCursor: null}});
  assert.equal((await readReview(task.id, first.draftId, 'professional', reviewer)).status, 404);
  assert.equal((await post(professional, {orgId, decision: 'reviewed'}, 404, reviewer)).error.code, 'REPORT_REVIEW_NOT_FOUND');
  const historyUrl = `${customer}/history?orgId=${orgId}`;
  const before = await dispatch('GET', historyUrl);

  const submitted = await submitReport(task.id, first.draftId, 201);
  assert.equal(submitted.review.caseId, task.id);
  assert.equal(submitted.review.draftId, first.draftId);
  assert.equal(submitted.review.status, 'submitted');
  assert.equal(submitted.review.submittedBy, author);
  assert.equal(submitted.review.reviewedBy, null);
  assert.deepEqual(await submitReport(task.id, first.draftId, 200), submitted);
  assert.deepEqual(await readReview(task.id, first.draftId, 'professional', reviewer), {
    status: 200, body: {review: submitted.review, draft: first}
  });
  assert.equal((await readReview(task.id, second.draftId, 'professional', reviewer)).status, 404);
  const summary = {draftId: first.draftId, snapshotId: first.snapshotId, createdAt: first.createdAt,
    from: '2026-01', to: '2026-01', templateVersion: 1, reviewStatus: 'submitted'};
  assert.deepEqual(await reviewCollection(task.id), {status: 200, body: {items: [summary], nextCursor: null}});
  assert.deepEqual((await reviewCollection(task.id, `&cursor=${second.draftId}`)).body, {items: [], nextCursor: null});
  assert.equal((await reviewCollection(task.id, '', author)).body.error.code, 'SELF_REVIEW_FORBIDDEN');
  assert.equal((await readReview(task.id, first.draftId, 'customer', peer)).status, 404);
  assert.equal((await readReview(task.id, first.draftId, 'professional', otherReviewer, otherOrgId)).status, 404);
  assert.equal((await readReview(task.id, first.draftId, 'professional', otherReviewer)).status, 403);
  assert.equal((await post(professional, {orgId, decision: 'reviewed'}, 403)).error.code, 'SELF_REVIEW_FORBIDDEN');
  await post(professional, {orgId, decision: 'reviewed', externalDeliveryEligible: true}, 400, reviewer);

  const reviewed = await post(professional, {orgId, decision: 'reviewed'}, 200, reviewer);
  assert.equal(reviewed.review.status, 'reviewed');
  assert.equal(reviewed.review.reviewedBy, reviewer);
  assert.equal(reviewed.review.formalReportEligible, false);
  assert.equal(reviewed.review.externalDeliveryEligible, false);
  assert.deepEqual(await readReview(task.id, first.draftId), {status: 200, body: reviewed});
  assert.deepEqual(await submitReport(task.id, first.draftId, 200), reviewed);
  assert.deepEqual((await readReview(task.id, first.draftId, 'professional', reviewer)).body.draft, first);
  assert.deepEqual((await reviewCollection(task.id)).body.items, [{...summary, reviewStatus: 'reviewed'}]);
  await submitReport(task.id, second.draftId, 201);
  const page = await reviewCollection(task.id, '&limit=1');
  assert.equal(page.body.items[0].draftId, second.draftId);
  assert.equal(page.body.nextCursor, second.draftId);
  const nextPage = await reviewCollection(task.id, `&limit=1&cursor=${page.body.nextCursor}`);
  assert.deepEqual(nextPage.body, {items: [{...summary, reviewStatus: 'reviewed'}], nextCursor: null});
  assert.equal((await post(professional, {orgId, decision: 'reviewed'}, 409, reviewer)).error.code, 'REPORT_REVIEW_CONFLICT');
  assert.deepEqual(await dispatch('GET', historyUrl), before);
});

test('report return retains its reason and reviewer access follows the current grant', async () => {
  const task = await newCase();
  const draft = await newDraft(task.id, '1000');
  const otherDraft = await newDraft(task.id, '1200');
  const customerCase = `/v1/customer/cases/${task.id}`;
  const submitted = await post(`${customerCase}/submit`, {orgId, revision: task.revision}, 200);
  const submittedReport = await submitReport(task.id, draft.draftId, 201);
  const professional = reviewPath(task.id, draft.draftId, 'professional');
  const returnedCase = await post(`/v1/professional/cases/${task.id}/review`, {
    orgId, revision: submitted.revision, decision: 'returned', reason: '补充受理信息'
  }, 200, reviewer);
  assert.deepEqual(await submitReport(task.id, draft.draftId, 200), submittedReport);
  assert.equal((await submitReport(task.id, otherDraft.draftId, 409)).error.code, 'REPORT_REVIEW_CONFLICT');
  assert.equal((await post(professional, {orgId, decision: 'reviewed'}, 409, reviewer)).error.code, 'REPORT_REVIEW_CONFLICT');
  await post(`${customerCase}/resubmit`, {orgId, revision: returnedCase.revision, correctionNote: '已补充受理信息'}, 200);
  await post(professional, {orgId, decision: 'returned'}, 400, reviewer);
  await post(professional, {orgId, decision: 'returned', reason: '  '}, 400, reviewer);
  const returned = await post(professional, {orgId, decision: 'returned', reason: '核对原始凭据'}, 200, reviewer);
  assert.equal(returned.review.status, 'returned');
  assert.equal(returned.review.reason, '核对原始凭据');
  assert.equal(returned.review.externalDeliveryEligible, false);
  assert.deepEqual(await readReview(task.id, draft.draftId), {status: 200, body: returned});

  await db.admin.transaction(tx => tx.query(`DELETE FROM carbon.org_grant
    WHERE tenant_id = $1 AND org_id = $2 AND actor_id = $3 AND role = 'reviewer'`, [tenantId, orgId, reviewer]));
  assert.equal((await readReview(task.id, draft.draftId, 'professional', reviewer)).status, 403);
  assert.equal((await reviewCollection(task.id)).status, 403);
  await post(professional, {orgId, decision: 'reviewed'}, 403, reviewer);
});
