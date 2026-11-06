import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createEmbeddedDatabase } from '../infra/embedded.mjs';
import { migrate } from '../infra/migrations.mjs';
import { createCarbonApi } from '../src/index.mjs';

test('controlled internal report freezes its submission and uses the independent review workflow', async t => {
  const [tenantId, orgId, release, owner, reviewer, peer] = Array.from({length: 6}, () => randomUUID());
  const db = await createEmbeddedDatabase();
  t.after(() => db.close());
  await migrate(db.admin);
  await db.admin.transaction(async tx => {
    await tx.query("INSERT INTO carbon.workspace VALUES ($1, 'Controlled reports')", [tenantId]);
    await tx.query("INSERT INTO carbon.organization VALUES ($1, $2, 'Primary')", [tenantId, orgId]);
    await tx.query("INSERT INTO carbon.scenario_release VALUES ($1, $2, 'inventory', 1, '{}')", [tenantId, release]);
    await tx.query(`INSERT INTO carbon.org_grant VALUES ($1, $2, $3, 'customer'), ($1, $2, $3, 'reviewer'),
      ($1, $2, $4, 'reviewer'), ($1, $2, $5, 'customer')`, [tenantId, orgId, owner, reviewer, peer]);
  });
  const api = createCarbonApi(db.runtime);
  async function request(status, method, path, body, actorId = owner) {
    const result = await api.dispatch({method, path, body}, {tenantId, actorId, requestId: randomUUID()});
    assert.equal(result.status, status, JSON.stringify(result.body));
    return result.body;
  }
  const task = await request(201, 'POST', '/v1/customer/cases', {
    orgId, scenarioReleaseId: release, purpose: '用电内部管理稿'
  });
  const customer = `/v1/customer/cases/${task.id}`;
  const professional = `/v1/professional/cases/${task.id}`;
  const drafts = `${customer}/internal-report-drafts`;
  const professionalDrafts = `${professional}/internal-report-drafts`;
  const orgQuery = `?orgId=${orgId}`;
  const range = {orgId, from: '2024-01', to: '2024-02'};
  const generate = (status, revision, fields = range, actorId = owner) =>
    request(status, 'POST', `${customer}/revisions/${revision}/internal-report-drafts`, fields, actorId);
  const read = (status, draftId, actorId = owner) => request(status, 'GET', `${drafts}/${draftId}${orgQuery}`, undefined, actorId);
  const decide = revision => request(201, 'POST', `${professional}/revisions/${revision}/factor-decision`, {
    orgId, factorId: 'cn-electricity-product-average', factorVersion: 1, accountingBasis: 'product_footprint',
    regionCode: 'CN', dataYear: 2024, methodReference: '购电方法 1.0', rationale: '匹配 2024 年和全国因子'
  }, reviewer);
  async function commit(rows) {
    const batch = await request(200, 'POST', `${customer}/imports`, {
      orgId, csv: `period,source,quantity,unit\n${rows}`
    });
    await request(200, 'POST', `${customer}/imports/${batch.batchId}/commit`, {orgId, previewRevision: batch.previewRevision});
    return batch;
  }
  const first = await commit('2024-01,electricity,1,MWh\n2024-01,natural_gas,200,m3');
  await generate(409, 1);
  const syntheticSnapshot = await request(201, 'POST', `${customer}/calculation-snapshots`, {...range, to: range.from});
  const synthetic = await request(201, 'POST', drafts, {orgId, snapshotId: syntheticSnapshot.snapshotId});
  assert.equal(synthetic.mode, 'synthetic');
  assert.equal(synthetic.report.summary.totalKgCO2e, '900');
  const submission = await request(200, 'POST', `${customer}/submit`, {orgId, revision: task.revision});
  await generate(409, submission.revision);
  const {decision} = await decide(submission.revision);
  await generate(409, submission.revision, {...range, from: '2024-02'});
  await generate(404, submission.revision, range, peer);
  await generate(403, submission.revision, range, reviewer);
  await generate(400, submission.revision, {...range, externalDeliveryEligible: true});

  const draft = await generate(201, submission.revision);
  assert.equal(draft.mode, 'controlled');
  assert.equal(draft.status, 'draft');
  assert.equal(draft.formalReportEligible, false);
  assert.equal(draft.externalDeliveryEligible, false);
  assert.notEqual(draft.snapshotId, synthetic.snapshotId);
  assert.equal(draft.report.scope.submissionRevision, submission.revision);
  assert.deepEqual(draft.report.summary, {
    coverage: {status: 'partial', expectedSlots: 2, availableSlots: 1, missingSlots: 1},
    outputUnit: 'kgCO2e', knownSubtotalKg: '577.7', totalKg: null, totalT: null
  });
  assert.deepEqual(draft.report.factorDecision, decision);
  assert.deepEqual(draft.report.items.map(({status, emissionsKg}) => [status, emissionsKg]),
    [['calculated', '577.7'], ['missing_activity', null]]);
  assert.equal(draft.report.items[0].lineage.batchId, first.batchId);
  assert.deepEqual(await generate(200, submission.revision), draft);
  assert.deepEqual(await read(200, draft.draftId), draft);
  assert.deepEqual(await read(200, synthetic.draftId), synthetic);
  const history = await request(200, 'GET', drafts + orgQuery);
  assert.deepEqual(new Set(history.items.map(item => item.draftId)), new Set([draft.draftId, synthetic.draftId]));
  assert.equal(history.items.find(item => item.draftId === draft.draftId).mode, 'controlled');
  assert.equal(Object.hasOwn(history.items.find(item => item.draftId === synthetic.draftId), 'mode'), false);

  const review = `${professionalDrafts}/${draft.draftId}/review`;
  await request(404, 'GET', review + orgQuery, undefined, reviewer);
  await request(201, 'POST', `${drafts}/${draft.draftId}/submit-review`, {orgId});
  assert.equal((await request(403, 'GET', review + orgQuery)).error.code, 'SELF_REVIEW_FORBIDDEN');
  assert.deepEqual((await request(200, 'GET', review + orgQuery, undefined, reviewer)).draft, draft);
  const reviewed = await request(200, 'POST', review, {orgId, decision: 'reviewed'}, reviewer);
  assert.equal(reviewed.review.status, 'reviewed');
  assert.equal(reviewed.review.formalReportEligible, false);
  assert.equal(reviewed.review.externalDeliveryEligible, false);
  await request(201, 'POST', `${drafts}/${synthetic.draftId}/submit-review`, {orgId});
  const reviewQueue = await request(200, 'GET', professionalDrafts + orgQuery, undefined, reviewer);
  assert.equal(reviewQueue.items.find(item => item.draftId === draft.draftId).mode, 'controlled');
  assert.equal(Object.hasOwn(reviewQueue.items.find(item => item.draftId === synthetic.draftId), 'mode'), false);

  const pending = await generate(201, submission.revision, {...range, to: range.from});
  const unsent = await generate(201, submission.revision, {...range, from: '2023-12', to: range.from});
  const pendingReview = `${professionalDrafts}/${pending.draftId}/review`;
  await request(201, 'POST', `${drafts}/${pending.draftId}/submit-review`, {orgId});

  const returned = await request(200, 'POST', `${professional}/review`, {
    orgId, revision: submission.revision, decision: 'returned', reason: '补正用电量'
  }, reviewer);
  await generate(409, submission.revision);
  await commit('2024-01,electricity,2,MWh');
  const resubmitted = await request(200, 'POST', `${customer}/resubmit`, {
    orgId, revision: returned.revision, correctionNote: '更新活动量'
  });
  await decide(resubmitted.revision);
  await request(200, 'POST', `${professional}/review`, {orgId, revision: resubmitted.revision, decision: 'approved'}, reviewer);
  const corrected = await generate(201, resubmitted.revision, {...range, to: range.from});
  assert.equal(corrected.report.scope.submissionRevision, resubmitted.revision);
  assert.equal(corrected.report.summary.totalKg, '1155.4');
  assert.equal(corrected.report.summary.totalT, '1.1554');
  assert.notEqual(corrected.draftId, draft.draftId);
  assert.deepEqual(await read(200, draft.draftId), draft);
  await request(409, 'POST', pendingReview, {orgId, decision: 'reviewed'}, reviewer);
  await request(409, 'POST', `${drafts}/${unsent.draftId}/submit-review`, {orgId});
  assert.deepEqual((await request(200, 'GET', pendingReview + orgQuery, undefined, reviewer)).draft, pending);
  assert.deepEqual(await read(200, unsent.draftId), unsent);
  await generate(409, submission.revision);

  await db.admin.transaction(tx => tx.query('DELETE FROM carbon.org_grant WHERE tenant_id = $1 AND org_id = $2 AND actor_id = $3',
    [tenantId, orgId, reviewer]));
  await request(403, 'GET', review + orgQuery, undefined, reviewer);
  await db.admin.transaction(tx => tx.query(`DELETE FROM carbon.org_grant
    WHERE tenant_id = $1 AND org_id = $2 AND actor_id = $3 AND role = 'customer'`, [tenantId, orgId, owner]));
  await generate(403, resubmitted.revision);
});
