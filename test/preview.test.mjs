import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startPreview } from '../infra/preview.mjs';

test('three preview entries use the same intake and review workflow', async () => {
  const preview = await startPreview();
  try {
    for (const [path, title] of [['/customer', '企业工作台'], ['/professional', '专业作业台'], ['/admin', '组织审计']]) {
      const response = await fetch(preview.origin + path);
      assert.equal(response.status, 200);
      const html = await response.text();
      assert.match(html, new RegExp(title));
      assert.doesNotMatch(html, /演示角色|架构与 AI/);
      if (path !== '/admin') assert.match(html, /材料清单/);
      if (path === '/customer') {
        assert.match(html, /历史演示稿/);
        assert.match(html, /参考资料/);
      }
    }
    const read = async path => {
      const response = await fetch(preview.origin + path);
      assert.equal(response.status, 200);
      return response.json();
    };
    const post = async (path, body, expected = 200) => {
      const response = await fetch(preview.origin + path, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      assert.equal(response.status, expected);
      return response.json();
    };
    const { orgId, scenarioReleaseId } = await read('/demo/context');
    const catalog = await read(`/v1/customer/scenarios?orgId=${orgId}`);
    assert.deepEqual(catalog.items.map(({industryCode, ruleStatus}) => [industryCode, ruleStatus]),
      [['buildings', 'needs_review'], ['manufacturing', 'needs_review']]);
    const selected = catalog.items.find(item => item.industryCode === 'manufacturing');
    assert.equal(selected.id, scenarioReleaseId);
    const building = catalog.items.find(item => item.industryCode === 'buildings');
    const manufacturingReferences = await read(`/v1/customer/scenarios/${selected.id}/references?orgId=${orgId}`);
    const buildingReferences = await read(`/v1/customer/scenarios/${building.id}/references?orgId=${orgId}`);
    assert.equal(manufacturingReferences.ruleStatus, 'needs_review');
    assert.deepEqual(manufacturingReferences.items.map(item => item.code), ['gbt-24067-2024', 'electricity-pcf-2024']);
    assert.deepEqual(buildingReferences.items.map(item => item.code), ['electricity-co2-2023']);
    const created = await post('/v1/customer/cases', {
      orgId, scenarioReleaseId: selected.id, purpose: '准备采购方碳数据报告'
    }, 201);
    const customer = `/v1/customer/cases/${created.id}`;
    const professional = `/v1/professional/cases/${created.id}`;
    const activity = await post(customer + '/imports/preview', {
      orgId, csv: 'period,source,quantity,unit\n2026-01,electricity,1,MWh'
    });
    assert.equal(activity.status, 'ready');
    assert.equal(activity.preview[0].quantity, '1000');
    assert.equal(activity.preview[0].unit, 'kWh');
    const imported = await post(customer + '/imports', {
      orgId, csv: 'period,source,quantity,unit\n2026-01,electricity,1,MWh\n2026-01,natural_gas,200,m3'
    });
    const confirmed = await post(`${customer}/imports/${imported.batchId}/commit`, {
      orgId, previewRevision: imported.previewRevision
    });
    assert.equal(confirmed.inserted, 2);
    const range = { orgId, from: '2026-01', to: '2026-01' };
    const calculation = await read(`${customer}/calculation-preview?${new URLSearchParams(range)}`);
    assert.equal(calculation.totalKgCO2e, '900');
    const snapshot = await post(customer + '/calculation-snapshots', range, 201);
    const draft = await post(customer + '/internal-report-drafts', { orgId, snapshotId: snapshot.snapshotId }, 201);
    assert.equal(draft.report.watermark, '内部演示｜合成因子｜禁止外发');
    assert.equal(draft.report.summary.totalTCO2e, '0.9');
    assert.equal(draft.externalDeliveryEligible, false);
    const draftHistory = await read(`${customer}/internal-report-drafts?orgId=${orgId}`);
    assert.deepEqual(draftHistory, { items: [{ draftId: draft.draftId, snapshotId: snapshot.snapshotId,
      createdAt: draft.createdAt, from: '2026-01', to: '2026-01', templateVersion: 1 }], nextCursor: null });
    const evidence = await post(customer + '/evidence', {
      orgId, title: '月度用电账单', sourceDescription: '园区供电结算记录'
    }, 201);
    assert.equal(evidence.status, 'pending_file');
    const filePath = preview.origin + customer + `/evidence/${evidence.id}/file?orgId=${orgId}`;
    const file = Buffer.from('%PDF-1.7\nDemo signature only\n');
    const receive = await fetch(filePath, { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: file });
    assert.equal(receive.status, 201);
    const receipt = await receive.json();
    assert.equal(receipt.status, 'pending_scan');
    assert.equal(receipt.byteSize, file.length);
    const oversized = await fetch(filePath, {
      method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: Buffer.alloc(5 * 1024 * 1024 + 1)
    });
    assert.equal(oversized.status, 413);
    const submitted = await post(customer + '/submit', { orgId, revision: created.revision });
    const returned = await post(professional + '/review', {
      orgId, revision: submitted.revision, decision: 'returned', reason: '补充报告期间'
    });
    const resubmitted = await post(customer + '/resubmit', {
      orgId, revision: returned.revision, correctionNote: '报告期间为 2026 年'
    });
    const reviewQueue = await read(`/v1/professional/cases?orgId=${orgId}`);
    assert.equal(reviewQueue.cases[0].nextAction, 'review');
    const reviewedMaterials = await read(professional + `/evidence?orgId=${orgId}`);
    assert.deepEqual(reviewedMaterials.items.map(item => [item.title, item.status]), [['月度用电账单', 'pending_scan']]);
    const approved = await post(professional + '/review', {
      orgId, revision: resubmitted.revision, decision: 'approved'
    });
    assert.equal(approved.status, 'approved');
    const { events } = await read(`/v1/admin/organizations/${orgId}/audit`);
    assert.deepEqual(events.map(event => event.action), ['approved', 'submitted', 'returned', 'submitted', 'created']);
    assert.equal(events[1].correctionNote, '报告期间为 2026 年');
    assert.equal(events[2].reason, '补充报告期间');
  } finally {
    await preview.close();
  }
});
