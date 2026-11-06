import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createEmbeddedDatabase } from '../infra/embedded.mjs';
import { migrate } from '../infra/migrations.mjs';
import { publishScenarioRule } from '../infra/publish-scenario-rule.mjs';

const newMigrations = ['018_case_rule_assessment.sql', '019_scenario_rule_proposals.sql'];

test('rule migrations bootstrap an empty database and replay without changes', async t => {
  const db = await createEmbeddedDatabase();
  t.after(() => db.close());
  assert.deepEqual((await migrate(db.admin)).slice(-2), newMigrations);
  assert.deepEqual(await migrate(db.admin), []);
});

test('upgrade existing tasks, constrain rule decisions, and publish and recalculate within scope', async t => {
  const db = await createEmbeddedDatabase();
  t.after(() => db.close());
  const source = new URL('../migrations/', import.meta.url);
  const previous = (await readdir(source)).filter(name => /^\d{3}_.+\.sql$/.test(name) && name < '018').sort();
  const directory = await mkdtemp(join(tmpdir(), 'carbon-rule-migration-'));
  const copied = [];
  try {
    for (const filename of previous) {
      const destination = join(directory, filename);
      await copyFile(new URL(filename, source), destination);
      copied.push(destination);
    }
    assert.equal(previous.at(-1), '017_electricity_factor_catalog.sql');
    assert.deepEqual(await migrate(db.admin, pathToFileURL(directory + sep)), previous);
  } finally {
    for (const filename of copied) await unlink(filename);
    await rmdir(directory);
  }

  const [tenant, otherTenant, org, siblingOrg, customer, reviewer, administrator, siblingAdmin,
    foreignAdmin, release, caseId, siblingCase, foreignCase] = Array.from({length: 13}, () => randomUUID());
  const request = 'rule-database-test';
  const manifest = {label: 'Inventory', references: [
    {code: 'RULE-1', publicationStatus: 'effective'}, {code: 'DRAFT', publicationStatus: 'draft'}
  ]};
  const proposed = [{code: 'RULE-2', publicationStatus: 'effective'}];
  const scope = {boundaryDescription: 'Test organization'};
  const act = (actor, callback, workspace = tenant) => db.runtime.transaction(async tx => {
    await tx.query(`SELECT set_config('carbon.tenant_id', $1, true),
      set_config('carbon.actor_id', $2, true), set_config('carbon.request_id', $3, true)`,
    [workspace, actor, request]);
    return callback(tx);
  });
  await db.admin.transaction(async tx => {
    await tx.query("INSERT INTO carbon.workspace VALUES ($1, 'Workspace'), ($2, 'Other')", [tenant, otherTenant]);
    await tx.query(`INSERT INTO carbon.organization VALUES ($1, $2, 'Main'), ($1, $3, 'Sibling'), ($4, $2, 'External')`,
      [tenant, org, siblingOrg, otherTenant]);
    await tx.query(`INSERT INTO carbon.org_grant VALUES
      ($1, $2, $3, 'customer'), ($1, $2, $3, 'reviewer'), ($1, $2, $4, 'reviewer'),
      ($1, $2, $5, 'admin'), ($1, $2, $5, 'reviewer'), ($1, $6, $7, 'admin'),
      ($1, $6, $3, 'customer'), ($1, $6, $4, 'reviewer'),
      ($8, $2, $9, 'admin'), ($8, $2, $3, 'customer'), ($8, $2, $4, 'reviewer')`,
    [tenant, org, customer, reviewer, administrator, siblingOrg, siblingAdmin, otherTenant, foreignAdmin]);
    await tx.query(`INSERT INTO carbon.scenario_release VALUES
      ($1, $2, 'inventory', 1, $3), ($4, $2, 'inventory', 1, $3)`, [tenant, release, manifest, otherTenant]);
  });
  for (const [workspace, organization, id] of [[tenant, org, caseId], [tenant, siblingOrg, siblingCase], [otherTenant, org, foreignCase]]) {
    await act(customer, async tx => {
      await tx.query(`INSERT INTO carbon.case_intake
        (tenant_id, org_id, scenario_release_id, created_by, id, purpose, intake_scope)
        VALUES ($1, $2, $3, $4, $5, 'Inventory', $6)`, [workspace, organization, release, customer, id, scope]);
      const snapshot = randomUUID();
      await tx.query(`INSERT INTO carbon.calculation_snapshot
        (tenant_id, org_id, case_id, id, created_by, request_id, schema_version, from_period, to_period, input_fingerprint, payload)
        VALUES ($1, $2, $3, $4, $5, $6, 1, '2025-01-01', '2025-01-01', $7, $8)`,
      [workspace, organization, id, snapshot, customer, request, 'a'.repeat(64),
        {caseId: id, mode: 'synthetic', formalReportEligible: false, coverage: {status: 'complete'}}]);
      await tx.query(`INSERT INTO carbon.internal_report_draft
        (tenant_id, org_id, case_id, id, snapshot_id, template_id, template_version, created_by, request_id, payload)
        VALUES ($1, $2, $3, $4, $5, 'internal-management-demo', 1, $6, $7, $8)`,
      [workspace, organization, id, randomUUID(), snapshot, customer, request, {
        caseId: id, snapshotId: snapshot, status: 'draft', mode: 'synthetic', formalReportEligible: false,
        externalDeliveryEligible: false, report: {watermark: '内部演示｜合成因子｜禁止外发'}
      }]);
      await tx.query("UPDATE carbon.case_intake SET status = 'submitted', revision = 2 WHERE id = $1", [id]);
    }, workspace);
    await act(reviewer, tx => tx.query(`INSERT INTO carbon.case_factor_decision
      (tenant_id, org_id, case_id, submission_revision, factor_id, factor_version, decided_by, request_id, method_reference, rationale)
      VALUES ($1, $2, $3, 2, 'cn-electricity-organization-bj-2023', 1, $4, $5, 'Test method', 'Test rationale')`,
    [workspace, organization, id, reviewer, request]), workspace);
  }
  assert.deepEqual(await migrate(db.admin), newMigrations);
  assert.deepEqual(await migrate(db.admin), []);

  const decide = (tx, actor, revision, code = 'RULE-1') => tx.query(`INSERT INTO carbon.case_rule_decision
    (tenant_id, org_id, case_id, submission_revision, status, reference_code, rationale, decided_by, request_id)
    VALUES ($1, $2, $3, $4, 'confirmed', $5, 'Test rationale', $6, $7)`,
  [tenant, org, caseId, revision, code, actor, request]);
  await assert.rejects(act(customer, tx => decide(tx, customer, 2)), {code: '42501'});
  await assert.rejects(act(reviewer, tx => decide(tx, reviewer, 2, 'DRAFT')), {constraint: 'case_rule_decision_reference'});
  await act(reviewer, tx => tx.query(`UPDATE carbon.case_intake SET status = 'returned', revision = 3,
    return_reason = 'Confirm scope' WHERE id = $1`, [caseId]));
  await act(customer, tx => tx.query(`UPDATE carbon.case_intake SET status = 'submitted', revision = 4,
    return_reason = NULL, correction_note = 'Confirmed scope' WHERE id = $1`, [caseId]));
  await assert.rejects(act(reviewer, tx => decide(tx, reviewer, 2)), {constraint: 'case_rule_decision_submission_state'});
  await act(reviewer, tx => decide(tx, reviewer, 4));
  const ruleRows = tx => tx.query('SELECT reference_code FROM carbon.case_rule_decision WHERE case_id = $1', [caseId]);
  assert.deepEqual((await act(customer, ruleRows)).rows, [{reference_code: 'RULE-1'}]);
  for (const [actor, workspace] of [[siblingAdmin, tenant], [foreignAdmin, otherTenant]]) {
    assert.deepEqual((await act(actor, ruleRows, workspace)).rows, []);
  }
  const mutateRule = tx => tx.query("UPDATE carbon.case_rule_decision SET rationale = 'Rewritten' WHERE case_id = $1", [caseId]);
  await assert.rejects(act(reviewer, mutateRule), {code: '42501'});
  await assert.rejects(db.admin.transaction(mutateRule), {code: '55000'});

  const impact = (tx, organization = org) => tx.query('SELECT * FROM carbon.rule_impact_dependencies($1, $2)', [organization, release]);
  const count = [{factor_count: 1, model_count: 1, report_count: 1}];
  assert.deepEqual((await act(administrator, impact)).rows, count);
  assert.deepEqual((await act(foreignAdmin, impact, otherTenant)).rows, count);
  assert.deepEqual((await act(siblingAdmin, tx => impact(tx, siblingOrg))).rows, count);
  await assert.rejects(act(siblingAdmin, impact), {code: '42501'});
  await assert.rejects(act(reviewer, impact), {code: '42501'});

  const proposal = randomUUID(), staleProposal = randomUUID(), siblingProposal = randomUUID();
  const siblingReferences = [{code: 'SIBLING-RULE-2', publicationStatus: 'effective'}];
  const submitProposal = (tx, id, {organization = org, base = release, actor = administrator, references = proposed} = {}) =>
    tx.query(`INSERT INTO carbon.scenario_rule_proposal
    (tenant_id, org_id, id, base_release_id, references_payload, created_by, request_id)
    VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`, [tenant, organization, id, base, JSON.stringify(references), actor, request]);
  const approve = (tx, id, actor) => tx.query(`UPDATE carbon.scenario_rule_proposal SET status = 'approved',
    reviewed_by = $2, review_request_id = $3 WHERE id = $1 RETURNING status`, [id, actor, request]);
  await act(administrator, tx => submitProposal(tx, proposal));
  await act(administrator, tx => submitProposal(tx, staleProposal));
  await act(siblingAdmin, tx => submitProposal(tx, siblingProposal, {
    organization: siblingOrg, actor: siblingAdmin, references: siblingReferences
  }));
  const proposalRows = tx => tx.query('SELECT id FROM carbon.scenario_rule_proposal WHERE id = $1', [proposal]);
  assert.deepEqual((await act(siblingAdmin, proposalRows)).rows, []);
  assert.deepEqual((await act(foreignAdmin, proposalRows, otherTenant)).rows, []);
  const publish = (id, organization = org) => publishScenarioRule(db.admin, {tenantId: tenant, orgId: organization, proposalId: id});
  await assert.rejects(publish(proposal), /approved proposal/i);
  assert.deepEqual((await act(administrator, tx => approve(tx, proposal, administrator))).rows, []);
  assert.deepEqual((await act(reviewer, tx => approve(tx, proposal, reviewer))).rows, [{status: 'approved'}]);
  await assert.rejects(act(reviewer, tx => approve(tx, proposal, reviewer)), {constraint: 'scenario_rule_proposal_transition'});
  await act(reviewer, tx => approve(tx, staleProposal, reviewer));
  await act(reviewer, tx => approve(tx, siblingProposal, reviewer));
  await assert.rejects(publish(proposal, siblingOrg), /approved proposal/i);
  const publication = await publish(proposal);
  assert.deepEqual(publication, {releaseId: publication.releaseId, version: 2, replayed: false});
  assert.deepEqual(await publish(proposal), {...publication, replayed: true});
  await assert.rejects(publish(staleProposal), /base release has changed/i);
  const siblingPublication = await publish(siblingProposal, siblingOrg);
  assert.equal(siblingPublication.version, 2);
  assert.equal(siblingPublication.replayed, false);
  assert.notEqual(siblingPublication.releaseId, publication.releaseId);
  assert.deepEqual(await publish(siblingProposal, siblingOrg), {...siblingPublication, replayed: true});

  const visibleReleases = tx => tx.query(`SELECT id, org_id, version, manifest
    FROM carbon.scenario_release WHERE code = 'inventory' ORDER BY version`);
  const visiblePublications = tx => tx.query('SELECT release_id FROM carbon.scenario_rule_publication');
  for (const [actor, organization, published, references] of [
    [administrator, org, publication, proposed],
    [siblingAdmin, siblingOrg, siblingPublication, siblingReferences]
  ]) {
    assert.deepEqual((await act(actor, visibleReleases)).rows, [
      {id: release, org_id: null, version: 1, manifest},
      {id: published.releaseId, org_id: organization, version: 2, manifest: {...manifest, references}}
    ]);
    assert.deepEqual((await act(actor, visiblePublications)).rows, [{release_id: published.releaseId}]);
  }
  await assert.rejects(act(siblingAdmin, tx => submitProposal(tx, randomUUID(), {
    organization: siblingOrg, actor: siblingAdmin, base: publication.releaseId
  })), {constraint: 'scenario_rule_proposal_base_scope'});
  await assert.rejects(db.admin.transaction(tx => tx.query(`DELETE FROM carbon.scenario_rule_publication
    WHERE proposal_id = $1`, [proposal])), {code: '55000'});

  // This customer belongs to both organizations and can read both releases.
  // A case still cannot use a release owned by its sibling organization.
  assert.ok((await act(customer, visibleReleases)).rows.some(row => row.id === siblingPublication.releaseId));
  await assert.rejects(act(customer, tx => tx.query(`INSERT INTO carbon.case_intake
    (tenant_id, org_id, id, scenario_release_id, created_by, purpose, intake_scope)
    VALUES ($1, $2, $3, $4, $5, 'Inventory', $6)`,
  [tenant, org, randomUUID(), siblingPublication.releaseId, customer, scope])), {constraint: 'case_intake_scenario_scope'});
  const recalculate = (tx, parent, nextRelease = publication.releaseId) => tx.query(`INSERT INTO carbon.case_intake
    (tenant_id, org_id, id, scenario_release_id, created_by, purpose, intake_scope, rule_recalculation_of)
    VALUES ($1, $2, $3, $4, $5, 'Inventory', $6, $7) RETURNING id, rule_recalculation_of`,
  [tenant, org, randomUUID(), nextRelease, customer, scope, parent]);
  for (const parent of [siblingCase, foreignCase]) {
    await assert.rejects(act(customer, tx => recalculate(tx, parent)), {constraint: 'case_intake_rule_recalculation_source'});
  }
  await assert.rejects(act(customer, tx => recalculate(tx, caseId, release)), {constraint: 'case_intake_rule_recalculation_source'});
  await assert.rejects(act(customer, tx => recalculate(tx, caseId, siblingPublication.releaseId)),
    {constraint: 'case_intake_scenario_scope'});
  const {rows: [child]} = await act(customer, tx => recalculate(tx, caseId));
  assert.equal(child.rule_recalculation_of, caseId);
  const rewriteSource = tx => tx.query(`UPDATE carbon.case_intake
    SET rule_recalculation_of = NULL, status = 'submitted', revision = 2 WHERE id = $1`, [child.id]);
  await assert.rejects(act(customer, rewriteSource), {code: '42501'});
  await assert.rejects(db.admin.transaction(async tx => {
    await tx.query(`SELECT set_config('carbon.tenant_id', $1, true),
      set_config('carbon.actor_id', $2, true), set_config('carbon.request_id', $3, true)`,
    [tenant, customer, request]);
    await rewriteSource(tx);
  }), {code: '55000'});
});
