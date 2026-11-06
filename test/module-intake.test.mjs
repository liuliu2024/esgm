import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { startDemo } from '../infra/demo-data.mjs';

const scenes = [
  ['verification-prep', 'www.mee.gov.cn', '待核查报告'],
  ['compliance-prep', 'www.mee.gov.cn', '履约配额记录'],
  ['zero-carbon-prep', 'www.ndrc.gov.cn', '设施用能基线'],
  ['esg-disclosure-prep', 'kjs.mof.gov.cn', '披露指标证据']
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
