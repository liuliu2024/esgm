import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createEmbeddedDatabase } from '../infra/embedded.mjs';
import { migrate } from '../infra/migrations.mjs';

test('calculation snapshots retain scoped, immutable synthetic results with a stable input key', async t => {
  const db = await createEmbeddedDatabase();
  t.after(() => db.close());
  await migrate(db.admin);
  const [tenant, otherTenant, org, release, customer, peer, reviewer, intake, snapshotId] =
    Array.from({length: 9}, () => randomUUID());
  await db.admin.transaction(async tx => {
    await tx.query("INSERT INTO carbon.workspace VALUES ($1, 'Workspace'), ($2, 'Other')", [tenant, otherTenant]);
    await tx.query("INSERT INTO carbon.organization VALUES ($1, $2, 'Organization')", [tenant, org]);
    await tx.query("INSERT INTO carbon.scenario_release VALUES ($1, $2, 'inventory', 1, '{}')", [tenant, release]);
    await tx.query(`INSERT INTO carbon.org_grant VALUES
      ($1, $2, $3, 'customer'), ($1, $2, $4, 'customer'), ($1, $2, $5, 'reviewer')`,
    [tenant, org, customer, peer, reviewer]);
  });
  const act = (callback, actor = customer, workspace = tenant) => db.runtime.transaction(async tx => {
    await tx.query(`SELECT set_config('carbon.tenant_id', $1, true), set_config('carbon.actor_id', $2, true),
      set_config('carbon.request_id', 'snapshot-test', true)`, [workspace, actor]);
    return callback(tx);
  });
  await act(tx => tx.query(`INSERT INTO carbon.case_intake (tenant_id, org_id, scenario_release_id, created_by, id, purpose)
    VALUES ($1, $2, $3, $4, $5, 'Inventory')`, [tenant, org, release, customer, intake]));
  const payload = {caseId: intake, mode: 'synthetic', formalReportEligible: false,
    coverage: {status: 'complete'}, totalKgCO2e: '900.00000000000005'};
  const insert = (tx, {result = payload, id = snapshotId, actor = customer, fingerprint = 'a'.repeat(64)} = {}) =>
    tx.query(`INSERT INTO carbon.calculation_snapshot
      (tenant_id, org_id, case_id, id, created_by, request_id, schema_version, from_period, to_period,
       input_fingerprint, payload)
      VALUES ($1, $2, $3, $4, $5, 'snapshot-test', 1, '2025-01-01', '2025-01-01', $6, $7)
      ON CONFLICT (tenant_id, org_id, case_id, input_fingerprint) DO NOTHING
      RETURNING id, created_at, payload`, [tenant, org, intake, id, actor, fingerprint, result]);
  const lookup = tx => tx.query('SELECT id, created_at, payload FROM carbon.calculation_snapshot WHERE id = $1', [snapshotId]);

  for (const result of [
    {...payload, mode: 'production'},
    {...payload, formalReportEligible: true},
    {...payload, formalReportEligible: undefined},
    {...payload, coverage: {status: 'partial'}},
    {...payload, caseId: randomUUID()}
  ]) {
    await assert.rejects(act(tx => insert(tx, {result})), {constraint: 'complete_synthetic_snapshot'});
  }
  await assert.rejects(act(tx => insert(tx, {actor: peer}), peer), {code: '42501'});
  await assert.rejects(act(tx => insert(tx, {actor: reviewer}), reviewer), {code: '42501'});
  await assert.rejects(act(insert, customer, otherTenant), {code: '42501'});

  const {rows: [saved]} = await act(insert);
  assert.deepEqual(saved.payload, payload);
  assert.equal(saved.id, snapshotId);
  assert.deepEqual((await act(tx => insert(tx, {id: randomUUID()}))).rows, []);
  assert.deepEqual((await act(lookup)).rows, [saved]);
  assert.deepEqual((await act(lookup, peer)).rows, []);
  assert.deepEqual((await act(lookup, reviewer)).rows, []);
  assert.deepEqual((await act(lookup, customer, otherTenant)).rows, []);
  await act(tx => tx.query("UPDATE carbon.case_intake SET status = 'submitted', revision = 2 WHERE id = $1", [intake]));
  assert.deepEqual((await act(lookup, reviewer)).rows, []);
  assert.deepEqual((await act(lookup)).rows, [saved]);

  const update = tx => tx.query('UPDATE carbon.calculation_snapshot SET schema_version = 2 WHERE id = $1', [snapshotId]);
  const remove = tx => tx.query('DELETE FROM carbon.calculation_snapshot WHERE id = $1', [snapshotId]);
  await assert.rejects(act(update), {code: '42501'});
  await assert.rejects(act(remove), {code: '42501'});
  await assert.rejects(db.admin.transaction(update), {code: '55000'});
  await assert.rejects(db.admin.transaction(remove), {code: '55000'});
  await db.admin.transaction(tx => tx.query('DELETE FROM carbon.org_grant WHERE actor_id = $1', [customer]));
  assert.deepEqual((await act(lookup)).rows, []);
  await assert.rejects(act(insert), {code: '42501'});
});
