import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { startDemo } from '../infra/demo-data.mjs';
import { MAX_EVIDENCE_FILE_BYTES } from '../src/index.mjs';

const customerPath = '/v1/customer/cases';
const reviewerPath = '/v1/professional/cases';
// Minimal payloads exercise file signatures and hashing, not parsing or scanning.
const pdf = Buffer.from('%PDF-1.7\nquarantine test\n%%EOF');
const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
const stored = new Map();
let writeFails = false;
let demo;

before(async () => {
  demo = await startDemo({
    quarantine: {
      async write(id, bytes) {
        if (writeFails) throw new Error('Test storage write failure');
        stored.set(id, Buffer.from(bytes));
      }
    }
  });
});
after(async () => { await demo?.close(); });

async function register(caseId) {
  const registered = await demo.dispatch('customer', 'POST', `${customerPath}/${caseId}/evidence`, {
    orgId: demo.orgId, title: '月度用电账单', sourceDescription: '财务部台账'
  });
  assert.equal(registered.status, 201);
  assert.equal(registered.body.status, 'pending_file');
  return registered.body.id;
}

async function create() {
  const created = await demo.dispatch('customer', 'POST', customerPath, {
    orgId: demo.orgId, scenarioReleaseId: demo.scenarioReleaseId, purpose: '组织碳盘查受理'
  });
  assert.equal(created.status, 201);
  return {caseId: created.body.id, registeredBy: created.body.createdBy, evidenceId: await register(created.body.id)};
}

function upload({caseId, evidenceId}, bytes = pdf, mediaType = 'application/pdf', role = 'customer', orgId = demo.orgId) {
  return demo.dispatch(role, 'POST', `${customerPath}/${caseId}/evidence/${evidenceId}/file?orgId=${orgId}`, bytes, mediaType);
}

async function evidenceStatus({caseId, evidenceId}, role = 'customer') {
  const path = role === 'customer' ? customerPath : reviewerPath;
  const result = await demo.dispatch(role, 'GET', `${path}/${caseId}/evidence?orgId=${demo.orgId}`);
  assert.equal(result.status, 200);
  return result.body.items.find(item => item.id === evidenceId)?.status;
}

function expectError(result, status, code) {
  assert.equal(result.status, status);
  assert.equal(result.body.error.code, code);
}

test('receipt hashes the bytes written to quarantine and exposes only pending scan', async () => {
  const target = await create();
  const response = await upload(target);
  assert.equal(response.status, 201);
  const {id, orgId, caseId, evidenceId, receivedBy, status, mediaType, byteSize, sha256} = response.body;
  assert.equal(orgId, demo.orgId);
  assert.equal(caseId, target.caseId);
  assert.equal(evidenceId, target.evidenceId);
  assert.equal(receivedBy, target.registeredBy);
  assert.equal(status, 'pending_scan');
  assert.equal(mediaType, 'application/pdf');
  assert.equal(byteSize, pdf.length);
  assert.equal(sha256, createHash('sha256').update(pdf).digest('hex'));
  assert.deepEqual(stored.get(id), pdf);
  assert.equal(await evidenceStatus(target), 'pending_scan');
  const beforeDuplicate = stored.size;
  expectError(await upload(target), 409, 'FILE_ALREADY_RECEIVED');
  assert.equal(stored.size, beforeDuplicate);
  assert.equal((await demo.dispatch('customer', 'POST', `${customerPath}/${caseId}/submit`,
    {orgId: demo.orgId, revision: 1})).status, 200);
  assert.equal(await evidenceStatus(target, 'reviewer'), 'pending_scan');
});

test('rejected MIME, headers, oversized input, wrong owner or submitted state never reach quarantine', async () => {
  const target = await create();
  const other = await create();
  const beforeRejections = stored.size;
  expectError(await upload(target, pdf, 'application/octet-stream'), 400, 'INVALID_REQUEST');
  expectError(await upload(target, pdf, 'image/png'), 400, 'INVALID_REQUEST');
  expectError(await upload(target, Buffer.from('fake PDF')), 400, 'INVALID_REQUEST');
  expectError(await upload(target, Buffer.concat([pdf, Buffer.alloc(MAX_EVIDENCE_FILE_BYTES)])), 413, 'FILE_TOO_LARGE');
  expectError(await upload(target, pdf, 'application/pdf', 'reviewer'), 403, 'ACCESS_DENIED');
  expectError(await upload(target, pdf, 'application/pdf', 'customer', randomUUID()), 403, 'ACCESS_DENIED');
  expectError(await upload({...target, evidenceId: other.evidenceId}), 404, 'EVIDENCE_NOT_FOUND');
  assert.equal((await demo.dispatch('customer', 'POST', `${customerPath}/${target.caseId}/submit`,
    {orgId: demo.orgId, revision: 1})).status, 200);
  expectError(await upload(target), 409, 'CASE_CONFLICT');
  assert.equal(await evidenceStatus(target), 'pending_file');
  assert.equal(stored.size, beforeRejections);
});

test('quarantine write failure rolls back the receipt and permits a PNG retry', async () => {
  const target = await create();
  const beforeFailure = stored.size;
  writeFails = true;
  try {
    expectError(await upload(target, png, 'image/png'), 503, 'QUARANTINE_UNAVAILABLE');
  } finally {
    writeFails = false;
  }
  assert.equal(stored.size, beforeFailure);
  assert.equal(await evidenceStatus(target), 'pending_file');
  const retry = await upload(target, png, 'image/png');
  assert.equal(retry.status, 201);
  assert.equal(retry.body.status, 'pending_scan');
  assert.equal(retry.body.mediaType, 'image/png');
  assert.equal(retry.body.byteSize, png.length);
  assert.equal(retry.body.sha256, createHash('sha256').update(png).digest('hex'));
  assert.deepEqual(stored.get(retry.body.id), png);
  assert.equal(await evidenceStatus(target), 'pending_scan');
});
