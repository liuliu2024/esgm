import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { createEmbeddedDatabase } from '../infra/embedded.mjs';
import { migrate } from '../infra/migrations.mjs';
import { createCarbonApi } from '../src/index.mjs';

const [tenantId, orgId, siblingOrgId, otherTenantId, otherOrgId, reviewer, customer] =
  Array.from({length: 7}, () => randomUUID());
const product = {orgId, accountingBasis: 'product_footprint', regionCode: 'CN', dataYear: '2024'};
const organization = {...product, accountingBasis: 'organization_electricity_co2', dataYear: '2023'};
const path = '/v1/professional/factor-references';
let db;
let api;

before(async () => {
  db = await createEmbeddedDatabase();
  await migrate(db.admin);
  await db.admin.transaction(async tx => {
    await tx.query("INSERT INTO carbon.workspace (id, name) VALUES ($1, 'Primary'), ($2, 'Other')", [tenantId, otherTenantId]);
    await tx.query(`INSERT INTO carbon.organization (tenant_id, id, name)
      VALUES ($1, $2, 'Primary'), ($1, $3, 'Sibling'), ($4, $5, 'Other')`,
    [tenantId, orgId, siblingOrgId, otherTenantId, otherOrgId]);
    await tx.query(`INSERT INTO carbon.org_grant (tenant_id, org_id, actor_id, role)
      VALUES ($1, $2, $3, 'reviewer'), ($1, $2, $4, 'customer'), ($5, $6, $3, 'reviewer')`,
    [tenantId, orgId, reviewer, customer, otherTenantId, otherOrgId]);
  });
  api = createCarbonApi(db.runtime);
});

after(async () => { await db?.close(); });

function get(query, actorId = reviewer, workspaceId = tenantId) {
  return api.dispatch({method: 'GET', path: `${path}?${new URLSearchParams(query)}`},
    {tenantId: workspaceId, actorId, requestId: randomUUID()});
}

test('factor references match the exact accounting basis, geography and year', async () => {
  for (const [query, factorId, value, outputUnit, sourceUrl] of [
    [product, 'cn-electricity-product-average', '0.5777', 'kgCO2e',
      'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk01/202510/W020251024569470952545.pdf'],
    [organization, 'cn-electricity-organization-average', '0.5306', 'kgCO2',
      'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk01/202512/W020251231726284332528.pdf']
  ]) {
    const response = await get(query);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.items.length, 1);
    const [{sourceTitle, sourceLocator, usageNote, ...factor}] = response.body.items;
    assert.deepEqual(factor, {factorId, version: 1, accountingBasis: query.accountingBasis,
      regionCode: 'CN', dataYear: Number(query.dataYear), value, inputUnit: 'kWh', outputUnit, sourceUrl});
    assert.match(sourceTitle, new RegExp(query.dataYear));
    assert.match(sourceLocator, /表 1/);
    assert.match(usageNote, /仅供参考/);
  }

  for (const query of [
    {...product, dataYear: '2023'}, {...organization, dataYear: '2024'},
    {...product, regionCode: 'CN-31'}, {...product, regionCode: 'US'}
  ]) {
    assert.deepEqual(await get(query), {status: 200, body: {items: []}});
  }
});

test('factor references require all four valid parameters and an active reviewer grant in the selected organization', async () => {
  for (const key of Object.keys(product)) {
    const query = {...product};
    delete query[key];
    assert.equal((await get(query)).status, 400, `missing ${key}`);
  }
  const duplicate = new URLSearchParams(product);
  duplicate.append('dataYear', '2023');
  for (const query of [
    {...product, orgId: 'invalid'}, {...product, accountingBasis: 'synthetic'},
    {...product, regionCode: 'cn'}, {...product, dataYear: '0000'},
    {...product, dataYear: '2024.0'}, {...product, fallback: 'true'}, duplicate
  ]) {
    assert.equal((await get(query)).status, 400, new URLSearchParams(query).toString());
  }

  assert.equal((await get(product, customer)).status, 403);
  assert.equal((await get({...product, orgId: siblingOrgId})).status, 403);
  assert.equal((await get({...product, orgId: otherOrgId})).status, 403);
  assert.equal((await get(product, reviewer, otherTenantId)).status, 403);
  assert.equal((await get({...product, orgId: otherOrgId}, reviewer, otherTenantId)).status, 200);

  await db.admin.transaction(tx => tx.query(`DELETE FROM carbon.org_grant
    WHERE tenant_id = $1 AND org_id = $2 AND actor_id = $3 AND role = 'reviewer'`, [tenantId, orgId, reviewer]));
  assert.equal((await get(product)).status, 403);
});
