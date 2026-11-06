import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createEmbeddedDatabase } from '../infra/embedded.mjs';
import { migrate } from '../infra/migrations.mjs';

test('case-scoped import appends exact activity revisions and makes replay and conflicts atomic', async t => {
  const db = await createEmbeddedDatabase();
  t.after(() => db.close());
  await db.admin.transaction(tx => tx.exec(`
    CREATE ROLE carbon_ledger_migrator NOLOGIN NOSUPERUSER NOBYPASSRLS CREATEROLE;
    GRANT CREATE ON DATABASE postgres TO carbon_ledger_migrator;
  `));
  await migrate({transaction: callback => db.admin.transaction(async tx => {
    await tx.exec('SET LOCAL ROLE carbon_ledger_migrator');
    return callback(tx);
  })});
  const [tenant, org, release, customer, peer, intake, firstBatch, nextBatch] =
    Array.from({length: 8}, () => randomUUID());
  await db.admin.transaction(async tx => {
    await tx.query("INSERT INTO carbon.workspace VALUES ($1, 'Workspace')", [tenant]);
    await tx.query("INSERT INTO carbon.organization VALUES ($1, $2, 'Organization')", [tenant, org]);
    await tx.query("INSERT INTO carbon.scenario_release VALUES ($1, $2, 'inventory', 1, '{}')", [tenant, release]);
    await tx.query("INSERT INTO carbon.org_grant VALUES ($1, $2, $3, 'customer'), ($1, $2, $4, 'customer')",
      [tenant, org, customer, peer]);
  });
  const act = (callback, actor = customer) => db.runtime.transaction(async tx => {
    await tx.query(`SELECT set_config('carbon.tenant_id', $1, true), set_config('carbon.actor_id', $2, true),
      set_config('carbon.request_id', 'ledger-test', true)`, [tenant, actor]);
    return callback(tx);
  });
  await act(async tx => {
    await tx.query(`INSERT INTO carbon.case_intake (tenant_id, org_id, scenario_release_id, created_by, id, purpose)
      VALUES ($1, $2, $3, $4, $5, 'Inventory')`, [tenant, org, release, customer, intake]);
    for (const [batchId, csv] of [
      [firstBatch, 'period,source,quantity,unit\n2025-01,electricity,0,MWh'],
      [nextBatch, 'period,source,quantity,unit\n2025-01,electricity,1.0000000000000001,MWh']
    ]) {
      await tx.query(`INSERT INTO carbon.ingestion_batch
        (tenant_id, org_id, case_id, id, source_sha256, template_version, source_csv, created_by, request_id)
        VALUES ($1, $2, $3, $4, $5, 'activity-csv-v1', $6, $7, 'ledger-test')`,
      [tenant, org, intake, batchId, createHash('sha256').update(csv).digest('hex'), csv, customer]);
    }
  });
  const row = {row: 2, period: '2025-01', source: 'electricity', originalQuantity: '0', originalUnit: 'MWh',
    quantity: '0', unit: 'kWh', action: 'insert', baseRevision: null};
  const correction = {...row, originalQuantity: '1.0000000000000001', quantity: '1000.0000000000001'};
  const storePreview = (batchId, revision, rows) => act(tx => tx.query(`INSERT INTO carbon.ingestion_preview
    (tenant_id, org_id, case_id, batch_id, revision, status, summary, issues, preview, created_by, request_id)
    VALUES ($1, $2, $3, $4, $5, 'ready', '{}', '[]', $6::jsonb, $7, 'ledger-test')`,
  [tenant, org, intake, batchId, revision, JSON.stringify(rows), customer]));
  const commit = (batchId, revision, actor) => act(
    tx => tx.query('SELECT * FROM carbon.commit_activity_import($1, $2, $3, $4)', [org, intake, batchId, revision]), actor);
  const readActivity = () => act(tx => tx.query(`SELECT revision, quantity::text, original_quantity
    FROM carbon.activity_record_revision ORDER BY revision`));
  await storePreview(firstBatch, 1, [row]);
  await storePreview(nextBatch, 1, [correction]);
  await assert.rejects(commit(firstBatch, 1, peer), {constraint: 'activity_import_not_found'});
  const first = await commit(firstBatch, 1);
  assert.equal(first.rows[0].inserted, 1);
  assert.deepEqual((await commit(firstBatch, 1)).rows, first.rows);
  await assert.rejects(commit(nextBatch, 1), {constraint: 'activity_import_stale_baseline'});
  assert.deepEqual((await readActivity()).rows, [{revision: 1, quantity: '0', original_quantity: '0'}]);
  assert.deepEqual((await act(tx => tx.query('SELECT batch_id FROM carbon.ingestion_commit'))).rows,
    [{batch_id: firstBatch}]);
  await storePreview(nextBatch, 2, [{...correction, action: 'correct', baseRevision: 1}]);
  await assert.rejects(commit(nextBatch, 1), {constraint: 'activity_import_stale_preview'});
  assert.equal((await commit(nextBatch, 2)).rows[0].corrected, 1);
  assert.deepEqual((await readActivity()).rows, [
    {revision: 1, quantity: '0', original_quantity: '0'},
    {revision: 2, quantity: '1000.0000000000001', original_quantity: '1.0000000000000001'}
  ]);
  assert.deepEqual((await act(tx => tx.query('SELECT * FROM carbon.ingestion_batch'), peer)).rows, []);
  await assert.rejects(act(tx => tx.query('UPDATE carbon.activity_record_revision SET quantity = 0')), {code: '42501'});
  await act(tx => tx.query("UPDATE carbon.case_intake SET status = 'submitted', revision = 2 WHERE id = $1", [intake]));
  assert.deepEqual((await commit(firstBatch, 1)).rows, first.rows);
  await db.admin.transaction(tx => tx.query('DELETE FROM carbon.org_grant WHERE actor_id = $1', [customer]));
  await assert.rejects(commit(firstBatch, 1), {constraint: 'activity_import_not_found'});
});
