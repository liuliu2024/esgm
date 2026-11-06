import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { createAuthenticatedHandler } from '../infra/authenticated-http.mjs';
import { createEmbeddedDatabase } from '../infra/embedded.mjs';
import { migrate } from '../infra/migrations.mjs';
import { createCarbonApi } from '../src/index.mjs';

const [tenantId, otherTenantId, orgId, siblingOrgId, foreignOrgId, release, customer, reviewer, admin, foreignCustomer] =
  Array.from({length: 10}, () => randomUUID());
const sessions = new Map([
  ['customer', {tenantId, actorId: customer}], ['reviewer', {tenantId, actorId: reviewer}],
  ['admin', {tenantId, actorId: admin}], ['foreign', {tenantId: otherTenantId, actorId: foreignCustomer}],
  ['preferred', {tenantId, actorId: customer, orgId}],
  ['ungranted', {tenantId, actorId: customer, orgId: siblingOrgId}],
  ['invalid', {tenantId: 'invalid', actorId: admin}]
]);
const publicOrigin = 'https://carbon.example';
const cases = '/v1/customer/cases';
const files = new Map();
let db;
let server;
let origin;

before(async () => {
  db = await createEmbeddedDatabase();
  await migrate(db.admin);
  await db.admin.transaction(async tx => {
    await tx.query("INSERT INTO carbon.workspace VALUES ($1, 'Primary'), ($2, 'Foreign')", [tenantId, otherTenantId]);
    await tx.query(`INSERT INTO carbon.organization VALUES
      ($1, $2, 'Primary organization'), ($1, $3, 'Sibling organization'), ($4, $5, 'Foreign organization')`,
    [tenantId, orgId, siblingOrgId, otherTenantId, foreignOrgId]);
    await tx.query("INSERT INTO carbon.scenario_release VALUES ($1, $2, 'inventory', 1, '{}')", [tenantId, release]);
    for (const [workspace, org, actor, role] of [
      [tenantId, orgId, customer, 'customer'], [tenantId, orgId, reviewer, 'reviewer'],
      [tenantId, orgId, admin, 'admin'], [otherTenantId, foreignOrgId, foreignCustomer, 'customer']
    ]) {
      await tx.query('INSERT INTO carbon.org_grant VALUES ($1, $2, $3, $4)', [workspace, org, actor, role]);
    }
  });
  const api = createCarbonApi(db.runtime, {quarantine: {write: async (id, bytes) => files.set(id, bytes)}});
  server = createServer(createAuthenticatedHandler({
    api, publicOrigin,
    authenticate: async request => sessions.get(request.headers.cookie?.match(/^session=(\w+)$/)?.[1])
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server?.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await db?.close();
});

async function request(path, status, {session, headers, ...options} = {}) {
  const response = await fetch(origin + path, {
    ...options, headers: {...(session && {Cookie: `session=${session}`}), ...headers}
  });
  const body = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  assert.match(response.headers.get('cache-control') ?? '', /\bno-store\b/i);
  return body;
}

const workspace = view => `/v1/session/workspace?view=${view}`;
const command = (body, session = 'customer', headers = {}) => ({
  session, method: 'POST', headers: {'Content-Type': 'application/json', Origin: publicOrigin, ...headers},
  body: JSON.stringify(body)
});

test('trusted session resolves granted workspace; route and identity headers cannot elevate it', async () => {
  const forged = {'X-Tenant-Id': tenantId, 'X-Actor-Id': admin, 'X-Role': 'admin', 'X-Org-Id': orgId};
  assert.equal((await request(workspace('admin'), 401, {headers: forged})).error.code, 'AUTHENTICATION_REQUIRED');
  await request(workspace('admin'), 401, {session: 'unknown', headers: forged});
  await request(workspace('admin'), 401, {session: 'invalid', headers: forged});
  await request(workspace('admin'), 403, {session: 'customer', headers: forged});
  await request(workspace('professional'), 403, {session: 'customer', headers: forged});
  assert.equal((await request(workspace('customer'), 200, {session: 'customer', headers: forged})).orgId, orgId);
  assert.equal((await request(workspace('customer'), 200, {session: 'preferred'})).orgId, orgId);
  await request(workspace('customer'), 403, {session: 'ungranted', headers: forged});
  assert.equal((await request(workspace('professional'), 200, {session: 'reviewer'})).orgId, orgId);
  assert.equal((await request(workspace('admin'), 200, {session: 'admin'})).orgId, orgId);
  assert.equal((await request(workspace('customer'), 200, {session: 'foreign', headers: forged})).orgId, foreignOrgId);
  await request(workspace('reviewer'), 400, {session: 'reviewer'});
  await request(`${cases}?orgId=${siblingOrgId}`, 403, {session: 'customer', headers: forged});
  await request(`${cases}?orgId=${orgId}`, 403, {session: 'foreign', headers: forged});
  await request(`/v1/admin/organizations/${orgId}/audit`, 403, {session: 'customer', headers: forged});
});

test('HTTP writes reject cross-origin requests and preserve JSON commands and file bytes', async () => {
  const payload = {orgId, scenarioReleaseId: release, purpose: '认证入口测试'};
  const rejected = await request(cases, 403, command(payload, 'customer', {Origin: 'https://untrusted.example'}));
  assert.equal(rejected.error.code, 'CROSS_ORIGIN_REQUEST');
  assert.deepEqual((await request(`${cases}?orgId=${orgId}`, 200, {session: 'customer'})).cases, []);
  await request(cases, 403, command(payload, 'reviewer'));
  const task = await request(cases, 201, command(payload, 'customer', {
    'X-Actor-Id': admin, 'X-Tenant-Id': otherTenantId, 'X-Request-Id': 'untrusted-request'
  }));
  assert.equal(task.createdBy, customer);
  assert.equal(task.orgId, orgId);
  const audit = await request(`/v1/admin/organizations/${orgId}/audit`, 200, {session: 'admin'});
  const creation = audit.events.find(event => event.caseId === task.id && event.action === 'created');
  assert.equal(creation.actorId, customer);
  assert.match(creation.requestId, /^[0-9a-f-]{36}$/i);
  const evidencePath = `${cases}/${task.id}/evidence`;
  const evidence = await request(evidencePath, 201, command({orgId, title: '证明材料', sourceDescription: '样例'}));
  const bytes = Buffer.from('%PDF-1.7\n\u0000authenticated upload\n');
  const receipt = await request(`${evidencePath}/${evidence.id}/file?orgId=${orgId}`, 201, {
    session: 'customer', method: 'POST', headers: {'Content-Type': 'application/pdf', Origin: publicOrigin}, body: bytes
  });
  assert.equal(receipt.status, 'pending_scan');
  assert.equal(receipt.byteSize, bytes.length);
  assert.deepEqual(files.get(receipt.id), bytes);
});
