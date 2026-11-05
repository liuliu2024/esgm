import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createEmbeddedDatabase } from '../infra/embedded.mjs';
import { migrate } from '../infra/migrations.mjs';

const id = value => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const tenant = id(1), otherTenant = id(2);
const org = id(11), siblingOrg = id(12), otherOrg = id(13);
const customer = id(21), reviewer = id(22), admin = id(23), siblingCustomer = id(24);
const release = id(31), otherRelease = id(32);

let db;
let applied;

before(async () => {
  db = await createEmbeddedDatabase();
  applied = await migrate(db.admin);
  await db.admin.transaction(async client => {
    await client.query('INSERT INTO carbon.workspace (id, name) VALUES ($1, $2), ($3, $4)',
      [tenant, 'Primary', otherTenant, 'Other']);
    await client.query(`INSERT INTO carbon.organization (tenant_id, id, name)
      VALUES ($1, $2, 'North'), ($1, $3, 'South'), ($4, $5, 'External')`,
      [tenant, org, siblingOrg, otherTenant, otherOrg]);
    await client.query(`INSERT INTO carbon.org_grant (tenant_id, org_id, actor_id, role)
      VALUES ($1, $2, $3, 'customer'), ($1, $2, $3, 'reviewer'), ($1, $2, $4, 'reviewer'),
      ($1, $2, $5, 'admin'), ($1, $6, $7, 'customer')`,
      [tenant, org, customer, reviewer, admin, siblingOrg, siblingCustomer]);
    await client.query(`INSERT INTO carbon.scenario_release (tenant_id, id, code, version, manifest)
      VALUES ($1, $2, 'intake', 1, '{}'), ($3, $4, 'intake', 1, '{}')`,
      [tenant, release, otherTenant, otherRelease]);
  });
});

after(async () => { await db?.close(); });

function asActor(actor, callback, workspace = tenant, requestId = 'database-test') {
  return db.runtime.transaction(async client => {
    await client.query(`SELECT set_config('carbon.tenant_id', $1, true),
      set_config('carbon.actor_id', $2, true), set_config('carbon.request_id', $3, true)`,
      [workspace, actor, requestId]);
    return callback(client);
  });
}

function createCase(client, caseId, organization = org, scenario = release, workspace = tenant) {
  return client.query(`INSERT INTO carbon.case_intake
    (tenant_id, id, org_id, scenario_release_id, created_by, purpose)
    VALUES ($1, $2, $3, $4, $5, 'Supply chain assessment')
    RETURNING status, revision`, [workspace, caseId, organization, scenario, customer]);
}

function transition(client, caseId, expectedRevision, status) {
  return client.query(`UPDATE carbon.case_intake SET status = $3, revision = revision + 1
    WHERE tenant_id = $1 AND id = $2 AND revision = $4 RETURNING status, revision`,
    [tenant, caseId, status, expectedRevision]);
}

test('empty database applies migration once and replay preserves its ledger', async () => {
  assert.ok(applied.includes('001_core.sql'));
  assert.deepEqual(await migrate(db.admin), []);
  const { rows } = await db.admin.transaction(client => client.query(
    'SELECT name FROM carbon_migrations.applied ORDER BY name'));
  assert.deepEqual(rows.map(row => row.name), applied);
});

test('runtime without transaction context cannot read or write tenant rows', async () => {
  // A preceding scoped transaction must not leave its identity on this connection.
  await asActor(customer, client => createCase(client, id(101)));
  await db.runtime.transaction(async client => {
    for (const table of ['workspace', 'organization', 'scenario_release', 'case_intake', 'audit_event']) {
      const { rows } = await client.query(`SELECT * FROM carbon.${table}`);
      assert.deepEqual(rows, [], table);
    }
  });
  await assert.rejects(db.runtime.transaction(client => createCase(client, id(102))), { code: '42501' });
});

test('runtime isolates other organizations and tenants on reads and writes', async () => {
  const caseId = id(111);
  await asActor(customer, client => createCase(client, caseId));
  const sibling = await asActor(siblingCustomer, client => client.query(
    'SELECT id FROM carbon.case_intake WHERE id = $1', [caseId]));
  assert.deepEqual(sibling.rows, []);
  const siblingWrite = await asActor(siblingCustomer, client => transition(client, caseId, 1, 'submitted'));
  assert.deepEqual(siblingWrite.rows, []);
  const external = await asActor(customer, client => client.query('SELECT id FROM carbon.workspace'), otherTenant);
  assert.deepEqual(external.rows, []);
  await assert.rejects(asActor(customer, client => createCase(client, id(112), siblingOrg)), { code: '42501' });
  await assert.rejects(asActor(customer, client => createCase(client, id(113), otherOrg, otherRelease, otherTenant)),
    { code: '42501' });
  await assert.rejects(asActor(customer, client => createCase(client, id(114), org, otherRelease)),
    { code: '23503' });

  await db.admin.transaction(client => client.query(
    'DELETE FROM carbon.org_grant WHERE tenant_id = $1 AND org_id = $2 AND actor_id = $3',
    [tenant, siblingOrg, siblingCustomer]));
  const revoked = await asActor(siblingCustomer, client => client.query('SELECT id FROM carbon.organization'));
  assert.deepEqual(revoked.rows, []);
});

test('published scenario and audit history cannot be rewritten', async () => {
  const caseId = id(121);
  await asActor(customer, client => createCase(client, caseId));
  await assert.rejects(asActor(admin, client => client.query(
    'UPDATE carbon.scenario_release SET manifest = $2 WHERE id = $1', [release, { changed: true }])),
  { code: '42501' });
  await assert.rejects(asActor(admin, client => client.query(
    'DELETE FROM carbon.audit_event WHERE case_id = $1', [caseId])), { code: '42501' });
  await assert.rejects(db.admin.transaction(client => client.query(
    'UPDATE carbon.scenario_release SET version = 2 WHERE id = $1', [release])), { code: '55000' });
  await assert.rejects(db.admin.transaction(client => client.query(
    'UPDATE carbon.audit_event SET request_id = $2 WHERE case_id = $1', [caseId, 'rewritten'])), { code: '55000' });
  await db.admin.transaction(client => client.query(`INSERT INTO carbon.scenario_release
    (tenant_id, id, code, version, manifest) VALUES ($1, $2, 'intake', 2, '{}')`, [tenant, id(33)]));
  const previous = await asActor(admin, client => client.query(`SELECT s.version
    FROM carbon.case_intake AS c JOIN carbon.scenario_release AS s
    ON s.tenant_id = c.tenant_id AND s.id = c.scenario_release_id
    WHERE c.id = $1`, [caseId]));
  assert.deepEqual(previous.rows, [{ version: 1 }]);
  const { rows } = await asActor(admin, client => client.query(
    'SELECT action, revision, request_id FROM carbon.audit_event WHERE case_id = $1', [caseId]));
  assert.deepEqual(rows, [{ action: 'created', revision: 1, request_id: 'database-test' }]);
});

test('return requires a reason and retains the previous submission in the audit', async () => {
  const caseId = id(141);
  const reason = 'Supplier evidence is missing';
  await asActor(customer, client => createCase(client, caseId));
  await asActor(customer, client => transition(client, caseId, 1, 'submitted'));
  await assert.rejects(asActor(reviewer, client => transition(client, caseId, 2, 'returned')), { code: '23514' });

  const result = await asActor(reviewer, client => client.query(`UPDATE carbon.case_intake
    SET status = 'returned', return_reason = $2, revision = revision + 1
    WHERE id = $1 AND revision = 2 RETURNING status, return_reason, revision`, [caseId, reason]));
  assert.deepEqual(result.rows, [{ status: 'returned', return_reason: reason, revision: 3 }]);

  const { rows } = await asActor(admin, client => client.query(
    'SELECT action, reason, revision FROM carbon.audit_event WHERE case_id = $1 ORDER BY revision', [caseId]));
  assert.deepEqual(rows, [
    { action: 'created', reason: null, revision: 1 },
    { action: 'submitted', reason: null, revision: 2 },
    { action: 'returned', reason, revision: 3 }
  ]);
});

test('state change and audit roll back together and stale revision has no effect', async () => {
  const caseId = id(131);
  const created = await asActor(customer, client => createCase(client, caseId));
  assert.deepEqual(created.rows, [{ status: 'draft', revision: 1 }]);
  await assert.rejects(asActor(customer, async client => {
    const { rows } = await transition(client, caseId, 1, 'submitted');
    assert.deepEqual(rows, [{ status: 'submitted', revision: 2 }]);
    throw new Error('Rollback test');
  }), /Rollback test/);

  await asActor(admin, async client => {
    const intake = await client.query('SELECT status, revision FROM carbon.case_intake WHERE id = $1', [caseId]);
    const history = await client.query('SELECT action FROM carbon.audit_event WHERE case_id = $1', [caseId]);
    assert.deepEqual(intake.rows, [{ status: 'draft', revision: 1 }]);
    assert.deepEqual(history.rows, [{ action: 'created' }]);
  });

  await asActor(customer, client => transition(client, caseId, 1, 'submitted'), tenant, 'submit-intake');
  await assert.rejects(asActor(customer, client => transition(client, caseId, 2, 'approved')), { code: '42501' });
  const approved = await asActor(reviewer, client => transition(client, caseId, 2, 'approved'), tenant, 'review-intake');
  assert.deepEqual(approved.rows, [{ status: 'approved', revision: 3 }]);
  const replay = await asActor(reviewer, client => transition(client, caseId, 2, 'approved'));
  assert.deepEqual(replay.rows, []);

  const { rows } = await asActor(admin, client => client.query(
    'SELECT action, revision, actor_id, request_id FROM carbon.audit_event WHERE case_id = $1 ORDER BY revision',
    [caseId]));
  assert.deepEqual(rows, [
    { action: 'created', revision: 1, actor_id: customer, request_id: 'database-test' },
    { action: 'submitted', revision: 2, actor_id: customer, request_id: 'submit-intake' },
    { action: 'approved', revision: 3, actor_id: reviewer, request_id: 'review-intake' }
  ]);
});
