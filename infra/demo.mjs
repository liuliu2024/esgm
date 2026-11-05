import { randomUUID } from 'node:crypto';
import { createEmbeddedDatabase } from './embedded.mjs';
import { migrate } from './migrations.mjs';
import { createCarbonApi } from '../src/index.mjs';

const db = await createEmbeddedDatabase();
const tenantId = randomUUID();
const orgId = randomUUID();
const scenarioReleaseId = randomUUID();
const actors = { customer: randomUUID(), reviewer: randomUUID(), admin: randomUUID() };

try {
  await migrate(db.admin);
  await db.admin.transaction(async tx => {
    await tx.query('INSERT INTO carbon.workspace (id, name) VALUES ($1, $2)', [tenantId, '演示工作空间']);
    await tx.query('INSERT INTO carbon.organization (tenant_id, id, name) VALUES ($1, $2, $3)',
      [tenantId, orgId, '演示组织']);
    await tx.query('INSERT INTO carbon.scenario_release (tenant_id, id, code, version, manifest) VALUES ($1, $2, $3, 1, $4)',
      [tenantId, scenarioReleaseId, 'carbon-intake', { title: '碳业务受理' }]);
    for (const [role, actorId] of Object.entries(actors)) {
      await tx.query('INSERT INTO carbon.org_grant (tenant_id, org_id, actor_id, role) VALUES ($1, $2, $3, $4)',
        [tenantId, orgId, actorId, role]);
    }
  });

  const api = createCarbonApi(db.runtime);
  async function dispatch(role, method, path, body) {
    const response = await api.dispatch({ method, path, body }, {
      tenantId, actorId: actors[role], requestId: randomUUID()
    });
    if (response.status >= 400) throw new Error(`Demo request failed: ${response.body.error.code}`);
    return response.body;
  }
  const created = await dispatch('customer', 'POST', '/v1/customer/cases',
    { orgId, scenarioReleaseId, purpose: '准备采购方所需的碳数据报告' });
  const submitted = await dispatch('customer', 'POST', `/v1/customer/cases/${created.id}/submit`,
    { orgId, revision: created.revision });
  const reviewed = await dispatch('reviewer', 'POST', `/v1/professional/cases/${created.id}/review`,
    { orgId, revision: submitted.revision, decision: 'approved' });
  const audit = await dispatch('admin', 'GET', `/v1/admin/organizations/${orgId}/audit`);
  console.log(JSON.stringify({ stages: [created.status, submitted.status, reviewed.status],
    audit: audit.events.map(({ action, revision }) => ({ action, revision })) }, null, 2));
} finally {
  await db.close();
}
