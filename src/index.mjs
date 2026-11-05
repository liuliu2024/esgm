import { CarbonError, createIntakeService } from './intake.mjs';

export const MAX_EVIDENCE_FILE_BYTES = 5 * 1024 * 1024;
const uuidPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const fileSignatures = new Map([
  ['application/pdf', Buffer.from('%PDF-', 'ascii')],
  ['image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])]
]);
const routes = {
  cases: /^\/v1\/(customer|professional)\/cases$/,
  case: /^\/v1\/(customer|professional)\/cases\/([^/]+)$/,
  history: /^\/v1\/(customer|professional)\/cases\/([^/]+)\/history$/,
  evidence: /^\/v1\/(customer|professional)\/cases\/([^/]+)\/evidence$/,
  revisionEvidence: /^\/v1\/(customer|professional)\/cases\/([^/]+)\/revisions\/([^/]+)\/evidence$/,
  evidenceFile: /^\/v1\/customer\/cases\/([^/]+)\/evidence\/([^/]+)\/file$/,
  activityPreview: /^\/v1\/customer\/cases\/([^/]+)\/imports\/preview$/,
  activityImports: /^\/v1\/customer\/cases\/([^/]+)\/imports$/,
  activityImport: /^\/v1\/customer\/cases\/([^/]+)\/imports\/([^/]+)$/,
  activityImportAction: /^\/v1\/customer\/cases\/([^/]+)\/imports\/([^/]+)\/(repreview|commit)$/,
  calculationPreview: /^\/v1\/customer\/cases\/([^/]+)\/calculation-preview$/,
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

function calculationMonths(query) {
  const from = query.get('from');
  const to = query.get('to');
  const monthPattern = /^(?!0000)\d{4}-(0[1-9]|1[0-2])$/;
  if (!monthPattern.test(from) || !monthPattern.test(to)) badRequest('请填写有效的起止月份 YYYY-MM。');
  const ordinal = month => Number(month.slice(0, 4)) * 12 + Number(month.slice(5));
  const span = ordinal(to) - ordinal(from) + 1;
  if (span < 1 || span > 12) badRequest('核算预览范围应为 1 至 12 个月。');
  return [from, to];
}

function submissionEvidenceIds(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) badRequest('材料标识必须以数组提供。');
  const ids = Array.from(value, id => uuid(id, '材料'));
  if (new Set(ids).size !== ids.length) badRequest('同一份材料只能引用一次。');
  return ids;
}

function requiredText(value, label, maximum = 500) {
  if (typeof value !== 'string' || !value.trim() || /\u0000/.test(value) || [...value.trim()].length > maximum) {
    badRequest(`请填写${label}，最多 ${maximum} 个字符。`);
  }
  return value.trim();
}

function evidenceFileInput(request) {
  const {body, contentType} = request;
  const mediaType = typeof contentType === 'string' ? contentType.trim().toLowerCase() : '';
  const signature = fileSignatures.get(mediaType);
  if (!signature || !(body instanceof Uint8Array) || body.byteLength === 0) {
    badRequest('请提供 PDF 或 PNG 文件。');
  }
  if (body.byteLength > MAX_EVIDENCE_FILE_BYTES) {
    fail(413, 'FILE_TOO_LARGE', '文件大小不能超过 5 MiB。');
  }
  const bytes = Buffer.from(body);
  if (!bytes.subarray(0, signature.length).equals(signature)) {
    badRequest('文件内容与声明的 PDF 或 PNG 类型不符。');
  }
  return {bytes, mediaType};
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
  if (error?.code === '23514' && error.constraint === 'submission_evidence_available') {
    return {status: 409, body: {error: {code: 'EVIDENCE_UNAVAILABLE', message: '所选材料无法用于本次提交，请检查材料后重试。'}}};
  }
  if (error?.code === '23514') {
    const importErrors = {
      activity_import_not_found: [404, 'IMPORT_NOT_FOUND', '未找到可访问的导入批次。'],
      activity_import_case_conflict: [409, 'CASE_CONFLICT', '任务当前不能确认导入。'],
      activity_import_stale_preview: [409, 'IMPORT_STALE_PREVIEW', '预览已变化，请刷新后查看。'],
      activity_import_stale_baseline: [409, 'IMPORT_STALE_BASELINE', '活动数据已变化，请重新预检后再确认。'],
      activity_import_blocked: [409, 'IMPORT_BLOCKED', '导入存在阻断问题，请修正后保存新批次。']
    };
    if (Object.hasOwn(importErrors, error.constraint)) {
      const [status, code, message] = importErrors[error.constraint];
      return {status, body: {error: {code, message}}};
    }
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
export function createCarbonApi(database, {quarantine} = {}) {
  const intake = createIntakeService(database, quarantine);
  return {
    async dispatch(request, context) {
      try {
        const scope = trustedScope(context);
        const [path, query] = pathAndQuery(request?.path);
        const method = request?.method;

        if (method === 'POST') {
          const evidenceFile = routes.evidenceFile.exec(path);
          if (evidenceFile) {
            queryFields(query, ['orgId']);
            const orgId = uuid(query.get('orgId'), '组织');
            const caseId = uuid(evidenceFile[1], '任务');
            const evidenceId = uuid(evidenceFile[2], '材料');
            const {bytes, mediaType} = evidenceFileInput(request);
            return {status: 201, body: await intake.receiveEvidenceFile(
              scope, orgId, caseId, evidenceId, mediaType, bytes)};
          }
          queryFields(query, []);
          const activityPreview = routes.activityPreview.exec(path);
          const activityImports = routes.activityImports.exec(path);
          if (activityPreview || activityImports) {
            const input = commandBody(request.body, ['orgId', 'csv']);
            if (typeof input.csv !== 'string') badRequest('请提供 CSV 文本。');
            if (Buffer.byteLength(input.csv, 'utf8') > 8192) {
              fail(413, 'IMPORT_TOO_LARGE', 'CSV 文本不能超过 8192 字节。');
            }
            if (activityImports && (input.csv.length === 0 || input.csv.includes('\u0000'))) {
              badRequest('请提供非空且不含空字符的 CSV 文本。');
            }
            const read = activityPreview ? intake.previewActivity : intake.saveActivityImport;
            return {status: 200, body: await read(scope,
              uuid(input.orgId, '组织'), uuid((activityPreview ?? activityImports)[1], '任务'), input.csv)};
          }
          const activityImportAction = routes.activityImportAction.exec(path);
          if (activityImportAction) {
            const input = commandBody(request.body, ['orgId', 'previewRevision']);
            const [, caseId, batchId, action] = activityImportAction;
            const run = action === 'commit' ? intake.commitActivityImport : intake.repreviewActivityImport;
            return {status: 200, body: await run(scope,
              uuid(input.orgId, '组织'), uuid(caseId, '任务'), uuid(batchId, '批次'), revision(input.previewRevision))};
          }
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
            const input = commandBody(request.body, ['orgId', 'revision'], ['evidenceIds']);
            return {status: 200, body: await intake.submit(scope,
              uuid(input.orgId, '组织'), uuid(submit[1], '任务'), revision(input.revision), submissionEvidenceIds(input.evidenceIds))};
          }
          const resubmit = routes.resubmit.exec(path);
          if (resubmit) {
            const input = commandBody(request.body, ['orgId', 'revision', 'correctionNote'], ['evidenceIds']);
            return {status: 200, body: await intake.resubmit(scope,
              uuid(input.orgId, '组织'), uuid(resubmit[1], '任务'), revision(input.revision),
              requiredText(input.correctionNote, '补正说明'), submissionEvidenceIds(input.evidenceIds))};
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
          const calculationPreview = routes.calculationPreview.exec(path);
          if (calculationPreview) {
            queryFields(query, ['orgId', 'from', 'to']);
            return {status: 200, body: await intake.previewCalculation(scope,
              uuid(query.get('orgId'), '组织'), uuid(calculationPreview[1], '任务'), ...calculationMonths(query))};
          }
          const activityImport = routes.activityImport.exec(path);
          if (activityImport) {
            queryFields(query, ['orgId']);
            return {status: 200, body: await intake.readActivityImport(scope,
              uuid(query.get('orgId'), '组织'), uuid(activityImport[1], '任务'), uuid(activityImport[2], '批次'))};
          }
          if (path === '/v1/customer/scenarios') {
            queryFields(query, ['orgId']);
            return {status: 200, body: await intake.listScenarios(scope, uuid(query.get('orgId'), '组织'))};
          }
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
          const revisionEvidence = routes.revisionEvidence.exec(path);
          if (revisionEvidence) {
            queryFields(query, ['orgId']);
            const [, role, caseId, revisionParam] = revisionEvidence;
            if (!/^\d+$/.test(revisionParam)) badRequest('任务版本必须为正整数。');
            return {status: 200, body: await intake.listRevisionEvidence(scope,
              uuid(query.get('orgId'), '组织'), uuid(caseId, '任务'), revision(Number(revisionParam)), role === 'customer')};
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
