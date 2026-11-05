import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { createEmbeddedDatabase } from '../infra/embedded.mjs';
import { migrate } from '../infra/migrations.mjs';
import { createCarbonApi } from '../src/index.mjs';

const [tenantId, otherTenantId, orgId, ungrantedOrgId, otherOrgId, customer, otherCustomer, reviewer,
  oldRelease, newRelease, legacyRelease, foreignRelease] = Array.from({length: 12}, () => randomUUID());
const oldReference = {
  code: 'old-method', title: '旧版方法', publisher: '合成发布单位',
  sourceUrl: 'https://example.com/old', scopeNote: '按旧版适用条件核对'
};
const newReference = {
  code: 'new-method', title: '新版方法', publisher: '合成发布单位',
  sourceUrl: 'https://example.com/new', scopeNote: '先确认报告期间'
};
let db;
let api;

before(async () => {
  db = await createEmbeddedDatabase();
  await migrate(db.admin);
  await db.admin.transaction(async tx => {
    await tx.query("INSERT INTO carbon.workspace (id, name) VALUES ($1, 'Primary'), ($2, 'Foreign')", [tenantId, otherTenantId]);
    await tx.query(`INSERT INTO carbon.organization (tenant_id, id, name)
      VALUES ($1, $2, 'Primary'), ($1, $3, 'No grant'), ($4, $5, 'Foreign')`,
    [tenantId, orgId, ungrantedOrgId, otherTenantId, otherOrgId]);
    await tx.query(`INSERT INTO carbon.org_grant (tenant_id, org_id, actor_id, role)
      VALUES ($1, $2, $3, 'customer'), ($1, $2, $4, 'reviewer'), ($5, $6, $7, 'customer')`,
    [tenantId, orgId, customer, reviewer, otherTenantId, otherOrgId, otherCustomer]);
    await tx.query(`INSERT INTO carbon.scenario_release (tenant_id, id, code, version, manifest)
      VALUES ($1, $2, 'inventory', 1, $3), ($1, $4, 'inventory', 2, $5), ($1, $6, 'legacy', 1, $7),
      ($8, $9, 'inventory', 1, $10)`, [tenantId, oldRelease, {references: [oldReference]}, newRelease, {references: [
      {...newReference, internalDraft: 'private', ruleStatus: 'approved'},
      {...newReference, sourceUrl: 'https://user:password@example.com/internal'},
      {...newReference, sourceUrl: 'http://example.com/insecure'},
      {...newReference, sourceUrl: '//example.com/relative'},
      {...newReference, sourceUrl: 'javascript:alert(1)'},
      {...newReference, sourceUrl: 'https://'},
      {...newReference, publisher: '  '},
      null,
      oldReference
    ]}, legacyRelease, {references: 'legacy'}, otherTenantId, foreignRelease, {references: [newReference]}]);
  });
  api = createCarbonApi(db.runtime);
});

after(async () => { await db?.close(); });

function read(releaseId, organization = orgId, actorId = customer, workspaceId = tenantId) {
  return api.dispatch({method: 'GET', path: `/v1/customer/scenarios/${releaseId}/references?orgId=${organization}`},
    {tenantId: workspaceId, actorId, requestId: randomUUID()});
}

test('scenario references pin the exact immutable release, preserve order and filter invalid entries', async () => {
  assert.deepEqual(await read(oldRelease), {status: 200, body: {
    scenarioReleaseId: oldRelease, ruleStatus: 'needs_review', items: [oldReference]
  }});
  assert.deepEqual(await read(newRelease), {status: 200, body: {
    scenarioReleaseId: newRelease, ruleStatus: 'needs_review', items: [newReference, oldReference]
  }});
  assert.deepEqual(await read(legacyRelease), {status: 200, body: {
    scenarioReleaseId: legacyRelease, ruleStatus: 'needs_review', items: []
  }});
});

test('scenario references require customer organization scope and hide foreign versions', async () => {
  assert.equal((await read(foreignRelease)).status, 404);
  assert.equal((await read(randomUUID())).status, 404);
  assert.equal((await read(oldRelease, ungrantedOrgId)).status, 403);
  assert.equal((await read(oldRelease, orgId, reviewer)).status, 403);
  assert.equal((await read(oldRelease, otherOrgId, otherCustomer, otherTenantId)).status, 404);
  assert.deepEqual((await read(foreignRelease, otherOrgId, otherCustomer, otherTenantId)).body.items, [newReference]);
  assert.equal((await read('invalid')).status, 400);
});
