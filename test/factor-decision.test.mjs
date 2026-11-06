import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createEmbeddedDatabase } from '../infra/embedded.mjs';
import { migrate } from '../infra/migrations.mjs';
import { createCarbonApi } from '../src/index.mjs';

test('reviewer records one exact factor reference per submission and preserves prior decisions', async t => {
  const [tenantId, foreignTenantId, orgId, foreignOrgId, releaseId, owner, reviewer, peer] =
    Array.from({length: 8}, () => randomUUID());
  const db = await createEmbeddedDatabase();
  t.after(() => db.close());
  await migrate(db.admin);
  await db.admin.transaction(async tx => {
    await tx.query("INSERT INTO carbon.workspace VALUES ($1, 'Primary'), ($2, 'Foreign')", [tenantId, foreignTenantId]);
    await tx.query("INSERT INTO carbon.organization VALUES ($1, $2, 'Primary'), ($3, $4, 'Foreign')",
      [tenantId, orgId, foreignTenantId, foreignOrgId]);
    await tx.query("INSERT INTO carbon.scenario_release VALUES ($1, $2, 'inventory', 1, '{}')", [tenantId, releaseId]);
    for (const [workspace, organization, actor, role] of [
      [tenantId, orgId, owner, 'customer'], [tenantId, orgId, owner, 'reviewer'],
      [tenantId, orgId, reviewer, 'reviewer'], [tenantId, orgId, peer, 'customer'],
      [foreignTenantId, foreignOrgId, reviewer, 'reviewer']
    ]) {
      await tx.query('INSERT INTO carbon.org_grant VALUES ($1, $2, $3, $4)', [workspace, organization, actor, role]);
    }
  });
  const api = createCarbonApi(db.runtime);
  async function request(status, method, path, body, actorId = owner, workspace = tenantId) {
    const result = await api.dispatch({method, path, body}, {tenantId: workspace, actorId, requestId: randomUUID()});
    assert.equal(result.status, status, JSON.stringify(result.body));
    return result.body;
  }
  const task = await request(201, 'POST', '/v1/customer/cases', {
    orgId, scenarioReleaseId: releaseId, purpose: '核对电力因子'
  });
  const customer = `/v1/customer/cases/${task.id}`;
  const professional = `/v1/professional/cases/${task.id}`;
  const route = (path, revision) => `${path}/revisions/${revision}/factor-decision`;
  const select = (factorId, accountingBasis, dataYear) => ({
    orgId, factorId, factorVersion: 1, accountingBasis, regionCode: 'CN', dataYear,
    methodReference: '方法指引 1.0', rationale: '已核对适用地域、数据期间和使用依据'
  });
  const product = select('cn-electricity-product-average', 'product_footprint', 2024);
  const organization = select('cn-electricity-organization-average', 'organization_electricity_co2', 2023);
  const decide = (status, revision, body, actorId = reviewer) =>
    request(status, 'POST', route(professional, revision), body, actorId);
  const read = (status, path, revision, actorId = owner, workspace = tenantId, organization = orgId) =>
    request(status, 'GET', `${route(path, revision)}?orgId=${organization}`, undefined, actorId, workspace);

  await read(404, professional, 1, reviewer);
  const submitted = await request(200, 'POST', `${customer}/submit`, {orgId, revision: task.revision});
  assert.equal(submitted.revision, 2);
  const missing = await read(404, customer, 2);
  assert.equal(missing.error.code, 'FACTOR_DECISION_NOT_FOUND');
  assert.equal((await decide(403, 2, product, owner)).error.code, 'SELF_REVIEW_FORBIDDEN');
  await decide(403, 2, product, peer);
  await request(404, 'POST', route(customer, 2), product);
  await decide(400, '2e0', product);
  await decide(400, 2, {...product, value: '9', sourceUrl: 'https://invalid.example'});
  for (const selection of [
    {...product, factorId: organization.factorId}, {...product, factorVersion: 2},
    {...product, regionCode: 'CN-31'}, {...product, dataYear: 2023}
  ]) {
    assert.equal((await decide(404, 2, selection)).error.code, 'FACTOR_REFERENCE_NOT_FOUND');
  }
  const first = await decide(201, 2, product);
  const assertDecision = async (result, selection, revision, value, outputUnit) => {
    const {decision} = result;
    assert.equal(decision.caseId, task.id);
    assert.equal(decision.submissionRevision, revision);
    assert.equal(decision.decidedBy, reviewer);
    assert.ok(Number.isFinite(Date.parse(decision.decidedAt)));
    assert.equal(decision.methodReference, selection.methodReference);
    assert.equal(decision.rationale, selection.rationale);
    assert.equal(decision.formalReportEligible, false);
    assert.equal(decision.externalDeliveryEligible, false);
    const reference = await request(200, 'GET', `/v1/professional/factor-references?${new URLSearchParams({
      orgId, accountingBasis: selection.accountingBasis, regionCode: selection.regionCode, dataYear: selection.dataYear
    })}`, undefined, reviewer);
    assert.deepEqual(decision.factor, reference.items[0]);
    assert.equal(decision.factor.value, value);
    assert.equal(decision.factor.outputUnit, outputUnit);
  };
  await assertDecision(first, product, 2, '0.5777', 'kgCO2e');
  assert.deepEqual(await read(200, customer, 2), first);
  assert.deepEqual(await read(200, professional, 2, reviewer), first);
  await read(404, customer, 2, peer);
  await read(404, professional, 2, reviewer, foreignTenantId, foreignOrgId);
  await read(403, professional, 2, reviewer, foreignTenantId);
  assert.equal((await decide(409, 2, organization)).error.code, 'FACTOR_DECISION_CONFLICT');

  const returned = await request(200, 'POST', `${professional}/review`, {
    orgId, revision: 2, decision: 'returned', reason: '补充核算范围'
  }, reviewer);
  const resubmitted = await request(200, 'POST', `${customer}/resubmit`, {
    orgId, revision: returned.revision, correctionNote: '已补充组织范围'
  });
  assert.equal(resubmitted.revision, 4);
  assert.equal((await decide(409, 2, organization)).error.code, 'FACTOR_DECISION_CONFLICT');
  const second = await decide(201, 4, organization);
  await assertDecision(second, organization, 4, '0.5306', 'kgCO2');
  assert.deepEqual(await read(200, customer, 2), first);
  assert.deepEqual(await read(200, professional, 4, reviewer), second);

  await assert.rejects(db.admin.transaction(tx => tx.query(`UPDATE carbon.case_factor_decision
    SET rationale = '试图改写历史' WHERE tenant_id = $1 AND case_id = $2 AND submission_revision = 2`,
  [tenantId, task.id])), {code: '55000'});
  assert.deepEqual(await read(200, customer, 2), first);

  await db.admin.transaction(tx => tx.query('DELETE FROM carbon.org_grant WHERE tenant_id = $1 AND org_id = $2 AND actor_id = $3',
    [tenantId, orgId, reviewer]));
  await read(403, professional, 4, reviewer);
  assert.deepEqual(await read(200, customer, 4), second);
});
