import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { after, before, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createEmbeddedDatabase } from '../infra/embedded.mjs';
import { migrate } from '../infra/migrations.mjs';

const [tenant, otherTenant, org, otherOrg, siblingOrg, release,
  customer, reviewer, peer, siblingCustomer, otherCustomer, caseId, secondCase, evidence, secondEvidence] =
  Array.from({length: 15}, () => randomUUID());
let db;
let legacyEvidence;

function asActor(actor, callback, workspace = tenant) {
  return db.runtime.transaction(async tx => {
    await tx.query(`SELECT set_config('carbon.tenant_id', $1, true),
      set_config('carbon.actor_id', $2, true), set_config('carbon.request_id', 'receipt-db-test', true)`,
    [workspace, actor]);
    return callback(tx);
  });
}

function insertReceipt(tx, {intake = caseId, material = evidence, recipient = customer} = {}) {
  return tx.query(`INSERT INTO carbon.evidence_receipt
    (tenant_id, org_id, case_id, evidence_id, id, received_by, media_type, byte_size, sha256)
    VALUES ($1, $2, $3, $4, $5, $6, 'application/pdf', 128, $7)
    RETURNING id, evidence_id, received_by`,
  [tenant, org, intake, material, randomUUID(), recipient, 'a'.repeat(64)]);
}

before(async () => {
  db = await createEmbeddedDatabase();
  const previous = ['001_core.sql', '002_corrections.sql', '003_evidence_register.sql'];
  const directory = await mkdtemp(join(tmpdir(), 'carbon-receipt-migration-'));
  const copied = [];
  try {
    for (const filename of previous) {
      const destination = join(directory, filename);
      await copyFile(new URL(`../migrations/${filename}`, import.meta.url), destination);
      copied.push(destination);
    }
    assert.deepEqual(await migrate(db.admin, pathToFileURL(directory + sep)), previous);
  } finally {
    for (const filename of copied) await unlink(filename);
    await rmdir(directory);
  }

  await db.admin.transaction(async tx => {
    await tx.query('INSERT INTO carbon.workspace VALUES ($1, $2), ($3, $4)', [tenant, 'Primary', otherTenant, 'Other']);
    await tx.query(`INSERT INTO carbon.organization VALUES
      ($1, $2, 'North'), ($1, $3, 'South'), ($4, $5, 'External')`, [tenant, org, siblingOrg, otherTenant, otherOrg]);
    await tx.query(`INSERT INTO carbon.org_grant VALUES
      ($1, $2, $3, 'customer'), ($1, $2, $4, 'reviewer'), ($1, $2, $5, 'customer'),
      ($1, $6, $7, 'customer'), ($8, $9, $10, 'customer')`,
    [tenant, org, customer, reviewer, peer, siblingOrg, siblingCustomer, otherTenant, otherOrg, otherCustomer]);
    await tx.query("INSERT INTO carbon.scenario_release VALUES ($1, $2, 'inventory', 1, '{}')", [tenant, release]);
  });
  await asActor(customer, async tx => {
    await tx.query(`INSERT INTO carbon.case_intake
      (tenant_id, org_id, scenario_release_id, created_by, id, purpose)
      VALUES ($1, $2, $3, $4, $5, 'Inventory'), ($1, $2, $3, $4, $6, 'Another inventory')`,
    [tenant, org, release, customer, caseId, secondCase]);
    const {rows} = await tx.query(`INSERT INTO carbon.case_evidence
      (tenant_id, org_id, registered_by, case_id, id, title, source_description)
      VALUES ($1, $2, $3, $4, $5, 'Energy bill', 'Finance department'),
      ($1, $2, $3, $6, $7, 'Meter record', 'Operations department') RETURNING *`,
    [tenant, org, customer, caseId, evidence, secondCase, secondEvidence]);
    legacyEvidence = rows;
  });
});

after(async () => { await db?.close(); });

test('004 upgrades a populated 003 database without changing registered materials', async () => {
  assert.deepEqual(await migrate(db.admin), ['004_evidence_receipts.sql', '005_evidence_scan.sql',
    '006_evidence_revision.sql']);
  assert.deepEqual(await migrate(db.admin), []);
  await asActor(customer, async tx => {
    const {rows} = await tx.query('SELECT * FROM carbon.case_evidence ORDER BY title');
    assert.deepEqual(rows, legacyEvidence);
    assert.deepEqual((await tx.query('SELECT * FROM carbon.evidence_receipt')).rows, []);
  });
});

test('receipt requires the matching material, intake creator and writable intake', async () => {
  const {rows: constraints} = await db.admin.transaction(tx => tx.query(`SELECT pg_get_constraintdef(oid) AS definition
    FROM pg_constraint WHERE conrelid = 'carbon.evidence_receipt'::regclass AND contype = 'f'`));
  assert.deepEqual(constraints, [{
    definition: 'FOREIGN KEY (tenant_id, org_id, case_id, evidence_id) REFERENCES carbon.case_evidence(tenant_id, org_id, case_id, id)'
  }]);
  await assert.rejects(asActor(customer, tx => insertReceipt(tx, {intake: secondCase})), {code: '42501'});
  await assert.rejects(asActor(peer, tx => insertReceipt(tx, {recipient: peer})), {code: '42501'});
  await assert.rejects(asActor(reviewer, tx => insertReceipt(tx, {recipient: reviewer})), {code: '42501'});
  await assert.rejects(asActor(customer, tx => insertReceipt(tx, {recipient: peer})), {code: '42501'});
  const {rows} = await asActor(customer, tx => insertReceipt(tx));
  assert.deepEqual(rows.map(({evidence_id, received_by}) => ({evidence_id, received_by})),
    [{evidence_id: evidence, received_by: customer}]);
  await assert.rejects(asActor(customer, tx => insertReceipt(tx)), {code: '23505'});
  await asActor(customer, tx => tx.query(`UPDATE carbon.case_intake SET status = 'submitted', revision = 2
    WHERE id = $1`, [secondCase]));
  await assert.rejects(asActor(customer, tx => insertReceipt(tx, {intake: secondCase, material: secondEvidence})),
    {code: '23514'});
  await asActor(reviewer, tx => tx.query(`UPDATE carbon.case_intake SET status = 'returned',
    return_reason = 'Attach the meter record', revision = 3 WHERE id = $1`, [secondCase]));
  const returned = await asActor(customer, tx => insertReceipt(tx, {intake: secondCase, material: secondEvidence}));
  assert.equal(returned.rows[0].evidence_id, secondEvidence);
});

test('receipt reads follow intake scope and receipt rows are immutable', async () => {
  const select = tx => tx.query('SELECT evidence_id FROM carbon.evidence_receipt WHERE evidence_id = $1', [evidence]);
  assert.deepEqual((await asActor(customer, select)).rows, [{evidence_id: evidence}]);
  assert.deepEqual((await asActor(reviewer, select)).rows, []);
  await asActor(customer, tx => tx.query("UPDATE carbon.case_intake SET status = 'submitted', revision = 2 WHERE id = $1", [caseId]));
  assert.deepEqual((await asActor(reviewer, select)).rows, [{evidence_id: evidence}]);
  assert.deepEqual((await asActor(peer, select)).rows, []);
  assert.deepEqual((await asActor(siblingCustomer, select)).rows, []);
  assert.deepEqual((await asActor(otherCustomer, select, otherTenant)).rows, []);
  assert.deepEqual((await db.runtime.transaction(select)).rows, []);

  const change = tx => tx.query('UPDATE carbon.evidence_receipt SET byte_size = 129 WHERE evidence_id = $1', [evidence]);
  const remove = tx => tx.query('DELETE FROM carbon.evidence_receipt WHERE evidence_id = $1', [evidence]);
  await assert.rejects(asActor(customer, change), {code: '42501'});
  await assert.rejects(asActor(customer, remove), {code: '42501'});
  await assert.rejects(db.admin.transaction(change), {code: '55000'});
  await assert.rejects(db.admin.transaction(remove), {code: '55000'});
});

test('terminal scans are immutable, scoped to exact bytes, and writable only by the scanner', async () => {
  const scanAs = (workspace, callback) => db.admin.transaction(async tx => {
    await tx.exec('SET LOCAL ROLE carbon_scanner');
    await tx.query("SELECT set_config('carbon.tenant_id', $1, true)", [workspace]);
    return callback(tx);
  });
  const findReceipt = tx => tx.query('SELECT id, sha256 FROM carbon.evidence_receipt WHERE evidence_id = $1', [evidence]);
  const {rows: [receipt]} = await scanAs(tenant, findReceipt);
  assert.ok(receipt);
  assert.deepEqual((await scanAs(otherTenant, findReceipt)).rows, []);

  const insertScan = (tx, {digest = receipt.sha256, verdict = 'pass', organization = org} = {}) => tx.query(`
    INSERT INTO carbon.evidence_scan
      (tenant_id, org_id, case_id, evidence_id, receipt_id, sha256, verdict, engine, signature_version)
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'test scanner', 'test signatures')
    RETURNING verdict, scanned_at`,
  [tenant, organization, caseId, evidence, receipt.id, digest, verdict]);
  await assert.rejects(asActor(customer, insertScan), {code: '42501'});
  await assert.rejects(asActor(reviewer, insertScan), {code: '42501'});
  await assert.rejects(scanAs(otherTenant, insertScan), {code: '42501'});
  await assert.rejects(scanAs(tenant, tx => insertScan(tx, {digest: 'b'.repeat(64)})), {code: '23503'});
  await assert.rejects(scanAs(tenant, tx => insertScan(tx, {organization: siblingOrg})), {code: '23503'});
  await assert.rejects(scanAs(tenant, tx => insertScan(tx, {verdict: 'error'})), {code: '23514'});
  const {rows: [stored]} = await scanAs(tenant, insertScan);
  assert.equal(stored.verdict, 'pass');
  assert.ok(stored.scanned_at instanceof Date);
  await assert.rejects(scanAs(tenant, tx => insertScan(tx, {verdict: 'rejected'})), {code: '23505'});
  const readScan = tx => tx.query('SELECT verdict FROM carbon.evidence_scan WHERE receipt_id = $1', [receipt.id]);
  for (const actor of [customer, reviewer]) {
    assert.deepEqual((await asActor(actor, readScan)).rows, [{verdict: 'pass'}]);
  }
  for (const actor of [peer, siblingCustomer]) {
    assert.deepEqual((await asActor(actor, readScan)).rows, []);
  }
  assert.deepEqual((await scanAs(otherTenant, readScan)).rows, []);
  const change = tx => tx.query("UPDATE carbon.evidence_scan SET verdict = 'rejected' WHERE receipt_id = $1", [receipt.id]);
  const remove = tx => tx.query('DELETE FROM carbon.evidence_scan WHERE receipt_id = $1', [receipt.id]);
  await assert.rejects(scanAs(tenant, change), {code: '42501'});
  await assert.rejects(scanAs(tenant, remove), {code: '42501'});
  await assert.rejects(db.admin.transaction(change), {code: '55000'});
  await assert.rejects(db.admin.transaction(remove), {code: '55000'});
});
