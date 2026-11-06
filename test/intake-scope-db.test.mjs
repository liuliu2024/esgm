import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createEmbeddedDatabase } from '../infra/embedded.mjs';
import { migrate } from '../infra/migrations.mjs';

test('intake scope migration preserves legacy tasks and only the creator can set scope at creation', async t => {
  const db = await createEmbeddedDatabase();
  t.after(() => db.close());
  const migrations = new URL('../migrations/', import.meta.url);
  const previous = (await readdir(migrations)).filter(name => /^00[1-9]_/.test(name)).sort();
  const staging = await mkdtemp(join(tmpdir(), 'carbon-intake-scope-'));
  try {
    for (const name of previous) await copyFile(new URL(name, migrations), join(staging, name));
    await migrate(db.admin, pathToFileURL(staging + sep));
  } finally {
    for (const name of await readdir(staging)) await unlink(join(staging, name));
    await rmdir(staging);
  }
  const [tenant, otherTenant, org, release, customer, peer, reviewer, legacyId, intakeId] =
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
      set_config('carbon.request_id', 'intake-scope-test', true)`, [workspace, actor]);
    return callback(tx);
  });
  await act(tx => tx.query(`INSERT INTO carbon.case_intake (tenant_id, org_id, scenario_release_id, created_by, id, purpose)
    VALUES ($1, $2, $3, $4, $5, 'Legacy')`, [tenant, org, release, customer, legacyId]));
  assert.deepEqual(await migrate(db.admin), ['010_intake_scope.sql', '011_internal_report_review.sql',
    '012_factor_reference.sql', '013_factor_decision.sql', '014_submission_activity.sql']);
  assert.deepEqual(await migrate(db.admin), []);
  const lookup = id => tx => tx.query('SELECT intake_scope FROM carbon.case_intake WHERE id = $1', [id]);
  assert.deepEqual((await act(lookup(legacyId))).rows, [{intake_scope: null}]);

  const scope = {subjectType: 'organization', subjectName: '制造公司', jurisdiction: '上海',
    reportingYear: '2025', recipient: '内部管理'};
  const insert = value => tx => tx.query(`INSERT INTO carbon.case_intake
    (tenant_id, org_id, scenario_release_id, created_by, id, purpose, intake_scope)
    VALUES ($1, $2, $3, $4, $5, 'Inventory', $6::jsonb)`,
  [tenant, org, release, customer, intakeId, JSON.stringify(value)]);
  for (const invalid of [null, [], 'organization', 2025]) {
    await assert.rejects(act(insert(invalid)), {constraint: 'intake_scope_is_object'});
  }
  await assert.rejects(act(insert(scope), peer), {code: '42501'});
  await act(insert(scope));
  const expected = [{intake_scope: scope}];
  assert.deepEqual((await act(lookup(intakeId))).rows, expected);
  assert.deepEqual((await act(lookup(intakeId), peer)).rows, []);
  assert.deepEqual((await act(lookup(intakeId), customer, otherTenant)).rows, []);
  assert.deepEqual((await act(lookup(intakeId), reviewer)).rows, []);

  const overwrite = tx => tx.query("UPDATE carbon.case_intake SET intake_scope = '{}' WHERE id = $1", [intakeId]);
  await assert.rejects(act(overwrite), {code: '42501'});
  await assert.rejects(db.admin.transaction(overwrite), {code: '55000'});
  await act(tx => tx.query("UPDATE carbon.case_intake SET status = 'submitted', revision = 2 WHERE id = $1", [intakeId]));
  assert.deepEqual((await act(lookup(intakeId), reviewer)).rows, expected);
  await act(tx => tx.query(`UPDATE carbon.case_intake SET status = 'returned', revision = 3, return_reason = 'Clarify'
    WHERE id = $1`, [intakeId]), reviewer);
  await act(tx => tx.query(`UPDATE carbon.case_intake SET status = 'submitted', revision = 4, return_reason = NULL,
    correction_note = 'Clarified' WHERE id = $1`, [intakeId]));
  assert.deepEqual((await act(lookup(intakeId), reviewer)).rows, expected);
  const {rows} = await act(tx => tx.query(`SELECT action FROM carbon.audit_event WHERE case_id = $1
    ORDER BY revision`, [intakeId]), reviewer);
  assert.deepEqual(rows.map(({action}) => action), ['created', 'submitted', 'returned', 'submitted']);
});
