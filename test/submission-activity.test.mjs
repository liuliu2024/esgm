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

test('submission activity is captured by exact revision with scoped access and intact lineage', async t => {
  const [tenantId, orgId, siblingOrgId, releaseId, owner, reviewer, peer, siblingReviewer] =
    Array.from({length: 8}, () => randomUUID());
  const db = await createEmbeddedDatabase();
  t.after(() => db.close());
  const migrations = new URL('../migrations/', import.meta.url);
  const previous = (await readdir(migrations)).filter(name => /^0(?:0[1-9]|1[0-3])_/.test(name));
  const staging = await mkdtemp(join(tmpdir(), 'carbon-submission-activity-'));
  try {
    for (const name of previous) await copyFile(new URL(name, migrations), join(staging, name));
    await migrate(db.admin, pathToFileURL(staging + sep));
  } finally {
    for (const name of await readdir(staging)) await unlink(join(staging, name));
    await rmdir(staging);
  }
  await db.admin.transaction(async tx => {
    await tx.query("INSERT INTO carbon.workspace VALUES ($1, 'Activity submission')", [tenantId]);
    await tx.query("INSERT INTO carbon.organization VALUES ($1, $2, 'Primary'), ($1, $3, 'Sibling')",
      [tenantId, orgId, siblingOrgId]);
    await tx.query("INSERT INTO carbon.scenario_release VALUES ($1, $2, 'inventory', 1, '{}')", [tenantId, releaseId]);
    for (const [organization, actor, role] of [
      [orgId, owner, 'customer'], [orgId, reviewer, 'reviewer'], [orgId, peer, 'customer'],
      [siblingOrgId, siblingReviewer, 'reviewer']
    ]) {
      await tx.query('INSERT INTO carbon.org_grant VALUES ($1, $2, $3, $4)', [tenantId, organization, actor, role]);
    }
  });
  const api = createCarbonApi(db.runtime);
  async function request(status, method, path, body, actorId = owner) {
    const result = await api.dispatch({method, path, body}, {tenantId, actorId, requestId: randomUUID()});
    assert.equal(result.status, status, JSON.stringify(result.body));
    return result.body;
  }
  const create = () => request(201, 'POST', '/v1/customer/cases', {orgId, scenarioReleaseId: releaseId, purpose: '提交活动'});
  const legacy = await create();
  const legacyPath = `/v1/customer/cases/${legacy.id}`;
  const legacyBatch = await request(200, 'POST', `${legacyPath}/imports`, {
    orgId, csv: 'period,source,quantity,unit\n2026-01,electricity,9,kWh'
  });
  await request(200, 'POST', `${legacyPath}/imports/${legacyBatch.batchId}/commit`, {
    orgId, previewRevision: legacyBatch.previewRevision
  });
  await request(200, 'POST', `${legacyPath}/submit`, {orgId, revision: legacy.revision});
  await migrate(db.admin);

  const task = await create();
  const customer = `/v1/customer/cases/${task.id}`;
  const professional = `/v1/professional/cases/${task.id}`;
  const read = (status, path, revision, actorId = owner, organization = orgId) => request(
    status, 'GET', `${path}/revisions/${revision}/activities?orgId=${organization}`, undefined, actorId
  );
  const save = rows => request(200, 'POST', `${customer}/imports`, {
    orgId, csv: `period,source,quantity,unit\n${rows}`
  });
  const commit = ({batchId, previewRevision}) =>
    request(200, 'POST', `${customer}/imports/${batchId}/commit`, {orgId, previewRevision});

  const unavailable = {submissionRevision: 2, status: 'legacy_unavailable', items: []};
  assert.deepEqual(await read(200, legacyPath, 2), unavailable);
  assert.deepEqual(await read(200, `/v1/professional/cases/${legacy.id}`, 2, reviewer), unavailable);
  await commit(await save('2026-01,electricity,1,MWh'));
  const zero = await save('2026-01,electricity,0,MWh');
  await commit(zero);
  await save('2026-01,electricity,8,MWh\n2026-01,natural_gas,18,m3');
  await read(404, professional, 1, reviewer);
  const submitted = await request(200, 'POST', `${customer}/submit`, {orgId, revision: task.revision});
  assert.equal(submitted.revision, 2);
  const prior = await read(200, customer, 2);
  assert.deepEqual(prior, {submissionRevision: 2, status: 'captured', items: [{
    period: '2026-01', source: 'electricity', revision: 2, quantity: '0', unit: 'kWh',
    lineage: {batchId: zero.batchId, previewRevision: zero.previewRevision, sourceRow: 2, sourceType: 'manual_csv',
      conversionVersion: 'activity-csv-v1', originalQuantity: '0', originalUnit: 'MWh'}
  }]});
  assert.deepEqual(await read(200, professional, 2, reviewer), prior);
  await read(404, customer, 2, peer);
  await read(403, customer, 2, reviewer);
  await read(403, professional, 2, siblingReviewer);
  await read(404, professional, 2, siblingReviewer, siblingOrgId);
  await read(400, customer, '2e0');
  assert.equal((await read(404, customer, 1)).error.code, 'REVISION_NOT_FOUND');

  const returned = await request(200, 'POST', `${professional}/review`, {
    orgId, revision: 2, decision: 'returned', reason: '补正活动数量'
  }, reviewer);
  await read(404, customer, returned.revision);
  const correction = await save('2026-01,electricity,1.0000000000000000001,MWh');
  await commit(correction);
  assert.deepEqual(await read(200, professional, 2, reviewer), prior);
  const resubmitted = await request(200, 'POST', `${customer}/resubmit`, {
    orgId, revision: returned.revision, correctionNote: '已补正活动数量'
  });
  assert.equal(resubmitted.revision, 4);
  assert.deepEqual(await read(200, customer, 4), {submissionRevision: 4, status: 'captured', items: [{
    period: '2026-01', source: 'electricity', revision: 3, quantity: '1000.0000000000000001', unit: 'kWh',
    lineage: {batchId: correction.batchId, previewRevision: correction.previewRevision, sourceRow: 2, sourceType: 'manual_csv',
      conversionVersion: 'activity-csv-v1', originalQuantity: '1.0000000000000000001', originalUnit: 'MWh'}
  }]});
  assert.deepEqual(await read(200, customer, 2), prior);

  const empty = await create();
  const emptyPath = `/v1/customer/cases/${empty.id}`;
  await request(200, 'POST', `${emptyPath}/submit`, {orgId, revision: empty.revision});
  assert.deepEqual(await read(200, emptyPath, 2), {submissionRevision: 2, status: 'captured', items: []});

  await db.admin.transaction(tx => tx.query(
    'DELETE FROM carbon.org_grant WHERE tenant_id = $1 AND org_id = $2 AND actor_id = $3', [tenantId, orgId, reviewer]
  ));
  await read(403, professional, 4, reviewer);
});
