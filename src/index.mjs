import { CarbonError, createIntakeService } from './intake.mjs';

const uuidPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const routes = {
  cases: /^\/v1\/(customer|professional)\/cases$/,
  case: /^\/v1\/(customer|professional)\/cases\/([^/]+)$/,
  history: /^\/v1\/(customer|professional)\/cases\/([^/]+)\/history$/,
  evidence: /^\/v1\/(customer|professional)\/cases\/([^/]+)\/evidence$/,
  submit: /^\/v1\/customer\/cases\/([^/]+)\/submit$/,
  resubmit: /^\/v1\/customer\/cases\/([^/]+)\/resubmit$/,
  review: /^\/v1\/professional\/cases\/([^/]+)\/review$/,
  administration: /^\/v1\/admin\/organizations\/([^/]+)\/(grants|audit)$/
};

function fail(status, code, message) {
  throw new CarbonError(status, code, message);
}

function badRequest(message) {
  fail(400, 'INVALID_REQUEST', message);
}

function uuid(value, label) {
  if (typeof value !== 'string' || !uuidPattern.test(value)) badRequest(`${label}必须是有效的标识。`);
  return value.toLowerCase();
}

function trustedScope(context) {
  if (typeof context?.actorId !== 'string' || !uuidPattern.test(context.actorId)
    || typeof context.tenantId !== 'string' || !uuidPattern.test(context.tenantId)) {
    fail(401, 'AUTHENTICATION_REQUIRED', '需要有效的工作空间会话。');
  }
  if (typeof context.requestId !== 'string' || !context.requestId.trim() || context.requestId.length > 200
    || /[\u0000-\u001f\u007f]/.test(context.requestId)) {
    fail(500, 'REQUEST_CONTEXT_INVALID', '服务无法建立操作审计。');
  }
  return {
    tenantId: context.tenantId.toLowerCase(),
    actorId: context.actorId.toLowerCase(),
    requestId: context.requestId
  };
}

function commandBody(body, fields, optional = []) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some(key => !fields.includes(key) && !optional.includes(key))
    || fields.some(key => !Object.hasOwn(body, key))) {
    badRequest('请求字段缺失或包含不受支持的字段。');
  }
  return body;
}

function revision(value) {
  if (!Number.isInteger(value) || value < 1 || value > 2147483647) badRequest('任务版本必须为正整数。');
  return value;
}

function requiredText(value, label, maximum = 500) {
  if (typeof value !== 'string' || !value.trim() || /\u0000/.test(value) || [...value.trim()].length > maximum) {
    badRequest(`请填写${label}，最多 ${maximum} 个字符。`);
  }
  return value.trim();
}

function queryFields(params, fields) {
  const seen = new Set();
  for (const [key] of params) {
    if (!fields.includes(key) || seen.has(key)) badRequest('查询参数重复或不受支持。');
    seen.add(key);
  }
}

function paging(params) {
  queryFields(params, ['limit', 'offset']);
  const offset = params.get('offset') ?? '0';
  if (!/^\d{1,9}$/.test(offset)) badRequest('分页参数无效。');
  return [pageLimit(params), Number(offset)];
}

function pageLimit(params) {
  const limit = params.get('limit') ?? '50';
  if (!/^\d{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 100) {
    badRequest('分页参数无效。每页最多 100 条。');
  }
  return Number(limit);
}

function caseCursor(params, customerOnly) {
  const cursor = params.get('cursor');
  if (cursor === null) return null;
  const match = /^([01]):([^:]+)$/.exec(cursor);
  if (!match || (customerOnly && match[1] !== '0')) badRequest('续页参数无效。');
  return {priority: Number(match[1]), id: uuid(match[2], '续页任务')};
}

function pathAndQuery(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || /[#\r\n\\]/.test(path)) {
    badRequest('请求路径无效。');
  }
  const index = path.indexOf('?');
  if (index === -1) return [path, new URLSearchParams()];
  return [path.slice(0, index), new URLSearchParams(path.slice(index + 1))];
}

function errorResponse(error) {
  if (error instanceof CarbonError) {
    return {status: error.status, body: {error: {code: error.code, message: error.message}}};
  }
  switch (error?.code) {
    case '42501':
      return {status: 403, body: {error: {code: 'ACCESS_DENIED', message: '你没有该组织的操作权限。'}}};
    case '23503':
    case '23505':
    case '23514':
    case '40001':
    case '40P01':
      return {status: 409, body: {error: {code: 'CASE_CONFLICT', message: '任务状态或版本已变化，请刷新后重试。'}}};
    default:
      return {status: 500, body: {error: {code: 'INTERNAL_ERROR', message: '暂时无法处理请求。'}}};
  }
}

// The caller must supply an authenticated server-side context. No request field
// or header may be promoted directly into that context.
export function createCarbonApi(database) {
  const intake = createIntakeService(database);
  return {
    async dispatch(request, context) {
      try {
        const scope = trustedScope(context);
        const [path, query] = pathAndQuery(request?.path);
        const method = request?.method;

        if (method === 'POST') {
          queryFields(query, []);
          if (path === '/v1/customer/cases') {
            const input = commandBody(request.body, ['orgId', 'scenarioReleaseId', 'purpose']);
            return {status: 201, body: await intake.create(scope, {
              orgId: uuid(input.orgId, '组织'),
              scenarioReleaseId: uuid(input.scenarioReleaseId, '场景版本'),
              purpose: requiredText(input.purpose, '办理用途')
            })};
          }
          const evidence = routes.evidence.exec(path);
          if (evidence?.[1] === 'customer') {
            const input = commandBody(request.body, ['orgId', 'title', 'sourceDescription']);
            return {status: 201, body: await intake.registerEvidence(scope,
              uuid(input.orgId, '组织'), uuid(evidence[2], '任务'), requiredText(input.title, '材料标题', 200),
              requiredText(input.sourceDescription, '材料来源说明', 1000))};
          }
          const submit = routes.submit.exec(path);
          if (submit) {
            const input = commandBody(request.body, ['orgId', 'revision']);
            return {status: 200, body: await intake.submit(scope,
              uuid(input.orgId, '组织'), uuid(submit[1], '任务'), revision(input.revision))};
          }
          const resubmit = routes.resubmit.exec(path);
          if (resubmit) {
            const input = commandBody(request.body, ['orgId', 'revision', 'correctionNote']);
            return {status: 200, body: await intake.resubmit(scope,
              uuid(input.orgId, '组织'), uuid(resubmit[1], '任务'), revision(input.revision),
              requiredText(input.correctionNote, '补正说明'))};
          }
          const review = routes.review.exec(path);
          if (review) {
            const input = commandBody(request.body, ['orgId', 'revision', 'decision'], ['reason']);
            if (input.decision !== 'approved' && input.decision !== 'returned') badRequest('请指定批准或退回。');
            if (input.decision === 'approved' && Object.hasOwn(input, 'reason')) badRequest('只有退回时需要填写原因。');
            const reason = input.decision === 'returned' ? requiredText(input.reason, '退回原因') : null;
            return {status: 200, body: await intake.review(scope,
              uuid(input.orgId, '组织'), uuid(review[1], '任务'), revision(input.revision), input.decision, reason)};
          }
        }

        if (method === 'GET') {
          const list = routes.cases.exec(path);
          if (list) {
            queryFields(query, ['orgId', 'limit', 'cursor']);
            const customerOnly = list[1] === 'customer';
            return {status: 200, body: await intake.listCases(scope,
              uuid(query.get('orgId'), '组织'), customerOnly, pageLimit(query), caseCursor(query, customerOnly))};
          }
          const detail = routes.case.exec(path);
          if (detail) {
            queryFields(query, ['orgId']);
            return {status: 200, body: await intake.read(scope,
              uuid(query.get('orgId'), '组织'), uuid(detail[2], '任务'), detail[1] === 'customer')};
          }
          const history = routes.history.exec(path);
          if (history) {
            queryFields(query, ['orgId']);
            return {status: 200, body: await intake.history(scope,
              uuid(query.get('orgId'), '组织'), uuid(history[2], '任务'), history[1] === 'customer')};
          }
          const evidence = routes.evidence.exec(path);
          if (evidence) {
            queryFields(query, ['orgId']);
            return {status: 200, body: await intake.listEvidence(scope,
              uuid(query.get('orgId'), '组织'), uuid(evidence[2], '任务'), evidence[1] === 'customer')};
          }
          const administration = routes.administration.exec(path);
          if (administration) {
            const orgId = uuid(administration[1], '组织');
            const [limit, offset] = paging(query);
            const read = administration[2] === 'grants' ? intake.listGrants : intake.listAudit;
            return {status: 200, body: await read(scope, orgId, limit, offset)};
          }
        }
        fail(404, 'ROUTE_NOT_FOUND', '未找到该操作。');
      } catch (error) {
        return errorResponse(error);
      }
    }
  };
}
