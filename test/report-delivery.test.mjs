import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createEmbeddedDatabase } from '../infra/embedded.mjs';
import { migrate } from '../infra/migrations.mjs';
import { createCarbonApi } from '../src/index.mjs';

test('named report delivery authorizes a minimal immutable document for a reviewed current report', async t => {
  const [tenantId, orgId, release, owner, reviewer, peer] = Array.from({length: 6}, () => randomUUID());
  const db = await createEmbeddedDatabase();
  t.after(() => db.close());
  await migrate(db.admin);
  await db.admin.transaction(async tx => {
    await tx.query("INSERT INTO carbon.workspace VALUES ($1, 'Delivery')", [tenantId]);
    await tx.query("INSERT INTO carbon.organization VALUES ($1, $2, 'Primary')", [tenantId, orgId]);
    await tx.query("INSERT INTO carbon.scenario_release VALUES ($1, $2, 'inventory', 1, '{}')", [tenantId, release]);
    await tx.query(`INSERT INTO carbon.org_grant VALUES ($1, $2, $3, 'customer'),
      ($1, $2, $4, 'reviewer'), ($1, $2, $5, 'customer')`, [tenantId, orgId, owner, reviewer, peer]);
  });
  const api = createCarbonApi(db.runtime);
  async function request(status, method, path, body, actorId = owner) {
    const result = await api.dispatch({method, path, body}, {tenantId, actorId, requestId: randomUUID()});
    assert.equal(result.status, status, `${method} ${path} ${JSON.stringify(result.body)}`);
    return result.body;
  }
  const query = `?orgId=${orgId}`;
  const task = await request(201, 'POST', '/v1/customer/cases', {
    orgId, scenarioReleaseId: release, purpose: 'INTERNAL_CASE_PURPOSE',
    scope: {subjectType: 'product', subjectName: '设备 <A>', jurisdiction: '上海市', reportingYear: '2024', recipient: 'INTERNAL_RECIPIENT'}
  });
  const customer = `/v1/customer/cases/${task.id}`;
  const professional = `/v1/professional/cases/${task.id}`;
  const drafts = `${customer}/internal-report-drafts`;
  const batch = await request(200, 'POST', `${customer}/imports`, {
    orgId, csv: 'period,source,quantity,unit\n2024-01,electricity,1,MWh\n2024-01,natural_gas,200,m3'
  });
  await request(200, 'POST', `${customer}/imports/${batch.batchId}/commit`, {orgId, previewRevision: batch.previewRevision});
  const january = {orgId, from: '2024-01', to: '2024-01'};
  const snapshot = await request(201, 'POST', `${customer}/calculation-snapshots`, january);
  const synthetic = await request(201, 'POST', drafts, {orgId, snapshotId: snapshot.snapshotId});
  const submitted = await request(200, 'POST', `${customer}/submit`, {orgId, revision: task.revision});
  const version = `${professional}/revisions/${submitted.revision}`;
  const {decision} = await request(201, 'POST', `${version}/factor-decision`, {
    orgId, factorId: 'cn-electricity-product-average', factorVersion: 1, accountingBasis: 'product_footprint',
    regionCode: 'CN', dataYear: 2024, methodReference: 'INTERNAL_METHOD', rationale: 'INTERNAL_RATIONALE'
  }, reviewer);
  const createDraft = range => request(201, 'POST', `${customer}/revisions/${submitted.revision}/internal-report-drafts`, range);
  const complete = await createDraft(january);
  const partial = await createDraft({...january, to: '2024-02'});
  const collection = draft => `${drafts}/${draft.draftId}/deliveries`;
  const minimal = {orgId, recipient: '采购方 <script>alert("buyer")</script> & Co',
    purpose: "采购方 '材料'确认", includeMonthly: false, includeFactor: false};
  const full = {...minimal, includeMonthly: true, includeFactor: true};
  const deliver = (status, draft, options = minimal, actorId = owner) =>
    request(status, 'POST', collection(draft), options, actorId);
  const review = async draft => {
    await request(201, 'POST', `${drafts}/${draft.draftId}/submit-review`, {orgId});
    await request(200, 'POST', `${professional}/internal-report-drafts/${draft.draftId}/review`,
      {orgId, decision: 'reviewed'}, reviewer);
  };
  await deliver(409, complete);
  await review(partial);
  await deliver(409, partial);
  await review(synthetic);
  await deliver(409, synthetic);
  await review(complete);
  await deliver(400, complete, {...minimal, includeFactor: 'true'});
  await deliver(403, complete, minimal, reviewer);
  await deliver(404, complete, minimal, peer);
  await request(404, 'GET', `${professional}/internal-report-drafts/${complete.draftId}/deliveries${query}`, undefined, reviewer);

  const first = await deliver(201, complete);
  assert.equal(first.draftId, complete.draftId);
  assert.equal(first.status, 'prepared');
  assert.equal(first.recipient, minimal.recipient);
  assert.equal(first.purpose, minimal.purpose);
  assert.equal(first.recordedAt, null);
  assert.equal(first.deliveryReference, null);
  assert.deepEqual(await deliver(200, complete), first);
  const second = await deliver(201, complete, full);
  assert.notEqual(second.deliveryId, first.deliveryId);
  const monthlyOnly = await deliver(201, complete, {...minimal, includeMonthly: true});
  const factorOnly = await deliver(201, complete, {...minimal, includeFactor: true});
  const firstPath = `${collection(complete)}/${first.deliveryId}`;
  const secondPath = `${collection(complete)}/${second.deliveryId}`;
  const get = path => request(200, 'GET', path + query);
  await request(404, 'GET', firstPath + query, undefined, peer);
  await request(404, 'GET', `${collection(partial)}/${first.deliveryId}${query}`);
  const {items} = await get(collection(complete));
  assert.deepEqual(new Set(items.map(item => item.deliveryId)),
    new Set([first.deliveryId, second.deliveryId, monthlyOnly.deliveryId, factorOnly.deliveryId]));
  assert.ok(items.every(item => !Object.hasOwn(item, 'documentHtml')));
  const bare = await get(firstPath);
  const detailed = await get(secondPath);
  for (const delivery of [bare, detailed]) {
    const html = delivery.documentHtml;
    assert.equal(delivery.documentSha256, createHash('sha256').update(html, 'utf8').digest('hex'));
    assert.ok(html.includes('577.7 kg CO₂e'));
    assert.ok(html.includes('设备 &lt;A&gt;'));
    assert.ok(html.includes('&lt;script&gt;alert(&quot;buyer&quot;)&lt;/script&gt; &amp; Co'));
    assert.ok(html.includes('采购方 &#39;材料&#39;确认'));
    for (const secret of [batch.batchId, owner, reviewer, 'INTERNAL_CASE_PURPOSE', 'INTERNAL_RECIPIENT',
      'INTERNAL_METHOD', 'INTERNAL_RATIONALE', '<script>']) {
      assert.ok(!html.includes(secret), `unexpected disclosure: ${secret}`);
    }
  }
  assert.doesNotMatch(bare.documentHtml, /月度汇总|公开因子来源|1000 kWh/);
  assert.ok(!bare.documentHtml.includes(decision.factor.sourceUrl));
  assert.match(detailed.documentHtml, /月度汇总[\s\S]*1000 kWh/);
  assert.match(detailed.documentHtml, /公开因子来源/);
  assert.ok(detailed.documentHtml.includes(decision.factor.sourceUrl));
  const monthlyHtml = (await get(`${collection(complete)}/${monthlyOnly.deliveryId}`)).documentHtml;
  assert.match(monthlyHtml, /月度汇总/);
  assert.doesNotMatch(monthlyHtml, /公开因子来源/);
  const factorHtml = (await get(`${collection(complete)}/${factorOnly.deliveryId}`)).documentHtml;
  assert.match(factorHtml, /公开因子来源/);
  assert.doesNotMatch(factorHtml, /月度汇总/);

  const record = (status, path, deliveryReference) =>
    request(status, 'POST', path + '/record', {orgId, deliveryReference});
  const recorded = await record(200, firstPath, '采购邮件存档 #A-1');
  assert.equal(recorded.status, 'recorded');
  assert.equal(recorded.deliveryReference, '采购邮件存档 #A-1');
  assert.ok(Number.isFinite(Date.parse(recorded.recordedAt)));
  assert.equal(recorded.documentSha256, first.documentSha256);
  assert.deepEqual(await record(200, firstPath, recorded.deliveryReference), recorded);
  await record(409, firstPath, '其他凭证');
  assert.equal((await get(firstPath)).documentHtml, bare.documentHtml);

  const returned = await request(200, 'POST', `${professional}/review`, {
    orgId, revision: submitted.revision, decision: 'returned', reason: '补充原始凭证'
  }, reviewer);
  await request(200, 'POST', `${customer}/resubmit`, {orgId, revision: returned.revision, correctionNote: '已补充'});
  const historical = await get(firstPath);
  assert.equal(historical.documentHtml, null);
  assert.equal(historical.documentSha256, first.documentSha256);
  assert.equal(historical.deliveryReference, recorded.deliveryReference);
  assert.equal((await get(secondPath)).documentHtml, null);
  await deliver(409, complete);
  await record(409, secondPath, '过期交付');
  await record(409, firstPath, recorded.deliveryReference);
});
