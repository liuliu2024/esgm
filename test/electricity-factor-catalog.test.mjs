import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { startDemo } from '../infra/demo-data.mjs';

test('electricity regions distinguish accounting bases and support a Shanghai delivery', async t => {
  const demo = await startDemo();
  t.after(() => demo.close());
  const {orgId, scenarioReleaseId} = demo;
  async function request(status, role, method, path, body) {
    const result = await demo.dispatch(role, method, path, body);
    assert.equal(result.status, status, `${method} ${path} ${JSON.stringify(result.body)}`);
    return result.body;
  }
  const regionPath = '/v1/professional/factor-reference-regions';
  const referencePath = '/v1/professional/factor-references';
  const organization = 'organization_electricity_co2';
  const product = 'product_footprint';
  const regions = (accountingBasis, dataYear, organizationId = orgId) =>
    `${regionPath}?${new URLSearchParams({orgId: organizationId, accountingBasis, dataYear})}`;
  const shanghaiList = regions(organization, '2023');
  const {items} = await request(200, 'reviewer', 'GET', shanghaiList);
  assert.equal(items.length, 38);
  const byCode = new Map(items.map(({regionCode, regionName}) => [regionCode, regionName]));
  assert.equal(byCode.size, 38);
  assert.ok(byCode.has('CN'));
  assert.equal(items.filter(item => /^CN-G[A-Z]{2}$/.test(item.regionCode)).length, 7);
  assert.equal(items.filter(item => /^CN-[A-Z]{2}$/.test(item.regionCode)).length, 30);
  assert.match(byCode.get('CN-SH'), /上海/);
  assert.ok(items.every(item => typeof item.regionName === 'string' && item.regionName.trim() &&
    Object.keys(item).sort().join(',') === 'regionCode,regionName'));
  for (const year of ['2023', '2024']) {
    const {items: productRegions} = await request(200, 'reviewer', 'GET', regions(product, year));
    assert.deepEqual(productRegions.map(({regionCode}) => regionCode), ['CN']);
  }
  assert.deepEqual(await request(200, 'reviewer', 'GET', regions(organization, '1900')), {items: []});
  await request(403, 'customer', 'GET', shanghaiList);
  await request(403, 'admin', 'GET', shanghaiList);
  await request(403, 'reviewer', 'GET', regions(organization, '2023', randomUUID()));
  await request(400, 'reviewer', 'GET', regions(organization, '23'));
  await request(400, 'reviewer', 'GET', shanghaiList + '&regionCode=CN-SH');

  const references = (accountingBasis, regionCode, dataYear) =>
    request(200, 'reviewer', 'GET', `${referencePath}?${new URLSearchParams({orgId, accountingBasis, regionCode, dataYear})}`);
  const {items: shanghaiMatches} = await references(organization, 'CN-SH', '2023');
  assert.equal(shanghaiMatches.length, 1);
  const [shanghai] = shanghaiMatches;
  assert.equal(shanghai.factorId, 'cn-electricity-organization-sh-2023');
  assert.equal(shanghai.value, '0.5737');
  assert.equal(shanghai.inputUnit, 'kWh');
  assert.equal(shanghai.outputUnit, 'kgCO2');
  const {items: [nationalProduct]} = await references(product, 'CN', '2023');
  assert.equal(nationalProduct.value, '0.6205');
  assert.equal(nationalProduct.outputUnit, 'kgCO2e');
  assert.deepEqual(await references(product, 'CN-SH', '2023'), {items: []});
  assert.deepEqual(await references(organization, 'CN-SH', '2024'), {items: []});

  const task = await request(201, 'customer', 'POST', '/v1/customer/cases', {
    orgId, scenarioReleaseId, purpose: '上海用电管理',
    scope: {subjectType: 'organization', subjectName: '上海样例组织', jurisdiction: '上海市',
      reportingYear: '2023', recipient: '样例采购方'}
  });
  const customer = `/v1/customer/cases/${task.id}`;
  const professional = `/v1/professional/cases/${task.id}`;
  const drafts = `${customer}/internal-report-drafts`;
  const batch = await request(200, 'customer', 'POST', `${customer}/imports`, {
    orgId, csv: 'period,source,quantity,unit\n2023-01,electricity,1,MWh\n2023-01,natural_gas,200,m3'
  });
  await request(200, 'customer', 'POST', `${customer}/imports/${batch.batchId}/commit`, {orgId, previewRevision: batch.previewRevision});
  const range = {orgId, from: '2023-01', to: '2023-01'};
  const original = await request(201, 'customer', 'POST', `${customer}/calculation-snapshots`, range);
  const synthetic = await request(201, 'customer', 'POST', drafts, {orgId, snapshotId: original.snapshotId});
  assert.equal(synthetic.mode, 'synthetic');
  assert.equal(synthetic.report.summary.totalKgCO2e, '900');
  const submitted = await request(200, 'customer', 'POST', `${customer}/submit`, {orgId, revision: task.revision});
  const version = `${professional}/revisions/${submitted.revision}`;
  const {decision} = await request(201, 'reviewer', 'POST', `${version}/factor-decision`, {
    orgId, factorId: shanghai.factorId, factorVersion: shanghai.version, accountingBasis: organization,
    regionCode: 'CN-SH', dataYear: 2023, methodReference: '2023 组织购电方法', rationale: '活动和因子均对应上海及 2023 年'
  });
  assert.deepEqual(decision.factor, shanghai);
  const preview = await request(200, 'reviewer', 'GET', `${version}/calculation-preview?${new URLSearchParams(range)}`);
  assert.equal(preview.totalKg, '573.7');
  assert.equal(preview.outputUnit, 'kgCO2');
  assert.equal(preview.items[0].quantity, '1000');
  const frozen = await request(201, 'customer', 'POST',
    `${customer}/revisions/${submitted.revision}/internal-report-drafts`, range);
  assert.equal(frozen.mode, 'controlled');
  assert.equal(frozen.report.summary.totalKg, '573.7');
  assert.equal(frozen.report.summary.outputUnit, 'kgCO2');
  assert.deepEqual(frozen.report.factorDecision.factor, shanghai);
  assert.equal(frozen.formalReportEligible, false);
  assert.equal(frozen.externalDeliveryEligible, false);
  const frozenPath = `${drafts}/${frozen.draftId}`;
  await request(201, 'customer', 'POST', `${frozenPath}/submit-review`, {orgId});
  const {review} = await request(200, 'reviewer', 'POST',
    `${professional}/internal-report-drafts/${frozen.draftId}/review`, {orgId, decision: 'reviewed'});
  assert.equal(review.status, 'reviewed');
  const deliveryPath = `${frozenPath}/deliveries`;
  const delivery = await request(201, 'customer', 'POST', deliveryPath, {
    orgId, recipient: '样例采购方', purpose: '核对上海购电排放', includeMonthly: true, includeFactor: true
  });
  const detail = await request(200, 'customer', 'GET', `${deliveryPath}/${delivery.deliveryId}?orgId=${orgId}`);
  assert.match(detail.documentHtml, /573\.7 kg CO₂(?!e)/);
  assert.match(detail.documentHtml, /0\.5737 kg CO₂\/kWh/);
  assert.match(detail.documentHtml, /1000 kWh/);
  assert.ok(detail.documentHtml.includes(shanghai.sourceUrl));
  assert.doesNotMatch(detail.documentHtml, /0\.6205|kg CO₂e/);
});
