import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createEmbeddedDatabase } from '../infra/embedded.mjs';
import { migrate } from '../infra/migrations.mjs';
import { createCarbonApi } from '../src/index.mjs';

test('professional preview uses pinned electricity, an exact yearly factor, and explicit monthly coverage', async t => {
  const [tenantId, orgId, siblingOrg, release, owner, reviewer] = Array.from({length: 6}, () => randomUUID());
  const db = await createEmbeddedDatabase();
  t.after(() => db.close());
  const migrations = new URL('../migrations/', import.meta.url);
  const previous = (await readdir(migrations)).filter(name => /^0(?:0[1-9]|1[0-3])_/.test(name));
  const staging = await mkdtemp(join(tmpdir(), 'carbon-submission-calculation-'));
  try {
    for (const name of previous) await copyFile(new URL(name, migrations), join(staging, name));
    await migrate(db.admin, pathToFileURL(staging + sep));
  } finally {
    for (const name of await readdir(staging)) await unlink(join(staging, name));
    await rmdir(staging);
  }
  await db.admin.transaction(async tx => {
    await tx.query("INSERT INTO carbon.workspace VALUES ($1, 'Calculation')", [tenantId]);
    await tx.query("INSERT INTO carbon.organization VALUES ($1, $2, 'Main'), ($1, $3, 'Sibling')",
      [tenantId, orgId, siblingOrg]);
    await tx.query("INSERT INTO carbon.scenario_release VALUES ($1, $2, 'inventory', 1, '{}')", [tenantId, release]);
    await tx.query(`INSERT INTO carbon.org_grant VALUES
      ($1, $2, $3, 'customer'), ($1, $2, $3, 'reviewer'), ($1, $2, $4, 'reviewer')`,
    [tenantId, orgId, owner, reviewer]);
  });
  const api = createCarbonApi(db.runtime);
  async function request(status, method, path, body, actorId = owner) {
    const result = await api.dispatch({method, path, body}, {tenantId, actorId, requestId: randomUUID()});
    assert.equal(result.status, status, JSON.stringify(result.body));
    return result.body;
  }
  const create = () => request(201, 'POST', '/v1/customer/cases', {orgId, scenarioReleaseId: release, purpose: '电力核算'});
  const customerPath = id => `/v1/customer/cases/${id}`;
  const professionalPath = id => `/v1/professional/cases/${id}`;
  const submit = task => request(200, 'POST', `${customerPath(task.id)}/submit`, {orgId, revision: task.revision});
  const preview = (status, id, revision, from, to = from, actor = reviewer, organization = orgId) =>
    request(status, 'GET', `${professionalPath(id)}/revisions/${revision}/calculation-preview?${new URLSearchParams({
      orgId: organization, from, to
    })}`, undefined, actor);
  const legacy = await create();
  await submit(legacy);
  await migrate(db.admin);
  const unavailable = await preview(409, legacy.id, 2, '2024-01');
  assert.equal(unavailable.error.code, 'CALCULATION_INPUT_UNAVAILABLE');

  const task = await create();
  const customer = customerPath(task.id);
  const professional = professionalPath(task.id);
  async function commit(rows) {
    const batch = await request(200, 'POST', `${customer}/imports`, {
      orgId, csv: `period,source,quantity,unit\n${rows}`
    });
    await request(200, 'POST', `${customer}/imports/${batch.batchId}/commit`, {orgId, previewRevision: batch.previewRevision});
    return batch;
  }
  const firstBatch = await commit('2023-12,electricity,2,kWh\n2024-01,electricity,0,MWh\n2024-02,electricity,100,kWh\n2024-03,natural_gas,50,m3');
  await preview(404, task.id, 1, '2024-01');
  await submit(task);
  const noDecision = await preview(200, task.id, 2, '2024-01');
  assert.equal(noDecision.factorDecision, null);
  assert.equal(noDecision.outputUnit, null);
  assert.equal(noDecision.knownSubtotalKg, null);
  assert.deepEqual(noDecision.items.map(({status, quantity, emissionsKg}) => [status, quantity, emissionsKg]),
    [['missing_factor', '0', null]]);

  const decide = (revision, factorId, accountingBasis, dataYear) =>
    request(201, 'POST', `${professional}/revisions/${revision}/factor-decision`, {
      orgId, factorId, factorVersion: 1, accountingBasis, regionCode: 'CN', dataYear,
      methodReference: '电力方法 1.0', rationale: '已核对年份与地域'
    }, reviewer);
  const product = await decide(2, 'cn-electricity-product-average', 'product_footprint', 2024);
  const prior = await preview(200, task.id, 2, '2023-12', '2024-03');
  assert.equal(prior.mode, 'controlled');
  assert.equal(prior.outputUnit, 'kgCO2e');
  assert.equal(prior.formalReportEligible, false);
  assert.equal(prior.externalDeliveryEligible, false);
  assert.deepEqual(prior.factorDecision, product.decision);
  assert.deepEqual(prior.coverage, {status: 'partial', expectedSlots: 4, availableSlots: 2, missingSlots: 2});
  assert.deepEqual(prior.excludedSources, ['natural_gas']);
  assert.equal(prior.knownSubtotalKg, '57.77');
  assert.equal(prior.totalKg, null);
  assert.equal(prior.totalT, null);
  assert.deepEqual(prior.items.map(({period, status, quantity, emissionsKg}) => [period, status, quantity, emissionsKg]), [
    ['2023-12', 'missing_factor', '2', null], ['2024-01', 'calculated', '0', '0'],
    ['2024-02', 'calculated', '100', '57.77'], ['2024-03', 'missing_activity', null, null]
  ]);
  assert.deepEqual(prior.items[1].factor, product.decision.factor);
  assert.equal(prior.items[1].lineage.activityRevision, 1);
  assert.equal(prior.items[1].lineage.batchId, firstBatch.batchId);
  const zero = await preview(200, task.id, 2, '2024-01');
  assert.equal(zero.coverage.status, 'complete');
  assert.equal(zero.totalKg, '0');
  assert.equal(zero.totalT, '0');

  assert.equal((await preview(403, task.id, 2, '2024-01', '2024-01', owner)).error.code, 'SELF_REVIEW_FORBIDDEN');
  await preview(403, task.id, 2, '2024-01', '2024-01', reviewer, siblingOrg);
  await request(404, 'GET', `${customer}/revisions/2/calculation-preview?orgId=${orgId}&from=2024-01&to=2024-01`);
  await preview(400, task.id, 2, '2024-02', '2024-01');
  await preview(404, task.id, 3, '2024-01');
  const returned = await request(200, 'POST', `${professional}/review`, {
    orgId, revision: 2, decision: 'returned', reason: '补正用电'
  }, reviewer);
  await commit('2023-12,electricity,5,kWh');
  const resubmitted = await request(200, 'POST', `${customer}/resubmit`, {
    orgId, revision: returned.revision, correctionNote: '已补正 12 月用电'
  });
  await decide(resubmitted.revision, 'cn-electricity-organization-average', 'organization_electricity_co2', 2023);
  const next = await preview(200, task.id, resubmitted.revision, '2023-12');
  assert.equal(next.outputUnit, 'kgCO2');
  assert.equal(next.totalKg, '2.653');
  assert.equal(next.totalT, '0.002653');
  assert.equal(next.items[0].lineage.activityRevision, 2);
  assert.deepEqual(await preview(200, task.id, 2, '2023-12', '2024-03'), prior);
});
