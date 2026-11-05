import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { createEmbeddedDatabase } from '../infra/embedded.mjs';
import { migrate } from '../infra/migrations.mjs';
import { createCarbonApi } from '../src/index.mjs';

const [tenantId, otherTenantId, orgId, ungrantedOrgId, otherOrgId, customer, otherCustomer, reviewer] =
  Array.from({length: 8}, () => randomUUID());
const catalogPath = '/v1/customer/scenarios';
const manufacturing = {
  industryCode: 'manufacturing', industryName: '工业制造', title: '采购方资料准备',
  purpose: '编制内部管理资料', recipient: '采购方'
};
const building = {
  industryCode: 'building', industryName: '建筑物业', title: '组织盘查准备',
  purpose: '汇集年度组织活动数据', recipient: '企业碳管理部门'
};
let db;
let api;

before(async () => {
  db = await createEmbeddedDatabase();
  await migrate(db.admin);
  await db.admin.transaction(async tx => {
    await tx.query("INSERT INTO carbon.workspace (id, name) VALUES ($1, 'Primary'), ($2, 'Other')", [tenantId, otherTenantId]);
    await tx.query(`INSERT INTO carbon.organization (tenant_id, id, name)
      VALUES ($1, $2, 'Primary'), ($1, $3, 'Not assigned'), ($4, $5, 'Other')`,
    [tenantId, orgId, ungrantedOrgId, otherTenantId, otherOrgId]);
    await tx.query(`INSERT INTO carbon.org_grant (tenant_id, org_id, actor_id, role)
      VALUES ($1, $2, $3, 'customer'), ($1, $2, $4, 'reviewer'), ($5, $6, $7, 'customer')`,
    [tenantId, orgId, customer, reviewer, otherTenantId, otherOrgId, otherCustomer]);
  });
  api = createCarbonApi(db.runtime);
});

after(async () => { await db?.close(); });

function dispatch(method, path, body, actorId = customer, workspaceId = tenantId) {
  return api.dispatch({method, path, body}, {tenantId: workspaceId, actorId, requestId: randomUUID()});
}

async function publish(code, version, manifest, workspaceId = tenantId) {
  const id = randomUUID();
  await db.admin.transaction(tx => tx.query(`INSERT INTO carbon.scenario_release
    (tenant_id, id, code, version, manifest) VALUES ($1, $2, $3, $4, $5)`,
  [workspaceId, id, code, version, manifest]));
  return id;
}

test('catalog lists complete latest releases and keeps the case pinned to the selected old release', async () => {
  const url = `${catalogPath}?orgId=${orgId}`;
  assert.deepEqual(await dispatch('GET', url), {status: 200, body: {items: []}});
  const first = await publish('procurement', 1, {catalog: manufacturing});
  const inventory = await publish('inventory', 1, {catalog: building});
  const created = await dispatch('POST', '/v1/customer/cases', {orgId, scenarioReleaseId: first, purpose: manufacturing.purpose});
  assert.equal(created.status, 201);

  const updated = {...manufacturing, purpose: '编制年度内部管理资料'};
  const second = await publish('procurement', 2, {
    catalog: {...updated, ruleStatus: 'claimed_applicable', secret: 'internal'}, rule: 'raw rule input'
  });
  const hidden = await publish('legacy', 1, {title: '旧配置'});
  await publish('retired', 1, {catalog: building});
  await publish('retired', 2, {catalog: {...building, recipient: '   '}});
  await publish('malformed', 1, {catalog: {...building, title: 42}});

  assert.deepEqual(await dispatch('GET', url), {status: 200, body: {items: [
    {id: inventory, code: 'inventory', version: 1, ...building, ruleStatus: 'needs_review'},
    {id: second, code: 'procurement', version: 2, ...updated, ruleStatus: 'needs_review'}
  ]}});
  const original = await dispatch('GET', `/v1/customer/cases/${created.body.id}?orgId=${orgId}`);
  assert.equal(original.body.scenarioReleaseId, first);
  const legacy = await dispatch('POST', '/v1/customer/cases', {orgId, scenarioReleaseId: hidden, purpose: '既有流程'});
  assert.equal(legacy.status, 201);
});

test('catalog requires a customer grant for the supplied organization and isolates tenant releases', async () => {
  const foreign = await publish('foreign', 1, {catalog: building}, otherTenantId);
  const url = `${catalogPath}?orgId=${orgId}`;
  const foreignUrl = `${catalogPath}?orgId=${otherOrgId}`;
  const foreignList = await dispatch('GET', foreignUrl, undefined, otherCustomer, otherTenantId);
  assert.deepEqual(foreignList.body.items.map(item => item.id), [foreign]);
  const localList = await dispatch('GET', url);
  assert.equal(localList.body.items.some(item => item.id === foreign), false);
  assert.equal((await dispatch('GET', `${catalogPath}?orgId=${ungrantedOrgId}`)).status, 403);
  assert.equal((await dispatch('GET', url, undefined, reviewer)).status, 403);
  assert.equal((await dispatch('GET', url, undefined, otherCustomer, otherTenantId)).status, 403);
  assert.equal((await dispatch('GET', foreignUrl)).status, 403);
  assert.equal((await dispatch('GET', `${url}&orgId=${orgId}`)).status, 400);
});
