import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createEmbeddedDatabase } from '../infra/embedded.mjs';
import { migrate } from '../infra/migrations.mjs';

test('internal report drafts keep a scoped frozen source and enforce demo-only immutable content', async t => {
  const db = await createEmbeddedDatabase();
  t.after(() => db.close());
  await migrate(db.admin);
  const [tenant, otherTenant, org, release, customer, peer, reviewer, intake, secondIntake, snapshotId, secondSnapshot, draftId] =
    Array.from({length: 12}, () => randomUUID());
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
      set_config('carbon.request_id', 'report-draft-test', true)`, [workspace, actor]);
    return callback(tx);
  });
  await act(async tx => {
    for (const [caseId, source] of [[intake, snapshotId], [secondIntake, secondSnapshot]]) {
      await tx.query(`INSERT INTO carbon.case_intake (tenant_id, org_id, scenario_release_id, created_by, id, purpose)
        VALUES ($1, $2, $3, $4, $5, 'Inventory')`, [tenant, org, release, customer, caseId]);
      await tx.query(`INSERT INTO carbon.calculation_snapshot
        (tenant_id, org_id, case_id, id, created_by, request_id, schema_version, from_period, to_period, input_fingerprint, payload)
        VALUES ($1, $2, $3, $4, $5, 'report-draft-test', 1, '2025-01-01', '2025-01-01', $6, $7)`,
      [tenant, org, caseId, source, customer, 'a'.repeat(64),
        {caseId, mode: 'synthetic', formalReportEligible: false, coverage: {status: 'complete'}}]);
    }
  });
  const payload = {caseId: intake, snapshotId, status: 'draft', mode: 'synthetic',
    formalReportEligible: false, externalDeliveryEligible: false,
    report: {watermark: '内部演示｜合成因子｜禁止外发', totalKgCO2e: '900.00000000000005'}};
  const insert = (tx, {result = payload, id = draftId, source = snapshotId, actor = customer} = {}) =>
    tx.query(`INSERT INTO carbon.internal_report_draft
      (tenant_id, org_id, case_id, id, snapshot_id, template_id, template_version, created_by, request_id, payload)
      VALUES ($1, $2, $3, $4, $5, 'internal-management-demo', 1, $6, 'report-draft-test', $7)
      ON CONFLICT (tenant_id, org_id, case_id, snapshot_id, template_id, template_version) DO NOTHING
      RETURNING id, created_at, payload`, [tenant, org, intake, id, source, actor, result]);
  const lookup = tx => tx.query('SELECT id, created_at, payload FROM carbon.internal_report_draft WHERE id = $1', [draftId]);

  for (const result of [
    {...payload, mode: 'production'},
    {...payload, status: 'approved'},
    {...payload, formalReportEligible: true},
    {...payload, externalDeliveryEligible: true},
    {...payload, externalDeliveryEligible: undefined},
    {...payload, report: {watermark: '其他标识'}},
    {...payload, caseId: secondIntake},
    {...payload, snapshotId: secondSnapshot}
  ]) {
    await assert.rejects(act(tx => insert(tx, {result})), {constraint: 'synthetic_internal_report_draft'});
  }
  await assert.rejects(act(tx => insert(tx, {
    source: secondSnapshot, result: {...payload, snapshotId: secondSnapshot}
  })), {code: '23503'});
  await assert.rejects(act(tx => insert(tx, {actor: peer}), peer), {code: '42501'});
  await assert.rejects(act(tx => insert(tx, {actor: reviewer}), reviewer), {code: '42501'});
  await assert.rejects(act(insert, customer, otherTenant), {code: '42501'});

  const {rows: [saved]} = await act(insert);
  assert.equal(saved.id, draftId);
  assert.deepEqual(saved.payload, payload);
  assert.deepEqual((await act(tx => insert(tx, {id: randomUUID()}))).rows, []);
  assert.deepEqual((await act(lookup)).rows, [saved]);
  assert.deepEqual((await act(lookup, peer)).rows, []);
  assert.deepEqual((await act(lookup, customer, otherTenant)).rows, []);
  await act(tx => tx.query("UPDATE carbon.case_intake SET status = 'submitted', revision = 2 WHERE id = $1", [intake]));
  assert.deepEqual((await act(lookup, reviewer)).rows, []);

  const update = tx => tx.query("UPDATE carbon.internal_report_draft SET template_version = 2 WHERE id = $1", [draftId]);
  const remove = tx => tx.query('DELETE FROM carbon.internal_report_draft WHERE id = $1', [draftId]);
  await assert.rejects(act(update), {code: '42501'});
  await assert.rejects(act(remove), {code: '42501'});
  await assert.rejects(db.admin.transaction(update), {code: '55000'});
  await assert.rejects(db.admin.transaction(remove), {code: '55000'});
  await db.admin.transaction(tx => tx.query('DELETE FROM carbon.org_grant WHERE actor_id = $1', [customer]));
  assert.deepEqual((await act(lookup)).rows, []);
  await assert.rejects(act(insert), {code: '42501'});
});
