import { startDemo } from './demo-data.mjs';

const demo = await startDemo();
const { orgId, scenarioReleaseId } = demo;
try {
  async function dispatch(role, method, path, body) {
    const response = await demo.dispatch(role, method, path, body);
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
  await demo.close();
}
