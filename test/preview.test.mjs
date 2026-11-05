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
    const created = await post('/v1/customer/cases', {
      orgId, scenarioReleaseId, purpose: '准备采购方碳数据报告'
    }, 201);
    const customer = `/v1/customer/cases/${created.id}`;
    const professional = `/v1/professional/cases/${created.id}`;
    const submitted = await post(customer + '/submit', { orgId, revision: created.revision });
    const returned = await post(professional + '/review', {
      orgId, revision: submitted.revision, decision: 'returned', reason: '补充报告期间'
    });
    const resubmitted = await post(customer + '/resubmit', {
      orgId, revision: returned.revision, correctionNote: '报告期间为 2026 年'
    });
    const reviewQueue = await read(`/v1/professional/cases?orgId=${orgId}`);
    assert.equal(reviewQueue.cases[0].nextAction, 'review');
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
