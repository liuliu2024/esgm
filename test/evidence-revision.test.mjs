import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { createEmbeddedDatabase } from '../infra/embedded.mjs';
import { createEvidenceScanner } from '../infra/evidence-scanner.mjs';
import { migrate } from '../infra/migrations.mjs';
import { createCarbonApi } from '../src/index.mjs';

const [tenantId, orgId, otherOrgId, releaseId, customer, reviewer, peer, otherReviewer] =
  Array.from({length: 8}, () => randomUUID());
const bytes = Buffer.from('%PDF-1.7\nrevision evidence fixture');
const files = new Map();
const quarantine = { write: async (id, contents) => files.set(id, contents), read: async id => files.get(id) };
let db;
let api;
let scanReceipt;

before(async () => {
  db = await createEmbeddedDatabase();
  await migrate(db.admin);
  await db.admin.transaction(async tx => {
    await tx.query("INSERT INTO carbon.workspace (id, name) VALUES ($1, 'Evidence revisions')", [tenantId]);
    await tx.query(`INSERT INTO carbon.organization (tenant_id, id, name)
      VALUES ($1, $2, 'Primary'), ($1, $3, 'Other')`, [tenantId, orgId, otherOrgId]);
    await tx.query(`INSERT INTO carbon.scenario_release (tenant_id, id, code, version, manifest)
      VALUES ($1, $2, 'inventory', 1, '{}')`, [tenantId, releaseId]);
    await tx.query(`INSERT INTO carbon.org_grant (tenant_id, org_id, actor_id, role)
      VALUES ($1, $2, $3, 'customer'), ($1, $2, $4, 'reviewer'), ($1, $2, $5, 'customer'), ($1, $6, $7, 'reviewer')`,
    [tenantId, orgId, customer, reviewer, peer, otherOrgId, otherReviewer]);
  });
  api = createCarbonApi(db.runtime, {quarantine});
  scanReceipt = createEvidenceScanner({
    database: { transaction: callback => db.admin.transaction(async tx => {
      await tx.exec('SET LOCAL ROLE carbon_scanner');
      return callback(tx);
    }) },
    quarantine,
    scanner: async input => ({verdict: input.includes('rejected fixture') ? 'rejected' : 'pass',
      engine: 'fixture', signatureVersion: '1'})
  });
});

after(async () => { await db?.close(); });

function dispatch(actorId, method, path, body, contentType) {
  return api.dispatch({method, path, body, contentType}, {tenantId, actorId, requestId: randomUUID()});
}

async function newCase() {
  const created = await dispatch(customer, 'POST', '/v1/customer/cases', {
    orgId, scenarioReleaseId: releaseId, purpose: '核查引用版本'
  });
  assert.equal(created.status, 201);
  return created.body.id;
}

async function receive(caseId, title, contents = bytes) {
  const path = `/v1/customer/cases/${caseId}/evidence`;
  const sourceDescription = '财务台账';
  const evidence = await dispatch(customer, 'POST', path, {orgId, title, sourceDescription});
  assert.equal(evidence.status, 201);
  const evidenceId = evidence.body.id;
  const file = await dispatch(customer, 'POST', `${path}/${evidenceId}/file?orgId=${orgId}`, contents, 'application/pdf');
  assert.equal(file.status, 201);
  return {evidenceId, receiptId: file.body.id, title, sourceDescription, sha256: file.body.sha256};
}

function readRevision(caseId, revision, actor = reviewer, role = 'professional', organization = orgId) {
  return dispatch(actor, 'GET', `/v1/${role}/cases/${caseId}/revisions/${revision}/evidence?orgId=${organization}`);
}

test('submission pins passed receipts and a failed selection leaves the old revision and audit intact', async () => {
  const caseId = await newCase();
  const customerPath = `/v1/customer/cases/${caseId}`;
  const customerList = `${customerPath}/evidence?orgId=${orgId}`;
  const professionalList = `/v1/professional/cases/${caseId}/evidence?orgId=${orgId}`;
  const first = await receive(caseId, '首次用电账单');
  const pending = await receive(caseId, '尚未扫描账单');
  const rejected = await receive(caseId, '未通过扫描账单', Buffer.from('%PDF-1.7\nrejected fixture'));
  const noFile = await dispatch(customer, 'POST', `${customerPath}/evidence`, {
    orgId, title: '尚未上传账单', sourceDescription: '财务台账'
  });
  assert.equal(noFile.status, 201);
  assert.equal(noFile.body.status, 'pending_file');
  const receivedList = await dispatch(customer, 'GET', customerList);
  assert.equal(receivedList.status, 200);
  assert.equal(receivedList.body.items.find(item => item.id === first.evidenceId).status, 'pending_scan');
  assert.equal((await dispatch(reviewer, 'GET', professionalList)).status, 404);
  const failed = await dispatch(customer, 'POST', `${customerPath}/submit`, {orgId, revision: 1, evidenceIds: [first.evidenceId]});
  assert.equal(failed.status, 409);
  assert.equal(failed.body.error.code, 'EVIDENCE_UNAVAILABLE');
  const unchanged = await dispatch(customer, 'GET', `${customerPath}?orgId=${orgId}`);
  assert.equal(unchanged.body.status, 'draft');
  assert.equal(unchanged.body.revision, 1);
  const history = await dispatch(customer, 'GET', `${customerPath}/history?orgId=${orgId}`);
  assert.deepEqual(history.body.events.map(event => event.action), ['created']);

  await scanReceipt(tenantId, first.receiptId);
  assert.equal((await scanReceipt(tenantId, rejected.receiptId)).verdict, 'rejected');
  const expected = {
    [first.evidenceId]: 'passed', [pending.evidenceId]: 'pending_scan',
    [rejected.evidenceId]: 'rejected', [noFile.body.id]: 'pending_file'
  };
  const statusById = items => Object.fromEntries(items.map(({id, status}) => [id, status]));
  const scannedList = await dispatch(customer, 'GET', customerList);
  assert.equal(scannedList.status, 200);
  assert.deepEqual(statusById(scannedList.body.items), expected);
  for (const unavailable of [rejected.evidenceId, noFile.body.id]) {
    const failed = await dispatch(customer, 'POST', `${customerPath}/submit`, {
      orgId, revision: 1, evidenceIds: [first.evidenceId, unavailable]
    });
    assert.equal(failed.status, 409);
    assert.equal(failed.body.error.code, 'EVIDENCE_UNAVAILABLE');
  }
  const fromOtherCase = await receive(await newCase(), '另一任务账单');
  await scanReceipt(tenantId, fromOtherCase.receiptId);
  const wrongCase = await dispatch(customer, 'POST', `${customerPath}/submit`, {
    orgId, revision: 1, evidenceIds: [first.evidenceId, fromOtherCase.evidenceId]
  });
  assert.equal(wrongCase.body.error.code, 'EVIDENCE_UNAVAILABLE');
  const submitted = await dispatch(customer, 'POST', `${customerPath}/submit`, {orgId, revision: 1, evidenceIds: [first.evidenceId]});
  assert.equal(submitted.status, 200);
  const reviewerList = await dispatch(reviewer, 'GET', professionalList);
  assert.equal(reviewerList.status, 200);
  assert.deepEqual(statusById(reviewerList.body.items), expected);
  assert.equal((await dispatch(peer, 'GET', customerList)).status, 404);
  assert.deepEqual(await readRevision(caseId, 2), {status: 200, body: {items: [first]}});
  assert.equal((await readRevision(caseId, 2, peer, 'customer')).status, 404);
  assert.equal((await readRevision(caseId, 2, otherReviewer, 'professional', otherOrgId)).status, 404);

  const returned = await dispatch(reviewer, 'POST', `/v1/professional/cases/${caseId}/review`, {
    orgId, revision: 2, decision: 'returned', reason: '补本期材料'
  });
  assert.equal(returned.status, 200);
  const second = await receive(caseId, '补正用电账单');
  const invalidResubmission = await dispatch(customer, 'POST', `${customerPath}/resubmit`, {
    orgId, revision: 3, correctionNote: '补录本期材料', evidenceIds: [second.evidenceId]
  });
  assert.equal(invalidResubmission.status, 409);
  assert.equal(invalidResubmission.body.error.code, 'EVIDENCE_UNAVAILABLE');
  await scanReceipt(tenantId, second.receiptId);
  const resubmitted = await dispatch(customer, 'POST', `${customerPath}/resubmit`, {
    orgId, revision: 3, correctionNote: '补录本期材料', evidenceIds: [second.evidenceId]
  });
  assert.equal(resubmitted.status, 200);
  assert.deepEqual(await readRevision(caseId, 2), {status: 200, body: {items: [first]}});
  assert.deepEqual(await readRevision(caseId, 4), {status: 200, body: {items: [second]}});
  assert.equal((await readRevision(caseId, 3)).body.error.code, 'REVISION_NOT_FOUND');
});

test('submission validates evidence IDs once and keeps old clients compatible', async () => {
  const caseId = await newCase();
  const path = `/v1/customer/cases/${caseId}/submit`;
  const id = randomUUID();
  for (const evidenceIds of [null, 'value', ['bad'], [id, id.toUpperCase()]]) {
    const invalid = await dispatch(customer, 'POST', path, {orgId, revision: 1, evidenceIds});
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, 'INVALID_REQUEST');
  }
  const submitted = await dispatch(customer, 'POST', path, {orgId, revision: 1});
  assert.equal(submitted.status, 200);
  assert.deepEqual(await readRevision(caseId, 2), {status: 200, body: {items: []}});
  assert.equal((await readRevision(caseId, '1e0')).status, 400);
  assert.equal((await readRevision(caseId, 1)).status, 404);
});
