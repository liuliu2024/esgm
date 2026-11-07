import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createEmbeddedDatabase } from '../infra/embedded.mjs';
import { migrate } from '../infra/migrations.mjs';

test('019 report data survives upgrade and 027 enforces disclosure on direct delivery writes', async t => {
  const db = await createEmbeddedDatabase();
  t.after(() => db.close());
  const source = new URL('../migrations/', import.meta.url);
  const previous = (await readdir(source)).filter(name => /^\d{3}_.+\.sql$/.test(name) && name < '020').sort();
  assert.equal(previous.at(-1), '019_scenario_rule_proposals.sql');
  const directory = await mkdtemp(join(tmpdir(), 'carbon-report-disclosure-'));
  const copied = [];
  try {
    for (const filename of previous) {
      const path = join(directory, filename);
      await copyFile(new URL(filename, source), path);
      copied.push(path);
    }
    assert.deepEqual(await migrate(db.admin, pathToFileURL(directory + sep)), previous);
  } finally {
    for (const path of copied) await unlink(path);
    await rmdir(directory);
  }

  const [tenant, org, release, owner, reviewer] = Array.from({length: 5}, randomUUID);
  const [publicFactor, summaryFactor, privateFactor] =
    ['cn-electricity-product-average', 'fixture-summary-factor', 'fixture-private-factor'];
  const model = {id: 'submitted-electricity', version: 1};
  const template = {id: 'internal-management-electricity', version: 1};
  const request = 'factor-disclosure-db-test';
  await db.admin.transaction(async tx => {
    await tx.query("INSERT INTO carbon.workspace VALUES ($1, 'Workspace')", [tenant]);
    await tx.query("INSERT INTO carbon.organization VALUES ($1, $2, 'Organization')", [tenant, org]);
    await tx.query("INSERT INTO carbon.scenario_release (tenant_id, id, code, version, manifest) VALUES ($1, $2, 'inventory', 1, '{}')", [tenant, release]);
    await tx.query("INSERT INTO carbon.org_grant VALUES ($1, $2, $3, 'customer'), ($1, $2, $4, 'reviewer')", [tenant, org, owner, reviewer]);
    for (const factor of [summaryFactor, privateFactor]) {
      await tx.query(`INSERT INTO catalog.factor_reference_version
        (factor_id, version, accounting_basis, region_code, region_name, data_year, value,
          input_unit, output_unit, source_title, source_url, source_locator, usage_note)
        VALUES ($1, 1, 'product_footprint', 'CN', 'Fixture', 2024, 0.5, 'kWh', 'kgCO2e',
          'Fixture factor', 'https://example.invalid/factor', 'Fixture', 'Fixture only')`, [factor]);
    }
  });
  const act = (actor, callback) => db.runtime.transaction(async tx => {
    await tx.query(`SELECT set_config('carbon.tenant_id', $1, true),
      set_config('carbon.actor_id', $2, true), set_config('carbon.request_id', $3, true)`, [tenant, actor, request]);
    return callback(tx);
  });
  async function prepareDraft(factor) {
    const [caseId, snapshotId, draftId] = Array.from({length: 3}, randomUUID);
    await act(owner, async tx => {
      await tx.query(`INSERT INTO carbon.case_intake
        (tenant_id, org_id, id, scenario_release_id, created_by, purpose)
        VALUES ($1, $2, $3, $4, $5, 'Disclosure fixture')`, [tenant, org, caseId, release, owner]);
      await tx.query("UPDATE carbon.case_intake SET status = 'submitted', revision = 2 WHERE id = $1", [caseId]);
    });
    await act(reviewer, tx => tx.query(`INSERT INTO carbon.case_factor_decision
      (tenant_id, org_id, case_id, submission_revision, factor_id, factor_version, decided_by, request_id, method_reference, rationale)
      VALUES ($1, $2, $3, 2, $4, 1, $5, $6, 'Fixture method', 'Fixture rationale')`,
    [tenant, org, caseId, factor, reviewer, request]));
    await act(owner, async tx => {
      await tx.query(`INSERT INTO carbon.calculation_snapshot
        (tenant_id, org_id, case_id, id, created_by, request_id, schema_version, from_period, to_period,
          input_fingerprint, submission_revision, payload)
        VALUES ($1, $2, $3, $4, $5, $6, 1, '2024-01-01', '2024-01-01', $7, 2, $8)`,
      [tenant, org, caseId, snapshotId, owner, request, 'a'.repeat(64), {
        caseId, mode: 'controlled', submissionRevision: 2, scope: 'purchased_electricity', model,
        formalReportEligible: false, externalDeliveryEligible: false, coverage: {status: 'complete'}
      }]);
      await tx.query(`INSERT INTO carbon.internal_report_draft
        (tenant_id, org_id, case_id, id, snapshot_id, template_id, template_version, created_by, request_id, payload)
        VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, $9)`,
      [tenant, org, caseId, draftId, snapshotId, template.id, owner, request, {
        caseId, snapshotId, status: 'draft', mode: 'controlled', formalReportEligible: false, externalDeliveryEligible: false,
        template, report: {scope: {submissionRevision: 2}, model, summary: {coverage: {status: 'complete'}}, watermark: '内部管理｜待授权交付'}
      }]);
      await tx.query(`INSERT INTO carbon.internal_report_review
        (tenant_id, org_id, case_id, draft_id, submitted_by, submitted_request_id)
        VALUES ($1, $2, $3, $4, $5, $6)`, [tenant, org, caseId, draftId, owner, request]);
    });
    await act(reviewer, tx => tx.query(`UPDATE carbon.internal_report_review
      SET status = 'reviewed', reviewed_by = $2, reviewed_request_id = $3 WHERE draft_id = $1`, [draftId, reviewer, request]));
    return {caseId, draftId};
  }
  const html = '<p>Fixture delivery</p>';
  const hash = createHash('sha256').update(html).digest('hex');
  const insertDelivery = ({caseId, draftId}, monthly, factor, recipient = 'Fixture recipient') =>
    act(owner, tx => tx.query(`INSERT INTO carbon.internal_report_delivery
      (tenant_id, org_id, case_id, draft_id, id, created_by, request_id, recipient, purpose,
        include_monthly, include_factor, document_html, document_sha256)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Fixture purpose', $9, $10, $11, $12)
      RETURNING *`, [tenant, org, caseId, draftId, randomUUID(), owner, request, recipient, monthly, factor, html, hash]));
  const fullDraft = await prepareDraft(publicFactor);
  const summaryDraft = await prepareDraft(summaryFactor);
  const privateDraft = await prepareDraft(privateFactor);
  const {rows: [originalDelivery]} = await insertDelivery(fullDraft, true, true);
  const selectDraft = tx => tx.query('SELECT * FROM carbon.internal_report_draft WHERE id = $1', [fullDraft.draftId]);
  const {rows: [originalDraft]} = await act(owner, selectDraft);

  assert.deepEqual(await migrate(db.admin), [
    '020_gas_combustion_inputs.sql', '021_model_trial_snapshots.sql', '022_internal_gas_report.sql',
    '023_gas_calculation_jobs.sql', '024_product_electricity_profile.sql', '025_gas_report_restatement.sql',
    '026_product_model_templates.sql', '027_factor_disclosure.sql', '028_review_issues.sql', '029_case_reopen.sql'
  ]);
  const {rows: [upgradedDraft]} = await act(owner, selectDraft);
  for (const [key, value] of Object.entries(originalDraft)) assert.deepEqual(upgradedDraft[key], value, key);
  const original = await act(owner, tx => tx.query('SELECT * FROM carbon.internal_report_delivery WHERE id = $1', [originalDelivery.id]));
  assert.deepEqual(original.rows, [originalDelivery]);
  await db.admin.transaction(tx => tx.query(`INSERT INTO catalog.factor_reference_disclosure (factor_id, version, scope, basis)
    VALUES ($1, 1, 'summary_only', 'Fixture disclosure')`, [summaryFactor]));

  const rejected = {code: '23514', constraint: 'report_delivery_factor_disclosure'};
  await assert.rejects(insertDelivery(privateDraft, false, false), rejected);
  await assert.rejects(insertDelivery(summaryDraft, true, false), rejected);
  await assert.rejects(insertDelivery(summaryDraft, false, true), rejected);
  assert.equal((await insertDelivery(summaryDraft, false, false)).rows.length, 1);
  assert.equal((await insertDelivery(fullDraft, true, true, 'Another recipient')).rows.length, 1);
});
