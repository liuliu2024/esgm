import { randomUUID } from 'node:crypto';

export class CarbonError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const caseFields = `id, org_id AS "orgId", scenario_release_id AS "scenarioReleaseId",
  created_by AS "createdBy", purpose, status, revision, return_reason AS "returnReason"`;

function accessDenied() {
  return new CarbonError(403, 'ACCESS_DENIED', '你没有该组织的操作权限。');
}

function caseMissing() {
  return new CarbonError(404, 'CASE_NOT_FOUND', '未找到可访问的受理任务。');
}

async function requireRole(tx, scope, orgId, role) {
  const result = await tx.query(`
    SELECT 1 FROM carbon.org_grant
    WHERE tenant_id = $1 AND org_id = $2 AND actor_id = $3 AND role = $4
  `, [scope.tenantId, orgId, scope.actorId, role]);
  if (result.rows.length === 0) throw accessDenied();
}

async function readCase(tx, scope, orgId, id, customerOnly = false) {
  const result = await tx.query(`
    SELECT ${caseFields} FROM carbon.case_intake
    WHERE tenant_id = $1 AND org_id = $2 AND id = $3
      AND ($4::uuid IS NULL OR created_by = $4)
  `, [scope.tenantId, orgId, id, customerOnly ? scope.actorId : null]);
  if (result.rows.length === 0) throw caseMissing();
  return result.rows[0];
}

async function transition(tx, scope, orgId, id, revision, before, after, customerOnly, reason = null) {
  const current = await readCase(tx, scope, orgId, id, customerOnly);
  if (!customerOnly && current.createdBy === scope.actorId) {
    throw new CarbonError(403, 'SELF_REVIEW_FORBIDDEN', '发起人不能复核自己的任务。');
  }
  if (current.revision !== revision || current.status !== before) {
    throw new CarbonError(409, 'CASE_CONFLICT', '任务状态或版本已变化，请刷新后重试。');
  }
  const result = await tx.query(`
    UPDATE carbon.case_intake SET status = $6, revision = revision + 1, return_reason = $8
    WHERE tenant_id = $1 AND org_id = $2 AND id = $3 AND revision = $4 AND status = $5
      AND ($7::uuid IS NULL OR created_by = $7)
    RETURNING ${caseFields}
  `, [scope.tenantId, orgId, id, revision, before, after, customerOnly ? scope.actorId : null, reason]);
  if (result.rows.length === 0) {
    throw new CarbonError(409, 'CASE_CONFLICT', '任务状态或版本已变化，请刷新后重试。');
  }
  return result.rows[0];
}

export function createIntakeService(database) {
  function inWorkspace(scope, command) {
    return database.transaction(async tx => {
      await tx.query(`SELECT
        set_config('carbon.tenant_id', $1, true),
        set_config('carbon.actor_id', $2, true),
        set_config('carbon.request_id', $3, true)
      `, [scope.tenantId, scope.actorId, scope.requestId]);
      return command(tx);
    });
  }

  return {
    create(scope, input) {
      return inWorkspace(scope, async tx => {
        await requireRole(tx, scope, input.orgId, 'customer');
        const scenario = await tx.query(`
          SELECT 1 FROM carbon.scenario_release WHERE tenant_id = $1 AND id = $2
        `, [scope.tenantId, input.scenarioReleaseId]);
        if (scenario.rows.length === 0) {
          throw new CarbonError(404, 'SCENARIO_NOT_FOUND', '未找到可访问的场景版本。');
        }
        const result = await tx.query(`
          INSERT INTO carbon.case_intake
            (tenant_id, id, org_id, scenario_release_id, created_by, purpose)
          VALUES ($1, $2, $3, $4, $5, $6)
          RETURNING ${caseFields}
        `, [scope.tenantId, randomUUID(), input.orgId, input.scenarioReleaseId, scope.actorId, input.purpose]);
        return result.rows[0];
      });
    },

    read(scope, orgId, id, customerOnly) {
      return inWorkspace(scope, async tx => {
        await requireRole(tx, scope, orgId, customerOnly ? 'customer' : 'reviewer');
        const result = await readCase(tx, scope, orgId, id, customerOnly);
        if (!customerOnly && result.status === 'draft') throw caseMissing();
        return result;
      });
    },

    submit(scope, orgId, id, revision) {
      return inWorkspace(scope, async tx => {
        await requireRole(tx, scope, orgId, 'customer');
        return transition(tx, scope, orgId, id, revision, 'draft', 'submitted', true);
      });
    },

    review(scope, orgId, id, revision, decision, reason) {
      return inWorkspace(scope, async tx => {
        await requireRole(tx, scope, orgId, 'reviewer');
        return transition(tx, scope, orgId, id, revision, 'submitted', decision, false, reason);
      });
    },

    listGrants(scope, orgId, limit, offset) {
      return inWorkspace(scope, async tx => {
        await requireRole(tx, scope, orgId, 'admin');
        const result = await tx.query(`
          SELECT actor_id AS "actorId", role FROM carbon.org_grant
          WHERE tenant_id = $1 AND org_id = $2 AND actor_id = $3 ORDER BY role
          LIMIT $4 OFFSET $5
        `, [scope.tenantId, orgId, scope.actorId, limit + 1, offset]);
        return {
          grants: result.rows.slice(0, limit),
          nextOffset: result.rows.length > limit ? offset + limit : null
        };
      });
    },

    listAudit(scope, orgId, limit, offset) {
      return inWorkspace(scope, async tx => {
        await requireRole(tx, scope, orgId, 'admin');
        const result = await tx.query(`
          SELECT id, case_id AS "caseId", actor_id AS "actorId", action, reason, revision,
                 request_id AS "requestId", created_at AS "createdAt"
          FROM carbon.audit_event WHERE tenant_id = $1 AND org_id = $2
          ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4
        `, [scope.tenantId, orgId, limit + 1, offset]);
        return {
          events: result.rows.slice(0, limit),
          nextOffset: result.rows.length > limit ? offset + limit : null
        };
      });
    }
  };
}
