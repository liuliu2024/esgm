import { startDemo } from './demo-data.mjs';
import { createLocalQuarantine } from './local-quarantine.mjs';

const quarantine = await createLocalQuarantine();
let demo;
try {
  demo = await startDemo({ quarantine });
  const { orgId, scenarioReleaseId } = demo;
  async function dispatch(role, method, path, body, contentType) {
    const response = await demo.dispatch(role, method, path, body, contentType);
    if (response.status >= 400) throw new Error(`Demo request failed: ${response.body.error.code}`);
    return response.body;
  }
  const created = await dispatch('customer', 'POST', '/v1/customer/cases',
    { orgId, scenarioReleaseId, purpose: '准备采购方所需的碳数据报告' });
  const evidencePath = `/v1/customer/cases/${created.id}/evidence`;
  const evidence = await dispatch('customer', 'POST', evidencePath,
    { orgId, title: '示例能源账单', sourceDescription: '仅用于验证接收流程的演示材料' });
  const receipt = await dispatch('customer', 'POST', `${evidencePath}/${evidence.id}/file?orgId=${orgId}`,
    Buffer.from('%PDF-1.7\nDemo signature only\n'), 'application/pdf');
  const submitted = await dispatch('customer', 'POST', `/v1/customer/cases/${created.id}/submit`,
    { orgId, revision: created.revision });
  const reviewed = await dispatch('reviewer', 'POST', `/v1/professional/cases/${created.id}/review`,
    { orgId, revision: submitted.revision, decision: 'approved' });
  const audit = await dispatch('admin', 'GET', `/v1/admin/organizations/${orgId}/audit`);
  console.log(JSON.stringify({ file: { status: receipt.status, byteSize: receipt.byteSize, sha256: receipt.sha256 },
    stages: [created.status, submitted.status, reviewed.status],
    audit: audit.events.map(({ action, revision }) => ({ action, revision })) }, null, 2));
} finally {
  await Promise.all([demo?.close(), quarantine.close()]);
}
