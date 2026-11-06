import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { startDemo } from '../infra/demo-data.mjs';
import { createEmbeddedDatabase } from '../infra/embedded.mjs';
import { migrate } from '../infra/migrations.mjs';
import { publishScenarioRule } from '../infra/publish-scenario-rule.mjs';
import { createCarbonApi } from '../src/index.mjs';

test('task rule decisions, independent publication and linked recalculation preserve the prior release', async t => {
  const [tenantId, orgId, releaseId, owner, reviewer, admin, peer, secondOrg] = Array.from({length: 8}, () => randomUUID());
  const db = await createEmbeddedDatabase();
  t.after(() => db.close());
  await migrate(db.admin);
  const references = ['effective', 'pilot', 'draft', 'unclassified'].map(publicationStatus => ({
    code: `test-${publicationStatus}`, title: `测试候选 ${publicationStatus}`, publisher: '测试发布方',
    sourceUrl: `https://example.test/rules/${publicationStatus}`, scopeNote: '测试规则范围', publicationStatus
  }));
  await db.admin.transaction(async tx => {
    await tx.query("INSERT INTO carbon.workspace VALUES ($1, 'Rules')", [tenantId]);
    await tx.query("INSERT INTO carbon.organization VALUES ($1, $2, 'Primary'), ($1, $3, 'Second')",
      [tenantId, orgId, secondOrg]);
    await tx.query("INSERT INTO carbon.scenario_release VALUES ($1, $2, 'rules-fixture', 1, $3)", [tenantId, releaseId, {
      catalog: {industryCode: 'manufacturing', industryName: '工业制造', title: '规则测试场景',
        purpose: '测试适用范围', recipient: '采购方'}, references
    }]);
    await tx.query(`INSERT INTO carbon.org_grant VALUES ($1, $2, $3, 'customer'), ($1, $2, $3, 'reviewer'),
      ($1, $2, $4, 'reviewer'), ($1, $2, $5, 'admin'), ($1, $2, $5, 'reviewer'), ($1, $2, $6, 'customer'),
      ($1, $7, $3, 'customer'), ($1, $7, $4, 'reviewer'), ($1, $7, $5, 'admin')`,
    [tenantId, orgId, owner, reviewer, admin, peer, secondOrg]);
  });
  const api = createCarbonApi(db.runtime);
  async function request(status, method, path, body, actorId = owner) {
    const result = await api.dispatch({method, path, body}, {tenantId, actorId, requestId: randomUUID()});
    assert.equal(result.status, status, `${method} ${path} ${JSON.stringify(result.body)}`);
    return result.body;
  }
  const query = `?orgId=${orgId}`;
  const scope = {subjectType: 'product', subjectName: '测试设备', jurisdiction: '上海市', reportingYear: '2024', recipient: '采购方'};
  const task = await request(201, 'POST', '/v1/customer/cases', {
    orgId, scenarioReleaseId: releaseId, purpose: '版本冻结测试', scope
  });
  const secondTask = await request(201, 'POST', '/v1/customer/cases', {
    orgId: secondOrg, scenarioReleaseId: releaseId, purpose: '第二组织版本测试', scope
  });
  const secondTaskPath = `/v1/customer/cases/${secondTask.id}`;
  const secondQuery = `?orgId=${secondOrg}`;
  await request(200, 'POST', `${secondTaskPath}/submit`, {orgId: secondOrg, revision: secondTask.revision});
  const customer = `/v1/customer/cases/${task.id}`;
  const professional = `/v1/professional/cases/${task.id}`;
  const assessment = `${customer}/rule-assessment${query}`;
  const scoped = await request(200, 'GET', assessment);
  assert.deepEqual(scoped.candidates, references);
  assert.equal(scoped.submissionRevision, null);
  assert.equal(scoped.status, 'needs_review');
  assert.equal(scoped.context.reportingYear, scope.reportingYear);
  await request(404, 'GET', `${professional}/rule-assessment${query}`, undefined, reviewer);
  await request(404, 'GET', assessment, undefined, peer);

  const batch = await request(200, 'POST', `${customer}/imports`, {
    orgId, csv: 'period,source,quantity,unit\n2024-01,electricity,1,MWh\n2024-01,natural_gas,200,m3'
  });
  await request(200, 'POST', `${customer}/imports/${batch.batchId}/commit`, {orgId, previewRevision: batch.previewRevision});
  const snapshot = await request(201, 'POST', `${customer}/calculation-snapshots`, {orgId, from: '2024-01', to: '2024-01'});
  const drafts = `${customer}/internal-report-drafts`;
  const report = await request(201, 'POST', drafts, {orgId, snapshotId: snapshot.snapshotId});
  const submitted = await request(200, 'POST', `${customer}/submit`, {orgId, revision: task.revision});
  const decide = (status, revision, referenceCode, actorId = reviewer) =>
    request(status, 'POST', `${professional}/revisions/${revision}/rule-assessment`, {
      orgId, status: 'confirmed', referenceCode, rationale: '已核对申报年度和场景'
    }, actorId);
  assert.equal((await decide(409, submitted.revision, 'test-draft')).error.code, 'RULE_REFERENCE_UNAVAILABLE');
  await decide(409, submitted.revision, 'test-unclassified');
  assert.equal((await decide(403, submitted.revision, 'test-effective', owner)).error.code, 'SELF_REVIEW_FORBIDDEN');
  await decide(403, submitted.revision, 'test-effective', peer);
  const effective = await decide(201, submitted.revision, 'test-effective');
  assert.equal(effective.decision.referenceCode, 'test-effective');
  assert.equal(effective.decision.decidedBy, reviewer);
  await decide(409, submitted.revision, 'test-pilot');
  const returned = await request(200, 'POST', `${professional}/review`, {
    orgId, revision: submitted.revision, decision: 'returned', reason: '补正材料'
  }, reviewer);
  const resubmitted = await request(200, 'POST', `${customer}/resubmit`, {
    orgId, revision: returned.revision, correctionNote: '已补正'
  });
  const latest = await request(200, 'GET', assessment);
  assert.equal(latest.submissionRevision, resubmitted.revision);
  assert.equal(latest.decision, null);
  await decide(409, submitted.revision, 'test-pilot');
  const pilot = await decide(201, resubmitted.revision, 'test-pilot');
  assert.equal(pilot.decision.referenceCode, 'test-pilot');
  assert.deepEqual((await request(200, 'GET', `${assessment}&revision=${submitted.revision}`)).decision, effective.decision);
  await request(201, 'POST', `${professional}/revisions/${resubmitted.revision}/factor-decision`, {
    orgId, factorId: 'cn-electricity-product-average', factorVersion: 1, accountingBasis: 'product_footprint',
    regionCode: 'CN', dataYear: 2024, methodReference: '测试核算方法', rationale: '测试范围与 2024 年因子一致'
  }, reviewer);

  const adminRoot = `/v1/admin/organizations/${orgId}`;
  const proposals = `${adminRoot}/rule-proposals`;
  const proposed = {scenarioReleaseId: releaseId, references: [
    {...references[0], publicationStatus: 'superseded'}, references[1], references[3],
    {...references[0], code: 'test-next', title: '新版依据'}
  ]};
  await request(403, 'POST', `${adminRoot}/rule-impact`, proposed, reviewer);
  const impact = await request(200, 'POST', `${adminRoot}/rule-impact`, proposed, admin);
  assert.deepEqual(Object.fromEntries(impact.changes.map(({code, type}) => [code, type])),
    {'test-effective': 'changed', 'test-draft': 'removed', 'test-next': 'added'});
  assert.deepEqual(impact.taskCounts, [{status: 'submitted', count: 1}]);
  assert.deepEqual(impact.dependencies, {factorCount: 1, modelCount: 1, reportCount: 1});
  const proposal = await request(201, 'POST', proposals, proposed, admin);
  const {proposalId} = proposal;
  const secondAdmin = `/v1/admin/organizations/${secondOrg}`;
  const secondProposed = {scenarioReleaseId: releaseId, references: [
    ...references, {...references[0], code: 'second-next', title: '第二组织新版依据'}
  ]};
  const secondProposal = await request(201, 'POST', `${secondAdmin}/rule-proposals`, secondProposed, admin);
  const publicationKey = {tenantId, orgId, proposalId};
  await assert.rejects(publishScenarioRule(db.admin, publicationKey), /approved proposal/);
  const queue = `/v1/professional/rule-proposals${query}`;
  assert.equal((await request(200, 'GET', queue, undefined, reviewer)).items.find(item => item.proposalId === proposalId).canReview, true);
  assert.equal((await request(200, 'GET', queue, undefined, admin)).items.find(item => item.proposalId === proposalId).canReview, false);
  const approve = `/v1/professional/rule-proposals/${proposalId}/review`;
  const approval = {orgId, decision: 'approved', reason: '独立核对变更'};
  await request(404, 'POST', approve, {...approval, orgId: secondOrg}, reviewer);
  assert.equal((await request(403, 'POST', approve, approval, admin)).error.code, 'SELF_REVIEW_FORBIDDEN');
  assert.equal((await request(200, 'POST', approve, approval, reviewer)).status, 'approved');
  const published = await publishScenarioRule(db.admin, publicationKey);
  assert.equal(published.version, 2);
  assert.equal(published.replayed, false);
  assert.deepEqual(await publishScenarioRule(db.admin, publicationKey), {...published, replayed: true});
  assert.equal((await request(200, 'GET', proposals, undefined, admin)).items.find(item => item.proposalId === proposalId).status, 'published');
  const catalog = await request(200, 'GET', `${adminRoot}/rule-catalog`, undefined, admin);
  assert.equal(catalog.items.find(item => item.code === 'rules-fixture').scenarioReleaseId, published.releaseId);
  const secondCatalog = await request(200, 'GET', `/v1/customer/scenarios${secondQuery}`);
  assert.equal(secondCatalog.items.find(item => item.code === 'rules-fixture').id, releaseId);
  const secondRuleCatalog = await request(200, 'GET', `${secondAdmin}/rule-catalog`, undefined, admin);
  assert.equal(secondRuleCatalog.items.find(item => item.code === 'rules-fixture').scenarioReleaseId, releaseId);
  const secondReferences = await request(200, 'GET', `/v1/customer/scenarios/${releaseId}/references${secondQuery}`);
  assert.deepEqual(secondReferences.items.map(item => item.code), references.map(item => item.code));
  await request(404, 'GET', `/v1/customer/scenarios/${published.releaseId}/references${secondQuery}`);
  await request(404, 'POST', '/v1/customer/cases', {
    orgId: secondOrg, scenarioReleaseId: published.releaseId, purpose: '尝试跨组织版本'
  });
  const secondProposals = await request(200, 'GET', `${secondAdmin}/rule-proposals`, undefined, admin);
  assert.deepEqual(secondProposals.items.map(item => item.proposalId), [secondProposal.proposalId]);
  await request(404, 'POST', `${secondAdmin}/rule-proposals`, {...proposed, scenarioReleaseId: published.releaseId}, admin);
  const secondAssessment = await request(200, 'GET', `${secondTaskPath}/rule-assessment${secondQuery}`);
  assert.equal(secondAssessment.recalculation, null);
  assert.deepEqual(secondAssessment.candidates, references);
  const secondRecalc = `${secondTaskPath}/rule-recalculation`;
  await request(409, 'POST', secondRecalc, {orgId: secondOrg, scenarioReleaseId: published.releaseId});
  await request(200, 'POST', `/v1/professional/rule-proposals/${secondProposal.proposalId}/review`,
    {...approval, orgId: secondOrg}, reviewer);
  const secondPublished = await publishScenarioRule(db.admin, {tenantId, orgId: secondOrg, proposalId: secondProposal.proposalId});
  assert.equal(secondPublished.version, 2);
  assert.notEqual(secondPublished.releaseId, published.releaseId);
  await request(404, 'GET', `/v1/customer/scenarios/${secondPublished.releaseId}/references${query}`);
  await request(409, 'POST', `${customer}/rule-recalculation`, {orgId, scenarioReleaseId: secondPublished.releaseId});
  const secondLinked = await request(201, 'POST', secondRecalc, {orgId: secondOrg, scenarioReleaseId: secondPublished.releaseId});
  assert.equal(secondLinked.ruleRecalculationOf, secondTask.id);

  const pinned = await request(200, 'GET', assessment);
  assert.equal(pinned.scenarioReleaseId, releaseId);
  assert.deepEqual(pinned.candidates, references);
  assert.deepEqual(pinned.decision, pilot.decision);
  assert.deepEqual(pinned.recalculation, {scenarioReleaseId: published.releaseId, scenarioVersion: 2});
  assert.deepEqual(await request(200, 'GET', `${drafts}/${report.draftId}${query}`), report);
  const recalc = `${customer}/rule-recalculation`;
  const target = {orgId, scenarioReleaseId: published.releaseId};
  await request(409, 'POST', recalc, {...target, scenarioReleaseId: releaseId});
  await request(404, 'POST', recalc, target, peer);
  const linked = await request(201, 'POST', recalc, target);
  assert.equal(linked.scenarioReleaseId, published.releaseId);
  assert.equal(linked.ruleRecalculationOf, task.id);
  assert.equal(linked.status, 'draft');
  assert.equal(linked.purpose, task.purpose);
  assert.deepEqual(linked.scope, scope);
  assert.deepEqual(await request(200, 'POST', recalc, target), linked);
  const newRules = await request(200, 'GET', `/v1/customer/cases/${linked.id}/rule-assessment${query}`);
  assert.equal(newRules.recalculationOf, task.id);
  assert.equal(newRules.decision, null);
  assert.deepEqual(newRules.candidates, proposed.references);
  assert.equal((await request(404, 'GET', `/v1/customer/cases/${linked.id}/activities${query}&period=2024-01&source=electricity`)).error.code,
    'ACTIVITY_NOT_FOUND');
});

test('public institution template is offered through the existing customer intake', async t => {
  const demo = await startDemo();
  t.after(() => demo.close());
  const {orgId} = demo;
  const result = await demo.dispatch('customer', 'GET', `/v1/customer/scenarios?orgId=${orgId}`);
  assert.equal(result.status, 200);
  const template = result.body.items.find(item => item.code === 'public-institution-inventory-prep');
  assert.equal(template.industryName, '公共机构');
  assert.ok(template.preparation.materials.length);
  const task = await demo.dispatch('customer', 'POST', '/v1/customer/cases', {
    orgId, scenarioReleaseId: template.id, purpose: template.purpose
  });
  assert.equal(task.status, 201);
  assert.equal(task.body.scenarioReleaseId, template.id);
  assert.deepEqual(task.body.scenarioPreparation.materials, template.preparation.materials);
});
