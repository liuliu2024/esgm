import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { connectPostgres } from '../infra/postgres.mjs';
import { migrate } from '../infra/migrations.mjs';
import { createCarbonApi } from '../src/index.mjs';

const migrationUrl = process.env.CARBON_TEST_MIGRATION_DATABASE_URL;
const runtimeUrl = process.env.CARBON_TEST_APP_DATABASE_URL;

test('PostgreSQL 17 connection pool isolates context and resolves competing reviews', {
  skip: !migrationUrl && !runtimeUrl
}, async () => {
  assert.ok(migrationUrl && runtimeUrl, 'Both dedicated test connection strings are required');
  assert.equal(new URL(migrationUrl).pathname, '/carbon_test');
  assert.equal(new URL(runtimeUrl).pathname, '/carbon_test');
  assert.equal(new URL(runtimeUrl).username, 'carbon_test_app');
  const admin = connectPostgres(migrationUrl, { migration: true });
  const runtime = connectPostgres(runtimeUrl, { max: 3 });
  try {
    await migrate(admin);
    const tenantId = randomUUID(), orgId = randomUUID(), scenarioReleaseId = randomUUID();
    const customer = randomUUID(), reviewer = randomUUID(), administrator = randomUUID();
    await admin.transaction(async tx => {
      await tx.query('GRANT carbon_app TO carbon_test_app');
      await tx.query("INSERT INTO carbon.workspace (id, name) VALUES ($1, 'Postgres integration')", [tenantId]);
      await tx.query("INSERT INTO carbon.organization (tenant_id, id, name) VALUES ($1, $2, 'Integration org')", [tenantId, orgId]);
      await tx.query("INSERT INTO carbon.scenario_release (tenant_id, id, code, version, manifest) VALUES ($1, $2, 'intake', 1, '{}')", [tenantId, scenarioReleaseId]);
      for (const [actor, role] of [[customer, 'customer'], [reviewer, 'reviewer'], [administrator, 'admin']]) {
        await tx.query('INSERT INTO carbon.org_grant (tenant_id, org_id, actor_id, role) VALUES ($1, $2, $3, $4)',
          [tenantId, orgId, actor, role]);
      }
    });
    const api = createCarbonApi(runtime);
    const dispatch = (actorId, method, path, body) =>
      api.dispatch({ method, path, body }, { tenantId, actorId, requestId: randomUUID() });
    const created = await dispatch(customer, 'POST', '/v1/customer/cases', { orgId, scenarioReleaseId, purpose: '并行复核验证' });
    assert.equal(created.status, 201);
    const id = created.body.id;
    const submitted = await dispatch(customer, 'POST', `/v1/customer/cases/${id}/submit`, { orgId, revision: 1 });
    assert.equal(submitted.status, 200);

    const reviewPath = `/v1/professional/cases/${id}/review`;
    const results = await Promise.all([
      dispatch(reviewer, 'POST', reviewPath, { orgId, revision: 2, decision: 'approved' }),
      dispatch(reviewer, 'POST', reviewPath, { orgId, revision: 2, decision: 'returned', reason: '补充期间' })
    ]);
    assert.deepEqual(results.map(item => item.status).sort(), [200, 409]);
    const audit = await dispatch(administrator, 'GET', `/v1/admin/organizations/${orgId}/audit`);
    assert.equal(audit.status, 200);
    assert.equal(audit.body.events.length, 3);
    assert.equal(audit.body.events[0].revision, 3);

    const { rows } = await runtime.transaction(tx => tx.query('SELECT id FROM carbon.case_intake'));
    assert.equal(rows.length, 0, 'an unscoped pool checkout must see no cases');
  } finally {
    await Promise.all([runtime.close(), admin.close()]);
  }
});
