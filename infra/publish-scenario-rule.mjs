import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { connectPostgres } from './postgres.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function publishScenarioRule(database, {tenantId, orgId, proposalId}) {
  if (![tenantId, orgId, proposalId].every(value => typeof value === 'string' && uuid.test(value))) {
    throw new Error('Expected tenantId, orgId, and proposalId UUIDs');
  }
  return database.transaction(async tx => {
    await tx.query("SELECT set_config('carbon.tenant_id', $1::uuid::text, true)", [tenantId]);
    const scope = [tenantId, orgId, proposalId];
    const {rows: [proposal]} = await tx.query(`
      SELECT base_release_id, status
      FROM carbon.scenario_rule_proposal
      WHERE tenant_id = $1 AND org_id = $2 AND id = $3
      FOR UPDATE`, scope);
    if (!proposal || proposal.status !== 'approved') {
      throw new Error('An approved proposal is required in this tenant and organization');
    }

    const {rows: [prior]} = await tx.query(`
      SELECT publication.release_id AS "releaseId", release.version
      FROM carbon.scenario_rule_publication AS publication
      JOIN carbon.scenario_release AS release
        ON release.tenant_id = publication.tenant_id AND release.id = publication.release_id
      WHERE publication.tenant_id = $1 AND publication.org_id = $2 AND publication.proposal_id = $3`, scope);
    if (prior) return {...prior, replayed: true};

    // Different proposals from the same base serialize on that base release.
    const {rows: [base]} = await tx.query(`
      SELECT code FROM carbon.scenario_release
      WHERE tenant_id = $1 AND id = $2 AND (org_id IS NULL OR org_id = $3)
      FOR UPDATE`, [tenantId, proposal.base_release_id, orgId]);
    if (!base) {
      throw new Error('Scenario base release is outside the proposal organization scope');
    }
    const {rows: [latest]} = await tx.query(`
      SELECT id FROM carbon.scenario_release
      WHERE tenant_id = $1 AND code = $2 AND (org_id IS NULL OR org_id = $3)
      ORDER BY version DESC, (org_id IS NOT NULL) DESC LIMIT 1`, [tenantId, base.code, orgId]);
    if (latest.id !== proposal.base_release_id) {
      throw new Error('Scenario base release has changed; submit a proposal against the latest release');
    }

    const releaseId = randomUUID();
    const {rows: [published]} = await tx.query(`
      INSERT INTO carbon.scenario_release (tenant_id, org_id, id, code, version, manifest)
      SELECT base.tenant_id, $2, $4, base.code, base.version + 1,
        jsonb_set(base.manifest, '{references}', proposal.references_payload, true)
      FROM carbon.scenario_rule_proposal AS proposal
      JOIN carbon.scenario_release AS base
        ON base.tenant_id = proposal.tenant_id AND base.id = proposal.base_release_id
      WHERE proposal.tenant_id = $1 AND proposal.org_id = $2 AND proposal.id = $3
      RETURNING id AS "releaseId", version`, [...scope, releaseId]);
    await tx.query(`
      INSERT INTO carbon.scenario_rule_publication (tenant_id, org_id, proposal_id, release_id)
      VALUES ($1, $2, $3, $4)`, [...scope, published.releaseId]);
    return {...published, replayed: false};
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length !== 3) {
    throw new Error('Usage: node infra/publish-scenario-rule.mjs <tenantId> <orgId> <proposalId>');
  }
  const [tenantId, orgId, proposalId] = args;
  // The authorized deployment credential owns the carbon schema; the
  // application role has no permission to write releases or publications.
  const database = connectPostgres(process.env.MIGRATION_DATABASE_URL, { migration: true, max: 1 });
  try {
    console.log(JSON.stringify(await publishScenarioRule(database, {tenantId, orgId, proposalId})));
  } finally {
    await database.close();
  }
}
