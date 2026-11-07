import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createEmbeddedDatabase } from '../infra/embedded.mjs';
import { migrate } from '../infra/migrations.mjs';

test('028 and 029 enforce issue history and one unchanged draft from an approved source', async t => {
  const db = await createEmbeddedDatabase();
  t.after(() => db.close());
  const migrations = await migrate(db.admin);
  const auditStart = migrations.indexOf('028_review_issues.sql');
  assert.deepEqual(migrations.slice(auditStart, auditStart + 2),
    ['028_review_issues.sql', '029_case_reopen.sql']);
  const [tenant, foreignTenant, org, siblingOrg, release, owner, reviewer, peer, siblingReviewer,
    foreignReviewer, task, oldEvidence, currentEvidence, issueId, reopenId, child] =
    Array.from({length: 16}, randomUUID);
  const scope = {subjectType: 'facility', subjectName: 'Fixture plant', reportingYear: '2026'};
  const requestId = 'audit-delivery-db-test';
  const act = (actor, operation, workspace = tenant) => db.runtime.transaction(async tx => {
    await tx.query(`SELECT set_config('carbon.tenant_id', $1, true), set_config('carbon.actor_id', $2, true),
      set_config('carbon.request_id', $3, true)`, [workspace, actor, requestId]);
    return operation(tx);
  });
  await db.admin.transaction(async tx => {
    await tx.query("INSERT INTO carbon.workspace VALUES ($1, 'Workspace'), ($2, 'Foreign')", [tenant, foreignTenant]);
    await tx.query("INSERT INTO carbon.organization VALUES ($1, $2, 'Main'), ($1, $3, 'Sibling'), ($4, $2, 'Foreign')",
      [tenant, org, siblingOrg, foreignTenant]);
    await tx.query("INSERT INTO carbon.scenario_release (tenant_id, id, code, version, manifest) VALUES ($1, $2, 'inventory', 1, '{}')",
      [tenant, release]);
    await tx.query(`INSERT INTO carbon.org_grant VALUES
      ($1, $2, $3, 'customer'), ($1, $2, $3, 'reviewer'), ($1, $2, $4, 'reviewer'),
      ($1, $2, $5, 'customer'), ($1, $6, $7, 'reviewer'), ($8, $2, $9, 'reviewer')`,
    [tenant, org, owner, reviewer, peer, siblingOrg, siblingReviewer, foreignTenant, foreignReviewer]);
  });
  await act(owner, tx => tx.query(`INSERT INTO carbon.case_intake
    (tenant_id, org_id, id, scenario_release_id, created_by, purpose, intake_scope)
    VALUES ($1, $2, $3, $4, $5, 'Inventory', $6)`, [tenant, org, task, release, owner, scope]));

  async function registerEvidence(evidence) {
    const receipt = randomUUID();
    const hash = 'a'.repeat(64);
    await act(owner, async tx => {
      await tx.query(`INSERT INTO carbon.case_evidence
        (tenant_id, org_id, case_id, id, registered_by, title, source_description)
        VALUES ($1, $2, $3, $4, $5, 'Fixture evidence', 'Fixture source')`, [tenant, org, task, evidence, owner]);
      await tx.query(`INSERT INTO carbon.evidence_receipt
        (tenant_id, org_id, case_id, evidence_id, id, received_by, media_type, byte_size, sha256)
        VALUES ($1, $2, $3, $4, $5, $6, 'application/pdf', 128, $7)`, [tenant, org, task, evidence, receipt, owner, hash]);
    });
    await db.admin.transaction(tx => tx.query(`INSERT INTO carbon.evidence_scan
      (tenant_id, org_id, case_id, evidence_id, receipt_id, sha256, verdict, engine, signature_version)
      VALUES ($1, $2, $3, $4, $5, $6, 'pass', 'fixture', 'v1')`, [tenant, org, task, evidence, receipt, hash]));
  }
  async function submit(evidence, revision, correctionNote = null) {
    await act(owner, async tx => {
      await tx.query("SELECT set_config('carbon.submission_evidence_ids', $1::uuid[]::text, true)", [[evidence]]);
      await tx.query(`UPDATE carbon.case_intake SET status = 'submitted', revision = $2,
        return_reason = NULL, correction_note = $3 WHERE id = $1`, [task, revision, correctionNote]);
    });
  }
  await registerEvidence(oldEvidence);
  await submit(oldEvidence, 2);
  const issue = (tx, actor, evidence, revision, id = issueId) => tx.query(`INSERT INTO carbon.review_issue
    (tenant_id, org_id, case_id, id, submission_revision, evidence_id, title, description, severity, due_date,
      assignee_id, created_by, last_actor_id, request_id)
    VALUES ($1, $2, $3, $4, $5, $6, 'Fixture issue', 'Check receipt', 'critical', '2026-12-01', $7, $8, $8, $9)`,
  [tenant, org, task, id, revision, evidence, owner, actor, requestId]);
  await assert.rejects(act(owner, tx => issue(tx, owner, oldEvidence, 2)), {code: '42501'});
  await act(reviewer, tx => issue(tx, reviewer, oldEvidence, 2));
  await act(reviewer, tx => tx.query(`UPDATE carbon.case_intake SET status = 'returned', revision = 3,
    return_reason = 'Supply new evidence' WHERE id = $1`, [task]));
  await registerEvidence(currentEvidence);
  await submit(currentEvidence, 4, 'Updated evidence');
  await assert.rejects(act(reviewer, tx => issue(tx, reviewer, currentEvidence, 2, randomUUID())),
    {constraint: 'review_issue_evidence_reference'});
  await assert.rejects(act(reviewer, tx => issue(tx, reviewer, oldEvidence, 4, randomUUID())),
    {constraint: 'review_issue_evidence_reference'});
  const update = (tx, actor, status, action, version) => tx.query(`UPDATE carbon.review_issue SET
    status = $2, last_action = $3, version = $4, last_actor_id = $5, last_note = 'Fixture note', request_id = $6
    WHERE id = $1 RETURNING status`, [issueId, status, action, version, actor, requestId]);
  await assert.rejects(act(reviewer, tx => update(tx, reviewer, 'answered', 'replied', 2)), {code: '42501'});
  await act(owner, tx => update(tx, owner, 'answered', 'replied', 2));
  await assert.rejects(act(owner, tx => update(tx, owner, 'closed', 'closed', 3)), {code: '42501'});
  await act(reviewer, tx => update(tx, reviewer, 'open', 'request_follow_up', 3));
  await act(owner, tx => update(tx, owner, 'answered', 'replied', 4));
  await act(reviewer, tx => update(tx, reviewer, 'closed', 'closed', 5));
  await assert.rejects(act(reviewer, tx => update(tx, reviewer, 'closed', 'closed', 6)),
    {constraint: 'review_issue_transition'});
  const readIssue = tx => tx.query('SELECT submission_revision, evidence_id, status, version FROM carbon.review_issue WHERE id = $1', [issueId]);
  const events = tx => tx.query('SELECT version, action, actor_id FROM carbon.review_issue_event WHERE issue_id = $1 ORDER BY version', [issueId]);
  assert.deepEqual((await act(owner, readIssue)).rows, [{submission_revision: 2, evidence_id: oldEvidence, status: 'closed', version: 5}]);
  assert.deepEqual((await act(reviewer, events)).rows, [
    {version: 1, action: 'opened', actor_id: reviewer}, {version: 2, action: 'replied', actor_id: owner},
    {version: 3, action: 'request_follow_up', actor_id: reviewer}, {version: 4, action: 'replied', actor_id: owner},
    {version: 5, action: 'closed', actor_id: reviewer}
  ]);
  for (const [actor, workspace] of [[peer, tenant], [siblingReviewer, tenant], [foreignReviewer, foreignTenant]]) {
    assert.deepEqual((await act(actor, readIssue, workspace)).rows, []);
    assert.deepEqual((await act(actor, events, workspace)).rows, []);
  }
  const overwriteEvent = tx => tx.query("UPDATE carbon.review_issue_event SET note = 'Rewritten' WHERE issue_id = $1", [issueId]);
  await assert.rejects(act(reviewer, overwriteEvent), {code: '42501'});
  await assert.rejects(db.admin.transaction(overwriteEvent), {code: '55000'});

  const requestReopen = (tx, actor, revision, id = reopenId) => tx.query(`INSERT INTO carbon.case_reopen_request
    (tenant_id, org_id, case_id, id, approved_revision, reason, created_by, request_id)
    VALUES ($1, $2, $3, $4, $5, 'Recheck locked inventory', $6, $7)`, [tenant, org, task, id, revision, actor, requestId]);
  await assert.rejects(act(owner, tx => requestReopen(tx, owner, 4)), {constraint: 'case_reopen_request_source'});
  await act(reviewer, tx => tx.query("UPDATE carbon.case_intake SET status = 'approved', revision = 5 WHERE id = $1", [task]));
  await assert.rejects(act(owner, tx => requestReopen(tx, owner, 4)), {constraint: 'case_reopen_request_source'});
  await assert.rejects(act(peer, tx => requestReopen(tx, peer, 5)), {code: '42501'});
  await act(owner, tx => requestReopen(tx, owner, 5));
  await assert.rejects(act(owner, tx => requestReopen(tx, owner, 5, randomUUID())), {constraint: 'case_reopen_request_active_case'});

  const createChild = (tx, id, declaredScope = scope, organization = org) => tx.query(`INSERT INTO carbon.case_intake
    (tenant_id, org_id, id, scenario_release_id, created_by, purpose, intake_scope, reopen_request_id)
    VALUES ($1, $2, $3, $4, $5, 'Inventory', $6, $7) RETURNING id, status, revision`,
  [tenant, organization, id, release, owner, declaredScope, reopenId]);
  await assert.rejects(act(owner, tx => createChild(tx, child)), {constraint: 'case_intake_reopen_source'});
  const approve = (tx, actor) => tx.query(`UPDATE carbon.case_reopen_request SET status = 'approved',
    reviewed_by = $2, review_request_id = $3 WHERE id = $1 RETURNING status`, [reopenId, actor, requestId]);
  await assert.rejects(act(owner, tx => approve(tx, owner)), {code: '42501'});
  assert.deepEqual((await act(siblingReviewer, tx => approve(tx, siblingReviewer))).rows, []);
  assert.deepEqual((await act(foreignReviewer, tx => approve(tx, foreignReviewer), foreignTenant)).rows, []);
  assert.deepEqual((await act(reviewer, tx => approve(tx, reviewer))).rows, [{status: 'approved'}]);
  await assert.rejects(act(owner, tx => createChild(tx, child, {...scope, reportingYear: '2027'})),
    {constraint: 'case_intake_reopen_source'});
  assert.deepEqual((await act(owner, tx => createChild(tx, child))).rows, [{id: child, status: 'draft', revision: 1}]);
  await assert.rejects(act(owner, tx => createChild(tx, randomUUID())), {constraint: 'case_intake_reopen_request_key'});
  await assert.rejects(act(owner, tx => tx.query("UPDATE carbon.case_intake SET status = 'submitted', revision = 6 WHERE id = $1", [task])),
    {code: '23514'});
  assert.deepEqual((await act(owner, tx => tx.query('SELECT status, revision, intake_scope FROM carbon.case_intake WHERE id = $1', [task]))).rows,
    [{status: 'approved', revision: 5, intake_scope: scope}]);
});
