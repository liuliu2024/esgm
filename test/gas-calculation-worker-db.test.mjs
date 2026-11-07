import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createEmbeddedDatabase } from '../infra/embedded.mjs';
import { migrate } from '../infra/migrations.mjs';

test('calculation worker role claims and finishes only a leased job in the selected workspace', async t => {
  const db = await createEmbeddedDatabase();
  t.after(() => db.close());
  await migrate(db.admin);
  const [tenant, otherTenant, org, release, owner, task, job, lease, invalidLease] =
    Array.from({length: 9}, randomUUID);
  const request = 'worker-role-db-test';
  await db.admin.transaction(async tx => {
    await tx.query("INSERT INTO carbon.workspace VALUES ($1, 'Workspace'), ($2, 'Other')", [tenant, otherTenant]);
    await tx.query("INSERT INTO carbon.organization VALUES ($1, $2, 'Plant')", [tenant, org]);
    await tx.query(`INSERT INTO carbon.scenario_release (tenant_id, id, code, version, manifest)
      VALUES ($1, $2, 'power-generation-combustion', 1, '{}')`, [tenant, release]);
    await tx.query("INSERT INTO carbon.org_grant VALUES ($1, $2, $3, 'customer')", [tenant, org, owner]);
    await tx.exec('CREATE ROLE carbon_embedded_worker LOGIN; GRANT carbon_calculation_worker TO carbon_embedded_worker');
    await tx.query(`INSERT INTO carbon.calculation_worker_tenant_grant (login_role, tenant_id)
      VALUES ('carbon_embedded_worker'::regrole, $1)`, [tenant]);
  });

  const act = callback => db.runtime.transaction(async tx => {
    await tx.query(`SELECT set_config('carbon.tenant_id', $1, true),
      set_config('carbon.actor_id', $2, true), set_config('carbon.request_id', $3, true)`,
    [tenant, owner, request]);
    return callback(tx);
  });
  async function worker(callback, workspace = tenant) {
    try {
      return await db.admin.transaction(async tx => {
        await tx.exec('SET LOCAL SESSION AUTHORIZATION carbon_embedded_worker');
        if (workspace) await tx.query("SELECT set_config('carbon.tenant_id', $1, true)", [workspace]);
        return callback(tx);
      });
    } finally {
      // PGlite uses one connection and retains SESSION AUTHORIZATION after the transaction.
      await db.admin.transaction(tx => tx.exec('SET SESSION AUTHORIZATION postgres'));
    }
  }
  await act(async tx => {
    await tx.query(`INSERT INTO carbon.case_intake
      (tenant_id, org_id, scenario_release_id, created_by, id, purpose, intake_scope)
      VALUES ($1, $2, $3, $4, $5, 'Power plant gas calculation', '{"subjectType":"facility","reportingYear":"2026"}')`,
    [tenant, org, release, owner, task]);
    await tx.query("UPDATE carbon.case_intake SET status = 'submitted', revision = 2 WHERE id = $1", [task]);
    await tx.query(`INSERT INTO carbon.gas_calculation_job
      (tenant_id, org_id, case_id, submission_revision, id, from_period, to_period, created_by, request_id)
      VALUES ($1, $2, $3, 2, $4, '2026-01-01', '2026-01-01', $5, $6)`, [tenant, org, task, job, owner, request]);
  });

  const claim = (tx, scope = tenant) => tx.query(
    'SELECT id, org_id, case_id, submission_revision, created_by FROM carbon.claim_gas_calculation_job($1, $2)', [scope, lease]);
  const finish = (tx, claimToken, scope = tenant) => tx.query(
    "SELECT carbon.finish_gas_calculation_job($1, $2, $3, NULL, 'FIXTURE_FAILURE') AS finished", [scope, job, claimToken]);
  await assert.rejects(act(claim), {code: '42501'});
  await assert.rejects(act(tx => finish(tx, lease)), {code: '42501'});
  await assert.rejects(worker(tx => tx.query('SELECT id FROM carbon.gas_calculation_job')), {code: '42501'});
  await assert.rejects(worker(tx => tx.query('SELECT id FROM carbon.case_intake')), {code: '42501'});
  assert.deepEqual((await worker(claim, null)).rows, []);
  assert.deepEqual((await worker(tx => claim(tx, otherTenant))).rows, []);
  assert.deepEqual((await worker(claim)).rows, [{
    id: job, org_id: org, case_id: task, submission_revision: 2, created_by: owner
  }]);
  assert.deepEqual((await worker(claim)).rows, []);
  assert.deepEqual((await worker(tx => finish(tx, lease), null)).rows, [{finished: false}]);
  assert.deepEqual((await worker(tx => finish(tx, lease, otherTenant))).rows, [{finished: false}]);
  assert.deepEqual((await worker(tx => finish(tx, invalidLease))).rows, [{finished: false}]);
  assert.deepEqual((await worker(tx => finish(tx, lease))).rows, [{finished: true}]);
  assert.deepEqual((await worker(tx => finish(tx, lease))).rows, [{finished: false}]);
  assert.deepEqual((await act(tx => tx.query(`SELECT status, attempts, lease_token, error_code
    FROM carbon.gas_calculation_job WHERE id = $1`, [job]))).rows,
  [{status: 'failed', attempts: 1, lease_token: null, error_code: 'FIXTURE_FAILURE'}]);
});
