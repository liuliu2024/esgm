import assert from 'node:assert/strict';
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
  const scope = { subjectType: 'product', subjectName: '合成设备 A', jurisdiction: '上海市',
    reportingYear: '2025', recipient: '样例采购方' };
  const created = await dispatch('customer', 'POST', '/v1/customer/cases',
    { orgId, scenarioReleaseId, purpose: '核对合成报告及来源', scope });
  const casePath = `/v1/customer/cases/${created.id}`;
  const evidencePath = `${casePath}/evidence`;
  const evidence = await dispatch('customer', 'POST', evidencePath,
    { orgId, title: '示例能源账单', sourceDescription: '仅用于验证接收流程的演示材料' });
  const receipt = await dispatch('customer', 'POST', `${evidencePath}/${evidence.id}/file?orgId=${orgId}`,
    Buffer.from('%PDF-1.7\nDemo signature only\n'), 'application/pdf');
  assert.equal(receipt.status, 'pending_scan');
  async function importActivities(rows) {
    const batch = await dispatch('customer', 'POST', `${casePath}/imports`, {
      orgId, csv: `period,source,quantity,unit\n${rows}`
    });
    return dispatch('customer', 'POST', `${casePath}/imports/${batch.batchId}/commit`,
      { orgId, previewRevision: batch.previewRevision });
  }
  const original = await importActivities('2026-01,electricity,1,MWh\n2026-01,natural_gas,200,m3');
  assert.equal(original.inserted, 2);
  const snapshot = await dispatch('customer', 'POST', `${casePath}/calculation-snapshots`,
    { orgId, from: '2026-01', to: '2026-01' });
  const draft = await dispatch('customer', 'POST', `${casePath}/internal-report-drafts`,
    { orgId, snapshotId: snapshot.snapshotId });
  assert.equal(draft.template.version, 2);
  assert.equal(draft.formalReportEligible, false);
  assert.equal(draft.externalDeliveryEligible, false);
  assert.equal(draft.report.summary.totalKgCO2e, '900');
  assert.deepEqual(draft.report.scope.declaredScope, scope);
  const corrected = await importActivities('2026-01,electricity,1400,kWh');
  assert.equal(corrected.corrected, 1);
  const source = draft.report.items.find(item => item.source === 'electricity');
  const query = new URLSearchParams({ orgId, period: source.period, source: source.source });
  const latest = await dispatch('customer', 'GET', `${casePath}/activities?${query}`);
  query.set('revision', String(source.lineage.activityRevision));
  const originalSource = await dispatch('customer', 'GET', `${casePath}/activities?${query}`);
  assert.equal(latest.quantity, '1400');
  assert.equal(originalSource.quantity, '1000');
  assert.equal(originalSource.lineage.originalQuantity, '1');
  assert.equal(originalSource.lineage.originalUnit, 'MWh');
  const historical = await dispatch('customer', 'GET', `${casePath}/internal-report-drafts/${draft.draftId}?orgId=${orgId}`);
  assert.deepEqual(historical, draft);
  const submitted = await dispatch('customer', 'POST', `${casePath}/submit`,
    { orgId, revision: created.revision });
  const draftPath = `${casePath}/internal-report-drafts/${draft.draftId}`;
  const reviewQueue = `/v1/professional/cases/${created.id}/internal-report-drafts`;
  const initialReports = await dispatch('reviewer', 'GET', `${reviewQueue}?orgId=${orgId}`);
  assert.equal(initialReports.items.length, 0);
  const reportSubmission = await dispatch('customer', 'POST', `${draftPath}/submit-review`, { orgId });
  assert.equal(reportSubmission.review.status, 'submitted');
  const reviewPath = `${reviewQueue}/${draft.draftId}/review`;
  const reportDetail = await dispatch('reviewer', 'GET', `${reviewPath}?orgId=${orgId}`);
  assert.deepEqual(reportDetail.draft, draft);
  const reportDecision = await dispatch('reviewer', 'POST', reviewPath, { orgId, decision: 'reviewed' });
  assert.equal(reportDecision.review.status, 'reviewed');
  assert.equal(reportDecision.review.externalDeliveryEligible, false);
  const reviewed = await dispatch('reviewer', 'POST', `/v1/professional/cases/${created.id}/review`,
    { orgId, revision: submitted.revision, decision: 'approved' });
  const audit = await dispatch('admin', 'GET', `/v1/admin/organizations/${orgId}/audit`);
  const stages = [created.status, submitted.status, reviewed.status];
  assert.deepEqual(stages, ['draft', 'submitted', 'approved']);
  assert.deepEqual(audit.events.map(event => event.action), ['approved', 'submitted', 'created']);
  console.log(JSON.stringify({ file: { status: receipt.status, byteSize: receipt.byteSize, sha256: receipt.sha256 },
    report: { watermark: draft.report.watermark, templateVersion: draft.template.version,
      formalReportEligible: draft.formalReportEligible, externalDeliveryEligible: reportDecision.review.externalDeliveryEligible,
      reviewStatus: reportDecision.review.status,
      reportingYear: scope.reportingYear, calculationMonth: draft.report.scope.from,
      frozenTotalKgCO2e: draft.report.summary.totalKgCO2e, originalElectricityKWh: originalSource.quantity,
      currentElectricityKWh: latest.quantity },
    stages,
    audit: audit.events.map(({ action, revision }) => ({ action, revision })) }, null, 2));
} finally {
  await Promise.all([demo?.close(), quarantine.close()]);
}
