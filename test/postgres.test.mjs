import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createEvidenceScanner } from '../infra/evidence-scanner.mjs';
import { createLocalQuarantine } from '../infra/local-quarantine.mjs';
import { connectPostgres } from '../infra/postgres.mjs';
import { migrate } from '../infra/migrations.mjs';
import { createCarbonApi } from '../src/index.mjs';

const migrationUrl = process.env.CARBON_TEST_MIGRATION_DATABASE_URL;
const runtimeUrl = process.env.CARBON_TEST_APP_DATABASE_URL;
const scannerUrl = process.env.CARBON_TEST_SCANNER_DATABASE_URL;

test('PostgreSQL 17 connection pool isolates context and resolves competing reviews', {
  skip: !migrationUrl && !runtimeUrl
}, async () => {
  assert.ok(migrationUrl && runtimeUrl, 'Both dedicated test connection strings are required');
  assert.equal(new URL(migrationUrl).pathname, '/carbon_test');
  assert.equal(new URL(runtimeUrl).pathname, '/carbon_test');
  assert.equal(new URL(runtimeUrl).username, 'carbon_test_app');
  const admin = connectPostgres(migrationUrl, { migration: true });
  const runtime = connectPostgres(runtimeUrl, { max: 3 });
  const quarantine = await createLocalQuarantine();
  const scannerDatabase = scannerUrl && connectPostgres(scannerUrl, { scanner: true });
  try {
    await migrate(admin);
    const tenantId = randomUUID(), orgId = randomUUID(), scenarioReleaseId = randomUUID();
    const customer = randomUUID(), reviewer = randomUUID(), administrator = randomUUID();
    await admin.transaction(async tx => {
      await tx.query('GRANT carbon_app TO carbon_test_app');
      if (scannerDatabase) await tx.query('GRANT carbon_scanner TO carbon_test_scanner');
      await tx.query("INSERT INTO carbon.workspace (id, name) VALUES ($1, 'Postgres integration')", [tenantId]);
      await tx.query("INSERT INTO carbon.organization (tenant_id, id, name) VALUES ($1, $2, 'Integration org')", [tenantId, orgId]);
      await tx.query("INSERT INTO carbon.scenario_release (tenant_id, id, code, version, manifest) VALUES ($1, $2, 'intake', 1, '{}')", [tenantId, scenarioReleaseId]);
      for (const [actor, role] of [[customer, 'customer'], [reviewer, 'reviewer'], [administrator, 'admin']]) {
        await tx.query('INSERT INTO carbon.org_grant (tenant_id, org_id, actor_id, role) VALUES ($1, $2, $3, $4)',
          [tenantId, orgId, actor, role]);
      }
    });
    const api = createCarbonApi(runtime, { quarantine });
    const dispatch = (actorId, method, path, body, contentType) =>
      api.dispatch({ method, path, body, contentType }, { tenantId, actorId, requestId: randomUUID() });
    const created = await dispatch(customer, 'POST', '/v1/customer/cases', { orgId, scenarioReleaseId, purpose: '并行复核验证' });
    assert.equal(created.status, 201);
    const id = created.body.id;
    const imports = `/v1/customer/cases/${id}/imports`;
    const firstImport = await dispatch(customer, 'POST', imports, {
      orgId, csv: 'period,source,quantity,unit\n2026-01,electricity,1.0000000000000000001,MWh'
    });
    const competingImport = await dispatch(customer, 'POST', imports, {
      orgId, csv: 'period,source,quantity,unit\n2026-01,electricity,2000,kWh'
    });
    assert.equal(firstImport.status, 200);
    assert.equal(competingImport.status, 200);
    const confirm = (batch, revision = batch.previewRevision) =>
      dispatch(customer, 'POST', `${imports}/${batch.batchId}/commit`, { orgId, previewRevision: revision });
    const firstReceipt = await confirm(firstImport.body);
    assert.equal(firstReceipt.status, 200);
    assert.equal(firstReceipt.body.inserted, 1);
    assert.deepEqual(await confirm(firstImport.body), firstReceipt);
    const stale = await confirm(competingImport.body);
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'IMPORT_STALE_BASELINE');
    const refreshed = await dispatch(customer, 'POST', `${imports}/${competingImport.body.batchId}/repreview`, {
      orgId, previewRevision: competingImport.body.previewRevision
    });
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.body.preview[0].baseQuantity, '1000.0000000000000001');
    const correctionReceipt = await confirm(competingImport.body, refreshed.body.previewRevision);
    assert.equal(correctionReceipt.status, 200);
    assert.equal(correctionReceipt.body.corrected, 1);
    const calculation = await dispatch(customer, 'GET',
      `/v1/customer/cases/${id}/calculation-preview?orgId=${orgId}&from=2026-01&to=2026-01`);
    assert.equal(calculation.status, 200);
    assert.equal(calculation.body.formalReportEligible, false);
    assert.equal(calculation.body.knownSubtotalKgCO2e, '1000');
    assert.equal(calculation.body.totalKgCO2e, null);
    assert.equal(calculation.body.items[0].lineage.activityRevision, 2);
    assert.equal(calculation.body.items[1].quantity, null);
    let evidenceReference;
    if (scannerDatabase) {
      assert.equal(new URL(scannerUrl).pathname, '/carbon_test');
      assert.equal(new URL(scannerUrl).username, 'carbon_test_scanner');
      const registered = await dispatch(customer, 'POST', `/v1/customer/cases/${id}/evidence`, {
        orgId, title: '扫描集成样例', sourceDescription: '测试数据'
      });
      assert.equal(registered.status, 201);
      const evidenceId = registered.body.id;
      const bytes = Buffer.from('%PDF-1.7\nscanner integration fixture');
      const file = await dispatch(customer, 'POST', `/v1/customer/cases/${id}/evidence/${evidenceId}/file?orgId=${orgId}`,
        bytes, 'application/pdf');
      assert.equal(file.status, 201);

      let scannerCalls = 0;
      const scanReceipt = createEvidenceScanner({ database: scannerDatabase, quarantine, scanner: async input => {
        assert.deepEqual(input, bytes);
        scannerCalls += 1;
        return { verdict: 'pass', engine: 'test-fixture', signatureVersion: 'fixture-1' };
      } });
      await assert.rejects(scanReceipt(randomUUID(), file.body.id), /No receipt/);
      const mismatchedScan = createEvidenceScanner({ database: scannerDatabase,
        quarantine: { read: async () => Buffer.alloc(bytes.length) }, scanner: () => assert.fail('Invalid bytes were sent to scanner') });
      await assert.rejects(mismatchedScan(tenantId, file.body.id), /do not match/);
      assert.deepEqual(await scanReceipt(tenantId, file.body.id), { receiptId: file.body.id, verdict: 'pass' });
      assert.deepEqual(await scanReceipt(tenantId, file.body.id), { receiptId: file.body.id, verdict: 'pass' });
      assert.equal(scannerCalls, 1);
      await assert.rejects(scannerDatabase.transaction(tx => tx.query('SELECT id FROM carbon.case_intake')), { code: '42501' });
      evidenceReference = { evidenceId, receiptId: file.body.id, sha256: file.body.sha256,
        title: '扫描集成样例', sourceDescription: '测试数据' };
    }
    const submission = { orgId, revision: 1 };
    if (evidenceReference) submission.evidenceIds = [evidenceReference.evidenceId];
    const submitted = await dispatch(customer, 'POST', `/v1/customer/cases/${id}/submit`, submission);
    assert.equal(submitted.status, 200);

    if (evidenceReference) {
      const refs = await dispatch(reviewer, 'GET', `/v1/professional/cases/${id}/revisions/2/evidence?orgId=${orgId}`);
      assert.equal(refs.status, 200);
      assert.deepEqual(refs.body.items, [evidenceReference]);
    }

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
    await Promise.all([runtime.close(), admin.close(), scannerDatabase?.close(), quarantine.close()]);
  }
});
