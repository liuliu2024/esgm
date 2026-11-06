import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { startDemo } from '../infra/demo-data.mjs';

const scenes = [
  ['verification-prep', 'www.mee.gov.cn', '待核查报告'],
  ['compliance-prep', 'www.mee.gov.cn', '履约配额记录'],
  ['zero-carbon-prep', 'www.ndrc.gov.cn', '设施用能基线'],
  ['esg-disclosure-prep', 'kjs.mof.gov.cn', '披露指标证据'],
  ['product-footprint-prep', 'www.mee.gov.cn', '产品物料清单'],
  ['overseas-report-prep', 'taxation-customs.ec.europa.eu', '境外买方原始模板']
];

test('specialist intake scenes preserve official references and use the scoped review workflow', async t => {
  const demo = await startDemo();
  t.after(() => demo.close());
  const {orgId} = demo;
  async function request(role, method, path, expectedStatus, body) {
    const result = await demo.dispatch(role, method, path, body);
    assert.equal(result.status, expectedStatus, JSON.stringify(result.body));
    return result.body;
  }

  const catalog = await request('customer', 'GET', `/v1/customer/scenarios?orgId=${orgId}`, 200);
  const releases = new Map(catalog.items.map(scene => [scene.code, scene]));
  const releaseIds = new Set(scenes.map(([code]) => releases.get(code)?.id));
  assert.equal(releaseIds.size, scenes.length);
  assert.ok(!releaseIds.has(undefined));

  const legacy = releases.get('carbon-intake');
  assert.equal(legacy.id, demo.scenarioReleaseId);
  assert.ok(!releaseIds.has(legacy.id));
  assert.equal(legacy.preparation, undefined);
  const legacyReferences = await request('customer', 'GET', `/v1/customer/scenarios/${legacy.id}/references?orgId=${orgId}`, 200);
  assert.deepEqual(legacyReferences.items.map(item => item.code), ['gbt-24067-2024', 'electricity-pcf-2024']);

  const product = releases.get('product-footprint-prep');
  const overseas = releases.get('overseas-report-prep');
  for (const {preparation} of [product, overseas]) {
    assert.deepEqual(Object.keys(preparation).sort(), ['materials', 'reportRequirements']);
    for (const lines of Object.values(preparation)) {
      assert.ok(Array.isArray(lines) && lines.length > 0);
      assert.ok(lines.every(line => typeof line === 'string' && line.trim()));
    }
  }
  assert.match(product.preparation.materials.join(' '), /功能单位/);
  assert.match(product.preparation.reportRequirements.join(' '), /生命周期边界/);
  assert.match(overseas.preparation.materials.join(' '), /模板.*语言.*截止日期/);
  assert.match(overseas.preparation.reportRequirements.join(' '), /产品足迹.*CBAM.*ESG/);

  for (const [code, host, materialTitle] of scenes) {
    await t.test(code, async () => {
      const {id, purpose, ruleStatus} = releases.get(code);
      assert.equal(ruleStatus, 'needs_review');
      const references = `/v1/customer/scenarios/${id}/references?orgId=${orgId}`;
      await request('reviewer', 'GET', references, 403);
      const metadata = await request('customer', 'GET', references, 200);
      assert.equal(metadata.scenarioReleaseId, id);
      assert.equal(metadata.ruleStatus, 'needs_review');
      assert.ok(metadata.items.length > 0);
      for (const {sourceUrl, title, publisher, scopeNote} of metadata.items) {
        const url = new URL(sourceUrl);
        assert.equal(url.protocol, 'https:');
        assert.equal(url.hostname, host);
        assert.ok(title.trim() && publisher.trim() && scopeNote.trim());
      }
      if (code === overseas.code) {
        const cbam = metadata.items.find(item => item.code === 'eu-cbam-definitive');
        assert.match(cbam.scopeNote, /明确索取 CBAM 数据.*单独确认.*适用义务/);
      }

      await request('customer', 'GET', `/v1/customer/scenarios/${randomUUID()}/references?orgId=${orgId}`, 404);
      const created = await request('customer', 'POST', '/v1/customer/cases', 201, {orgId, scenarioReleaseId: id, purpose});
      assert.equal(created.scenarioReleaseId, id);
      const customer = `/v1/customer/cases/${created.id}`;
      const professional = `/v1/professional/cases/${created.id}`;
      await request('reviewer', 'GET', `${professional}?orgId=${orgId}`, 404);

      const evidence = await request('customer', 'POST', `${customer}/evidence`, 201, {
        orgId, title: materialTitle, sourceDescription: '演示资料待上传'
      });
      assert.equal(evidence.status, 'pending_file');
      if (code === product.code || code === overseas.code) {
        const {batchId, previewRevision} = await request('customer', 'POST', `${customer}/imports`, 200, {
          orgId, csv: 'period,source,quantity,unit\n2026-01,electricity,1,MWh\n2026-01,natural_gas,0,m3'
        });
        await request('customer', 'POST', `${customer}/imports/${batchId}/commit`, 200, {orgId, previewRevision});
        const snapshot = await request('customer', 'POST', `${customer}/calculation-snapshots`, 201, {
          orgId, from: '2026-01', to: '2026-01'
        });
        const drafts = `${customer}/internal-report-drafts`;
        await request('customer', 'POST', drafts, 400, {
          orgId, snapshotId: snapshot.snapshotId, externalDeliveryEligible: true
        });
        const draft = await request('customer', 'POST', drafts, 201, {orgId, snapshotId: snapshot.snapshotId});
        assert.equal(draft.mode, 'synthetic');
        assert.equal(draft.formalReportEligible, false);
        assert.equal(draft.externalDeliveryEligible, false);
      }
      const submitted = await request('customer', 'POST', `${customer}/submit`, 200, {orgId, revision: created.revision});
      const reviewedCase = await request('reviewer', 'GET', `${professional}?orgId=${orgId}`, 200);
      assert.equal(reviewedCase.scenarioReleaseId, id);
      assert.equal(reviewedCase.status, 'submitted');
      const materials = await request('reviewer', 'GET', `${professional}/evidence?orgId=${orgId}`, 200);
      assert.deepEqual(materials.items.map(({id, title, status}) => ({id, title, status})), [
        {id: evidence.id, title: materialTitle, status: 'pending_file'}
      ]);

      const reason = '请补充场景适用条件和材料';
      const returned = await request('reviewer', 'POST', `${professional}/review`, 200, {
        orgId, revision: submitted.revision, decision: 'returned', reason
      });
      assert.equal(returned.scenarioReleaseId, id);
      assert.equal(returned.status, 'returned');
      assert.equal(returned.returnReason, reason);
      const audit = await request('admin', 'GET', `/v1/admin/organizations/${orgId}/audit`, 200);
      const events = audit.events.filter(event => event.caseId === created.id);
      assert.deepEqual(events.map(event => event.action), ['returned', 'submitted', 'created']);
      assert.equal(events[0].reason, reason);
    });
  }
});
