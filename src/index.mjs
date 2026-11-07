import { CarbonError, createIntakeService } from './intake.mjs';

export const MAX_EVIDENCE_FILE_BYTES = 5 * 1024 * 1024;
const uuidPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const monthPattern = /^(?!0000)\d{4}-(0[1-9]|1[0-2])$/;
const fileSignatures = new Map([
  ['application/pdf', Buffer.from('%PDF-', 'ascii')],
  ['image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])]
]);
const routes = {
  scenarioReferences: /^\/v1\/customer\/scenarios\/([^/]+)\/references$/,
  ruleAssessment: /^\/v1\/(customer|professional)\/cases\/([^/]+)\/rule-assessment$/,
  recordRuleAssessment: /^\/v1\/professional\/cases\/([^/]+)\/revisions\/([^/]+)\/rule-assessment$/,
  ruleImpact: /^\/v1\/admin\/organizations\/([^/]+)\/rule-impact$/,
  ruleCatalog: /^\/v1\/admin\/organizations\/([^/]+)\/rule-catalog$/,
  adminRuleProposals: /^\/v1\/admin\/organizations\/([^/]+)\/rule-proposals$/,
  reviewRuleProposal: /^\/v1\/professional\/rule-proposals\/([^/]+)\/review$/,
  ruleRecalculation: /^\/v1\/customer\/cases\/([^/]+)\/rule-recalculation$/,
  gasCombustion: /^\/v1\/(customer|professional)\/cases\/([^/]+)\/revisions\/([^/]+)\/gas-combustion$/,
  productElectricity: /^\/v1\/(customer|professional)\/cases\/([^/]+)\/revisions\/([^/]+)\/product-electricity$/,
  productElectricityComparison: /^\/v1\/(customer|professional)\/cases\/([^/]+)\/product-electricity\/comparison$/,
  modelTemplateImpact: /^\/v1\/professional\/model-templates\/([a-z0-9-]+)\/versions\/([^/]+)\/impact$/,
  gasCombustionSnapshots: /^\/v1\/(customer|professional)\/cases\/([^/]+)\/revisions\/([^/]+)\/gas-combustion\/snapshots$/,
  gasCombustionSnapshot: /^\/v1\/(customer|professional)\/cases\/([^/]+)\/revisions\/([^/]+)\/gas-combustion\/snapshots\/([^/]+)$/,
  gasCombustionComparison: /^\/v1\/(customer|professional)\/cases\/([^/]+)\/gas-combustion\/comparison$/,
  gasRestatements: /^\/v1\/(customer|professional)\/cases\/([^/]+)\/gas-combustion\/restatements$/,
  gasRestatementReview: /^\/v1\/professional\/cases\/([^/]+)\/gas-combustion\/restatements\/([^/]+)\/review$/,
  gasCombustionReportDraft: /^\/v1\/customer\/cases\/([^/]+)\/revisions\/([^/]+)\/gas-combustion\/snapshots\/([^/]+)\/internal-report-draft$/,
  enqueueGasCalculationJob: /^\/v1\/customer\/cases\/([^/]+)\/revisions\/([^/]+)\/gas-combustion\/jobs$/,
  gasCalculationJobs: /^\/v1\/customer\/cases\/([^/]+)\/gas-combustion\/jobs(?:\/([^/]+))?$/,
  gasCalculationJobAction: /^\/v1\/customer\/cases\/([^/]+)\/gas-combustion\/jobs\/([^/]+)\/(cancel|retry)$/,
  cases: /^\/v1\/(customer|professional)\/cases$/,
  case: /^\/v1\/(customer|professional)\/cases\/([^/]+)$/,
  history: /^\/v1\/(customer|professional)\/cases\/([^/]+)\/history$/,
  reviewIssues: /^\/v1\/(customer|professional)\/cases\/([^/]+)\/review-issues$/,
  reviewSummary: /^\/v1\/professional\/cases\/([^/]+)\/revisions\/([^/]+)\/review-summary$/,
  reportReleaseReadiness: /^\/v1\/professional\/cases\/([^/]+)\/internal-report-drafts\/([^/]+)\/release-readiness$/,
  reopenImpact: /^\/v1\/(customer|professional)\/cases\/([^/]+)\/reopen-impact$/,
  reopenRequests: /^\/v1\/(customer|professional)\/cases\/([^/]+)\/reopen-requests$/,
  reviewReopenRequest: /^\/v1\/professional\/cases\/([^/]+)\/reopen-requests\/([^/]+)\/review$/,
  createReopenedDraft: /^\/v1\/customer\/cases\/([^/]+)\/reopen-requests\/([^/]+)\/draft$/,
  reviewIssueAction: /^\/v1\/(customer|professional)\/cases\/([^/]+)\/review-issues\/([^/]+)\/(reply|request-follow-up|close)$/,
  evidence: /^\/v1\/(customer|professional)\/cases\/([^/]+)\/evidence$/,
  revisionEvidence: /^\/v1\/(customer|professional)\/cases\/([^/]+)\/revisions\/([^/]+)\/evidence$/,
  revisionActivities: /^\/v1\/(customer|professional)\/cases\/([^/]+)\/revisions\/([^/]+)\/activities$/,
  submissionCalculation: /^\/v1\/professional\/cases\/([^/]+)\/revisions\/([^/]+)\/calculation-preview$/,
  controlledReportDrafts: /^\/v1\/customer\/cases\/([^/]+)\/revisions\/([^/]+)\/internal-report-drafts$/,
  factorDecision: /^\/v1\/(customer|professional)\/cases\/([^/]+)\/revisions\/([^/]+)\/factor-decision$/,
  evidenceFile: /^\/v1\/customer\/cases\/([^/]+)\/evidence\/([^/]+)\/file$/,
  activityPreview: /^\/v1\/customer\/cases\/([^/]+)\/imports\/preview$/,
  activityImports: /^\/v1\/customer\/cases\/([^/]+)\/imports$/,
  activityImport: /^\/v1\/customer\/cases\/([^/]+)\/imports\/([^/]+)$/,
  activityImportAction: /^\/v1\/customer\/cases\/([^/]+)\/imports\/([^/]+)\/(repreview|commit)$/,
  activities: /^\/v1\/customer\/cases\/([^/]+)\/activities$/,
  calculationPreview: /^\/v1\/customer\/cases\/([^/]+)\/calculation-preview$/,
  calculationSnapshots: /^\/v1\/customer\/cases\/([^/]+)\/calculation-snapshots$/,
  calculationSnapshot: /^\/v1\/customer\/cases\/([^/]+)\/calculation-snapshots\/([^/]+)$/,
  internalReportDrafts: /^\/v1\/(customer|professional)\/cases\/([^/]+)\/internal-report-drafts$/,
  internalReportDraft: /^\/v1\/customer\/cases\/([^/]+)\/internal-report-drafts\/([^/]+)$/,
  submitInternalReportReview: /^\/v1\/customer\/cases\/([^/]+)\/internal-report-drafts\/([^/]+)\/submit-review$/,
  internalReportReview: /^\/v1\/(customer|professional)\/cases\/([^/]+)\/internal-report-drafts\/([^/]+)\/review$/,
  reportDeliveries: /^\/v1\/customer\/cases\/([^/]+)\/internal-report-drafts\/([^/]+)\/deliveries$/,
  reportDelivery: /^\/v1\/customer\/cases\/([^/]+)\/internal-report-drafts\/([^/]+)\/deliveries\/([^/]+)$/,
  reportDeliveryPdf: /^\/v1\/customer\/cases\/([^/]+)\/internal-report-drafts\/([^/]+)\/deliveries\/([^/]+)\/pdf$/,
  recordReportDelivery: /^\/v1\/customer\/cases\/([^/]+)\/internal-report-drafts\/([^/]+)\/deliveries\/([^/]+)\/record$/,
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

function revisionParam(value) {
  if (!/^\d+$/.test(value)) badRequest('任务版本必须为正整数。');
  return revision(Number(value));
}

function combustionMonth(value) {
  if (typeof value !== 'string' || !monthPattern.test(value) || !value.startsWith('2026-')) {
    badRequest('请选择 2026 年的有效月份。');
  }
  return value;
}

function combustionDecimal(value, label, integerDigits, fractionDigits, minimumExclusive = false) {
  const decimal = new RegExp(`^(?:0|[1-9]\\d{0,${integerDigits - 1}})(?:\\.\\d{1,${fractionDigits}})?$`);
  if (typeof value !== 'string' || !decimal.test(value) || (minimumExclusive && Number(value) === 0)) {
    badRequest(`请填写有效的${label}。`);
  }
  return value;
}

function proposedRuleReferences(input) {
  if (!Array.isArray(input) || input.length > 20) badRequest('候选依据须为不超过 20 项的列表。');
  const seen = new Set();
  return input.map(entry => {
    const fields = ['code', 'title', 'publisher', 'sourceUrl', 'scopeNote', 'publicationStatus'];
    const {code, title, publisher, sourceUrl, scopeNote, publicationStatus} = commandBody(entry, fields);
    if (typeof code !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(code) || code.length > 120 || seen.has(code)) {
      badRequest('候选依据编码无效或重复。');
    }
    const url = typeof sourceUrl === 'string' && sourceUrl.length <= 1000 ? URL.parse(sourceUrl) : null;
    if (url?.protocol !== 'https:' || url.username || url.password) badRequest('候选依据须提供有效的 HTTPS 原文。');
    if (!['effective', 'pilot', 'draft', 'superseded', 'expired', 'unclassified'].includes(publicationStatus)) {
      badRequest('请选择有效的依据发布状态。');
    }
    seen.add(code);
    return {code, title: requiredText(title, '依据名称', 200), publisher: requiredText(publisher, '发布机构', 200),
      sourceUrl: url.href, scopeNote: requiredText(scopeNote, '适用说明'), publicationStatus};
  });
}

function calculationMonths(from, to) {
  if (typeof from !== 'string' || typeof to !== 'string' || !monthPattern.test(from) || !monthPattern.test(to)) {
    badRequest('请填写有效的起止月份 YYYY-MM。');
  }
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

function factorScope(accountingBasis, dataYear) {
  if (accountingBasis !== 'product_footprint' && accountingBasis !== 'organization_electricity_co2') {
    badRequest('请选择支持的核算口径。');
  }
  if (!Number.isInteger(dataYear) || dataYear < 1 || dataYear > 9999) badRequest('数据年份必须为四位年份。');
  return {accountingBasis, dataYear};
}

function factorFilters(accountingBasis, regionCode, dataYear) {
  const scope = factorScope(accountingBasis, dataYear);
  if (typeof regionCode !== 'string' || !/^[A-Z]{2}(?:-[A-Z0-9]{1,3})?$/.test(regionCode)) {
    badRequest('请提供有效的地区编码。');
  }
  return {...scope, regionCode};
}

function intakeScope(value) {
  if (value === undefined) return null;
  const {subjectType, subjectName, jurisdiction, reportingYear, recipient} = commandBody(value,
    ['subjectType', 'subjectName', 'jurisdiction', 'reportingYear', 'recipient']);
  if (!['organization', 'facility', 'product', 'project'].includes(subjectType)) {
    badRequest('请选择组织、设施、产品或项目作为报告对象。');
  }
  if (typeof reportingYear !== 'string' || !/^(?!0000)\d{4}$/.test(reportingYear)) {
    badRequest('报告年度必须为四位年份。');
  }
  return {
    subjectType, subjectName: requiredText(subjectName, '报告对象名称', 120),
    jurisdiction: requiredText(jurisdiction, '地区', 80), reportingYear,
    recipient: requiredText(recipient, '交付对象', 120)
  };
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
  if (error?.code === '23514' && (error.constraint === 'internal_report_review_case_state'
    || error.constraint === 'internal_report_review_transition' || error.constraint === 'internal_report_review_source_revision')) {
    return {status: 409, body: {error: {code: 'REPORT_REVIEW_CONFLICT', message: '任务或报告当前不能完成该复核操作，请核对任务状态和提交版本。'}}};
  }
  if (error?.code === '23514' && error.constraint === 'internal_report_delivery_source_conflict') {
    return {status: 409, body: {error: {code: 'REPORT_DELIVERY_SOURCE_CONFLICT', message: '交付需要当前有效提交的完整外购电力管理稿，并已通过独立复核。'}}};
  }
  if (error?.code === '23514' && error.constraint === 'report_delivery_factor_disclosure') {
    return {status: 409, body: {error: {code: 'REPORT_DELIVERY_FACTOR_DISCLOSURE', message: '当前因子版本的披露范围不允许生成或交付此文件。'}}};
  }
  if (error?.constraint === 'review_issue_evidence_reference') {
    return {status: 409, body: {error: {code: 'REVIEW_ISSUE_EVIDENCE_UNAVAILABLE', message: '请引用该提交版本已经固定的材料。'}}};
  }
  if (['case_reopen_request_source', 'case_reopen_request_transition', 'case_intake_reopen_source',
    'case_reopen_request_active_case', 'case_intake_reopen_request_key'].includes(error?.constraint)) {
    return {status: 409, body: {error: {code: 'CASE_REOPEN_CONFLICT', message: '重开申请或批准版本已变化，请刷新后处理。'}}};
  }
  if ((error?.code === '23514' && error.constraint === 'case_factor_decision_submission_state')
    || (error?.code === '23505' && error.constraint === 'case_factor_decision_pkey')) {
    return {status: 409, body: {error: {code: 'FACTOR_DECISION_CONFLICT', message: '仅当前待复核提交可记录一次因子选择。'}}};
  }
  if ((error?.code === '23514' && error.constraint === 'case_rule_decision_submission_state')
    || (error?.code === '23505' && error.constraint === 'case_rule_decision_pkey')) {
    return {status: 409, body: {error: {code: 'RULE_ASSESSMENT_CONFLICT', message: '仅当前待复核提交可记录一次规则判断。'}}};
  }
  if (error?.code === '23514' && error.constraint === 'case_rule_decision_reference') {
    return {status: 409, body: {error: {code: 'RULE_REFERENCE_UNAVAILABLE', message: '请先核对申报范围及可确认的候选依据。'}}};
  }
  if (error?.code === '23514' && error.constraint === 'scenario_rule_proposal_transition') {
    return {status: 409, body: {error: {code: 'RULE_PROPOSAL_CONFLICT', message: '该规则草案已变更，请刷新后重试。'}}};
  }
  if (error?.code === '23514' && error.constraint === 'case_intake_rule_recalculation_source') {
    return {status: 409, body: {error: {code: 'RULE_RECALCULATION_CONFLICT', message: '原任务或新版场景已变化，请刷新后重试。'}}};
  }
  if (error?.constraint === 'case_intake_scenario_scope' || error?.constraint === 'scenario_rule_proposal_base_scope') {
    return {status: 404, body: {error: {code: 'SCENARIO_NOT_FOUND', message: '未找到可访问的场景版本。'}}};
  }
  if (error?.constraint === 'gas_combustion_input_state' || error?.constraint === 'gas_combustion_input_pkey') {
    return {status: 409, body: {error: {code: 'GAS_COMBUSTION_CONFLICT', message: '仅当前待复核提交可按月份记录一次燃烧数据。'}}};
  }
  if (['product_electricity_profile_pkey', 'product_electricity_profile_state'].includes(error?.constraint)) {
    return {status: 409, body: {error: {code: 'PRODUCT_PROFILE_CONFLICT', message: '该提交版本已有试算口径。变更口径请使用补正后的提交。'}}};
  }
  if (error?.constraint === 'product_electricity_profile_allocation') {
    return {status: 400, body: {error: {code: 'PRODUCT_ALLOCATION_INVALID', message: '目标产品质量不能大于同期总产出质量。'}}};
  }
  if (error?.constraint === 'model_trial_snapshot_submission_state') {
    return {status: 409, body: {error: {code: 'GAS_COMBUSTION_CONFLICT', message: '请选择当前有效提交冻结结果。'}}};
  }
  if (error?.constraint === 'model_trial_snapshot_incomplete') {
    return {status: 409, body: {error: {code: 'CALCULATION_INCOMPLETE', message: '所选月份仍缺少燃烧输入。'}}};
  }
  if (error?.constraint === 'gas_calculation_job_submission_state') {
    return {status: 409, body: {error: {code: 'GAS_CALCULATION_JOB_STALE', message: '请选择当前有效的提交版本发起计算。'}}};
  }
  if (error?.constraint === 'gas_calculation_job_transition') {
    return {status: 409, body: {error: {code: 'GAS_CALCULATION_JOB_CONFLICT', message: '作业状态已变化，请刷新后重试。'}}};
  }
  if (error?.constraint === 'gas_report_restatement_required') {
    return {status: 409, body: {error: {code: 'GAS_RESTATEMENT_REQUIRED', message: '同范围已有旧版报告。请先提交并完成重述审批，再生成新版。'}}};
  }
  if (error?.constraint === 'gas_report_restatement_source') {
    return {status: 409, body: {error: {code: 'GAS_RESTATEMENT_SOURCE_CONFLICT', message: '请刷新重述清单，重新核对当前快照和上一版报告。'}}};
  }
  if (['gas_report_restatement_transition', 'gas_report_restatement_active_target'].includes(error?.constraint)) {
    return {status: 409, body: {error: {code: 'GAS_RESTATEMENT_CONFLICT', message: '该重述已有有效申请或已处理，请刷新后查看。'}}};
  }
  if (['gas_combustion_input_scope', 'gas_combustion_activity_evidence', 'gas_combustion_parameter_evidence'].includes(error?.constraint)) {
    return {status: 409, body: {error: {code: 'GAS_COMBUSTION_INPUT_UNAVAILABLE', message: '请核对规则判断及该提交版本的凭证。'}}};
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
export function createCarbonApi(database, {quarantine, renderDeliveryPdf} = {}) {
  const intake = createIntakeService(database, quarantine);
  return {
    async dispatch(request, context) {
      try {
        const scope = trustedScope(context);
        const [path, query] = pathAndQuery(request?.path);
        const method = request?.method;

        if (method === 'POST') {
          const reopen = routes.reopenRequests.exec(path);
          if (reopen?.[1] === 'customer') {
            const input = commandBody(request.body, ['orgId', 'approvedRevision', 'reason']);
            return {status: 201, body: await intake.requestCaseReopen(scope, uuid(input.orgId, '组织'),
              uuid(reopen[2], '任务'), revision(input.approvedRevision), requiredText(input.reason, '重开原因'))};
          }
          const reopenReview = routes.reviewReopenRequest.exec(path);
          if (reopenReview) {
            const input = commandBody(request.body, ['orgId', 'decision'], ['reason']);
            if (!['approved', 'returned'].includes(input.decision)) badRequest('请选择批准或退回重开。');
            const reason = input.decision === 'returned' || Object.hasOwn(input, 'reason')
              ? requiredText(input.reason, '审批说明') : null;
            return {status: 200, body: await intake.reviewCaseReopen(scope, uuid(input.orgId, '组织'),
              uuid(reopenReview[1], '任务'), uuid(reopenReview[2], '重开申请'), input.decision, reason)};
          }
          const reopenDraft = routes.createReopenedDraft.exec(path);
          if (reopenDraft) {
            const input = commandBody(request.body, ['orgId']);
            return await intake.createReopenedDraft(scope, uuid(input.orgId, '组织'),
              uuid(reopenDraft[1], '任务'), uuid(reopenDraft[2], '重开申请'));
          }
          const issues = routes.reviewIssues.exec(path);
          if (issues?.[1] === 'professional') {
            const input = commandBody(request.body,
              ['orgId', 'submissionRevision', 'title', 'description', 'severity', 'dueDate'], ['evidenceId']);
            if (!['low', 'normal', 'critical'].includes(input.severity)) badRequest('请选择问题的严重性。');
            const due = typeof input.dueDate === 'string' && /^(?!0000)\d{4}-\d{2}-\d{2}$/.test(input.dueDate)
              ? new Date(`${input.dueDate}T00:00:00Z`) : null;
            if (!due || !Number.isFinite(due.getTime()) || due.toISOString().slice(0, 10) !== input.dueDate) {
              badRequest('请填写有效的到期日。');
            }
            return {status: 201, body: await intake.openReviewIssue(scope, uuid(input.orgId, '组织'),
              uuid(issues[2], '任务'), {submissionRevision: revision(input.submissionRevision),
                title: requiredText(input.title, '标题', 200), description: requiredText(input.description, '问题说明', 1000),
                severity: input.severity, dueDate: input.dueDate,
                evidenceId: Object.hasOwn(input, 'evidenceId') ? uuid(input.evidenceId, '材料') : null})};
          }
          const issueAction = routes.reviewIssueAction.exec(path);
          if (issueAction && (issueAction[1] === 'customer') === (issueAction[4] === 'reply')) {
            const input = commandBody(request.body, ['orgId', 'expectedVersion', 'note']);
            return {status: 200, body: await intake.changeReviewIssue(scope, uuid(input.orgId, '组织'),
              uuid(issueAction[2], '任务'), uuid(issueAction[3], '问题'), issueAction[4],
              revision(input.expectedVersion), requiredText(input.note, '处理说明', 1000))};
          }
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
          const ruleImpact = routes.ruleImpact.exec(path);
          if (ruleImpact) {
            const input = commandBody(request.body, ['scenarioReleaseId', 'references']);
            return {status: 200, body: await intake.previewRuleImpact(scope, uuid(ruleImpact[1], '组织'),
              uuid(input.scenarioReleaseId, '场景版本'), proposedRuleReferences(input.references))};
          }
          const adminRuleProposals = routes.adminRuleProposals.exec(path);
          if (adminRuleProposals) {
            const input = commandBody(request.body, ['scenarioReleaseId', 'references']);
            return {status: 201, body: await intake.submitRuleProposal(scope, uuid(adminRuleProposals[1], '组织'),
              uuid(input.scenarioReleaseId, '场景版本'), proposedRuleReferences(input.references))};
          }
          const reviewRuleProposal = routes.reviewRuleProposal.exec(path);
          if (reviewRuleProposal) {
            const input = commandBody(request.body, ['orgId', 'decision', 'reason']);
            if (!['approved', 'returned'].includes(input.decision)) badRequest('请选择通过或退回规则草案。');
            return {status: 200, body: await intake.reviewRuleProposal(scope, uuid(input.orgId, '组织'),
              uuid(reviewRuleProposal[1], '规则草案'), input.decision, requiredText(input.reason, '审批意见'))};
          }
          const ruleRecalculation = routes.ruleRecalculation.exec(path);
          if (ruleRecalculation) {
            const input = commandBody(request.body, ['orgId', 'scenarioReleaseId']);
            return await intake.createRuleRecalculation(scope, uuid(input.orgId, '组织'),
              uuid(ruleRecalculation[1], '原任务'), uuid(input.scenarioReleaseId, '新版场景'));
          }
          const productElectricity = routes.productElectricity.exec(path);
          if (productElectricity?.[1] === 'professional') {
            const input = commandBody(request.body, ['orgId', 'from', 'to', 'boundaryNote', 'functionalUnit',
              'outputQuantity', 'allocationMethod', 'allocationBasis'], ['productMassKg', 'batchMassKg']);
            const [from, to] = calculationMonths(input.from, input.to);
            if (!['exclusive', 'mass'].includes(input.allocationMethod)) badRequest('请选择电力归属方式。');
            const byMass = input.allocationMethod === 'mass';
            if (!byMass && (Object.hasOwn(input, 'productMassKg') || Object.hasOwn(input, 'batchMassKg'))) {
              badRequest('独占用电无需填报分配质量。');
            }
            const productMassKg = byMass ? combustionDecimal(input.productMassKg, '目标产品质量', 12, 6, true) : null;
            const batchMassKg = byMass ? combustionDecimal(input.batchMassKg, '同期总产出质量', 12, 6, true) : null;
            return {status: 201, body: await intake.recordProductElectricity(scope, uuid(input.orgId, '组织'),
              uuid(productElectricity[2], '任务'), revisionParam(productElectricity[3]), {
                from, to, boundaryNote: requiredText(input.boundaryNote, '电力边界'),
                functionalUnit: requiredText(input.functionalUnit, '功能单位', 160),
                outputQuantity: combustionDecimal(input.outputQuantity, '功能单位产出数', 12, 6, true),
                allocationMethod: input.allocationMethod, productMassKg, batchMassKg,
                allocationBasis: requiredText(input.allocationBasis, '归属或分配依据')
              })};
          }
          const gasCombustion = routes.gasCombustion.exec(path);
          if (gasCombustion?.[1] === 'professional') {
            const input = commandBody(request.body, ['orgId', 'period', 'standardVolumeNm3',
              'oxidationFraction', 'activityEvidenceId', 'parameterEvidenceId', 'parameterBasis'],
              ['methodBranch', 'ncvGjPer10kNm3', 'carbonTcPerGj', 'elementalCarbonTcPer10kNm3']);
            const methodBranch = Object.hasOwn(input, 'methodBranch') ? input.methodBranch : 'ncv_carbon';
            if (!['ncv_carbon', 'measured_carbon'].includes(methodBranch)) badRequest('请选择支持的元素碳计算分支。');
            const measured = methodBranch === 'measured_carbon';
            if (measured ? Object.hasOwn(input, 'ncvGjPer10kNm3') || Object.hasOwn(input, 'carbonTcPerGj')
              : Object.hasOwn(input, 'elementalCarbonTcPer10kNm3')) {
              badRequest('两种元素碳计算分支的参数须分别录入。');
            }
            const oxidationFraction = combustionDecimal(input.oxidationFraction, '碳氧化率', 2, 10, true);
            if (Number(oxidationFraction) > 1) badRequest('碳氧化率以大于 0 且不超过 1 的比例录入。');
            return {status: 201, body: await intake.recordGasCombustion(scope, uuid(input.orgId, '组织'),
              uuid(gasCombustion[2], '任务'), revisionParam(gasCombustion[3]), {
                period: combustionMonth(input.period),
                standardVolumeNm3: combustionDecimal(input.standardVolumeNm3, '标准体积', 14, 8),
                methodBranch, ncvGjPer10kNm3: measured ? null : combustionDecimal(input.ncvGjPer10kNm3, '低位发热量', 14, 8, true),
                carbonTcPerGj: measured ? null : combustionDecimal(input.carbonTcPerGj, '单位热值含碳量', 10, 12, true),
                elementalCarbonTcPer10kNm3: measured
                  ? combustionDecimal(input.elementalCarbonTcPer10kNm3, '实测元素碳含量', 10, 12, true) : null,
                oxidationFraction, activityEvidenceId: uuid(input.activityEvidenceId, '活动凭证'),
                parameterEvidenceId: uuid(input.parameterEvidenceId, '参数凭证'),
                parameterBasis: requiredText(input.parameterBasis, '参数与体积参比依据')
              })};
          }
          const gasCombustionSnapshots = routes.gasCombustionSnapshots.exec(path);
          if (gasCombustionSnapshots?.[1] === 'customer') {
            const input = commandBody(request.body, ['orgId', 'from', 'to']);
            const [from, to] = calculationMonths(combustionMonth(input.from), combustionMonth(input.to));
            return await intake.saveGasCombustionSnapshot(scope, uuid(input.orgId, '组织'),
              uuid(gasCombustionSnapshots[2], '任务'), revisionParam(gasCombustionSnapshots[3]), from, to);
          }
          const gasRestatements = routes.gasRestatements.exec(path);
          if (gasRestatements?.[1] === 'customer') {
            const input = commandBody(request.body, ['orgId', 'baselineSnapshotId', 'targetSnapshotId', 'reason']);
            return {status: 201, body: await intake.requestGasRestatement(scope, uuid(input.orgId, '组织'),
              uuid(gasRestatements[2], '任务'), uuid(input.baselineSnapshotId, '旧版快照'),
              uuid(input.targetSnapshotId, '新版快照'), requiredText(input.reason, '重述原因'))};
          }
          const gasRestatementReview = routes.gasRestatementReview.exec(path);
          if (gasRestatementReview) {
            const input = commandBody(request.body, ['orgId', 'decision'], ['reason']);
            if (!['approved', 'returned'].includes(input.decision)) badRequest('请选择批准或退回重述。');
            const reason = input.decision === 'returned' || Object.hasOwn(input, 'reason')
              ? requiredText(input.reason, '审批意见') : null;
            return {status: 200, body: await intake.reviewGasRestatement(scope, uuid(input.orgId, '组织'),
              uuid(gasRestatementReview[1], '任务'), uuid(gasRestatementReview[2], '重述申请'), input.decision, reason)};
          }
          const gasCombustionReportDraft = routes.gasCombustionReportDraft.exec(path);
          if (gasCombustionReportDraft) {
            const input = commandBody(request.body, ['orgId']);
            return await intake.createGasCombustionReportDraft(scope, uuid(input.orgId, '组织'),
              uuid(gasCombustionReportDraft[1], '任务'), revisionParam(gasCombustionReportDraft[2]),
              uuid(gasCombustionReportDraft[3], '试算快照'));
          }
          const enqueueGasCalculationJob = routes.enqueueGasCalculationJob.exec(path);
          if (enqueueGasCalculationJob) {
            const input = commandBody(request.body, ['orgId', 'from', 'to']);
            const [from, to] = calculationMonths(combustionMonth(input.from), combustionMonth(input.to));
            return await intake.enqueueGasCalculationJob(scope, uuid(input.orgId, '组织'),
              uuid(enqueueGasCalculationJob[1], '任务'), revisionParam(enqueueGasCalculationJob[2]), from, to);
          }
          const gasCalculationJobAction = routes.gasCalculationJobAction.exec(path);
          if (gasCalculationJobAction) {
            const input = commandBody(request.body, ['orgId']);
            return {status: 200, body: await intake.changeGasCalculationJob(scope, uuid(input.orgId, '组织'),
              uuid(gasCalculationJobAction[1], '任务'), uuid(gasCalculationJobAction[2], '计算作业'), gasCalculationJobAction[3])};
          }
          const recordRuleAssessment = routes.recordRuleAssessment.exec(path);
          if (recordRuleAssessment) {
            const input = commandBody(request.body, ['orgId', 'status', 'rationale'], ['referenceCode']);
            const {status, referenceCode} = input;
            if (status !== 'confirmed' && status !== 'needs_review') badRequest('请选择确认适用或待核实。');
            if (status === 'confirmed'
              ? typeof referenceCode !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(referenceCode)
              : Object.hasOwn(input, 'referenceCode')) badRequest('请为确认适用的判断提供有效候选依据。');
            return {status: 201, body: await intake.recordRuleAssessment(scope, uuid(input.orgId, '组织'),
              uuid(recordRuleAssessment[1], '任务'), revisionParam(recordRuleAssessment[2]),
              {status, referenceCode: referenceCode ?? null, rationale: requiredText(input.rationale, '判断依据')})};
          }
          const factorDecision = routes.factorDecision.exec(path);
          if (factorDecision?.[1] === 'professional') {
            const input = commandBody(request.body, ['orgId', 'factorId', 'factorVersion', 'accountingBasis', 'regionCode',
              'dataYear', 'methodReference', 'rationale']);
            const [, , caseId, version] = factorDecision;
            if (typeof input.factorId !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.factorId)) {
              badRequest('请提供有效的因子标识。');
            }
            return {status: 201, body: await intake.recordFactorDecision(scope,
              uuid(input.orgId, '组织'), uuid(caseId, '任务'), revisionParam(version), {
                factorId: input.factorId, factorVersion: revision(input.factorVersion),
                ...factorFilters(input.accountingBasis, input.regionCode, input.dataYear),
                methodReference: requiredText(input.methodReference, '适用方法或规则版本'),
                rationale: requiredText(input.rationale, '适用依据')
              })};
          }
          const submitReportReview = routes.submitInternalReportReview.exec(path);
          if (submitReportReview) {
            const input = commandBody(request.body, ['orgId']);
            return await intake.submitInternalReportReview(scope,
              uuid(input.orgId, '组织'), uuid(submitReportReview[1], '任务'), uuid(submitReportReview[2], '稿件'));
          }
          const reportReview = routes.internalReportReview.exec(path);
          if (reportReview?.[1] === 'professional') {
            const input = commandBody(request.body, ['orgId', 'decision'], ['reason']);
            if (input.decision !== 'reviewed' && input.decision !== 'returned') badRequest('请选择完成复核或退回。');
            const reason = input.decision === 'returned' || Object.hasOwn(input, 'reason')
              ? requiredText(input.reason, '复核意见') : null;
            return {status: 200, body: await intake.decideInternalReportReview(scope,
              uuid(input.orgId, '组织'), uuid(reportReview[2], '任务'), uuid(reportReview[3], '稿件'), input.decision, reason)};
          }
          const recordReportDelivery = routes.recordReportDelivery.exec(path);
          if (recordReportDelivery) {
            const input = commandBody(request.body, ['orgId', 'deliveryReference']);
            const [, caseId, draftId, deliveryId] = recordReportDelivery;
            return {status: 200, body: await intake.recordReportDelivery(scope, uuid(input.orgId, '组织'),
              uuid(caseId, '任务'), uuid(draftId, '稿件'), uuid(deliveryId, '交付件'),
              requiredText(input.deliveryReference, '交付凭证', 300))};
          }
          const reportDeliveries = routes.reportDeliveries.exec(path);
          if (reportDeliveries) {
            const input = commandBody(request.body, ['orgId', 'recipient', 'purpose', 'includeMonthly', 'includeFactor']);
            if (typeof input.includeMonthly !== 'boolean' || typeof input.includeFactor !== 'boolean') {
              badRequest('请选择是否包含月度汇总和公开因子来源。');
            }
            const [, caseId, draftId] = reportDeliveries;
            return await intake.createReportDelivery(scope, uuid(input.orgId, '组织'), uuid(caseId, '任务'), uuid(draftId, '稿件'), {
              recipient: requiredText(input.recipient, '收件方', 120), purpose: requiredText(input.purpose, '交付用途', 300),
              includeMonthly: input.includeMonthly, includeFactor: input.includeFactor
            });
          }
          const internalReportDrafts = routes.internalReportDrafts.exec(path);
          if (internalReportDrafts?.[1] === 'customer') {
            const input = commandBody(request.body, ['orgId', 'snapshotId']);
            return await intake.createInternalReportDraft(scope,
              uuid(input.orgId, '组织'), uuid(internalReportDrafts[2], '任务'), uuid(input.snapshotId, '快照'));
          }
          const controlledReportDrafts = routes.controlledReportDrafts.exec(path);
          if (controlledReportDrafts) {
            const input = commandBody(request.body, ['orgId', 'from', 'to']);
            const [, caseId, version] = controlledReportDrafts;
            return await intake.createControlledInternalReportDraft(scope,
              uuid(input.orgId, '组织'), uuid(caseId, '任务'), revisionParam(version), ...calculationMonths(input.from, input.to));
          }
          const calculationSnapshots = routes.calculationSnapshots.exec(path);
          if (calculationSnapshots) {
            const input = commandBody(request.body, ['orgId', 'from', 'to']);
            return await intake.saveCalculationSnapshot(scope,
              uuid(input.orgId, '组织'), uuid(calculationSnapshots[1], '任务'), ...calculationMonths(input.from, input.to));
          }
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
            const input = commandBody(request.body, ['orgId', 'scenarioReleaseId', 'purpose'], ['scope']);
            return {status: 201, body: await intake.create(scope, {
              orgId: uuid(input.orgId, '组织'),
              scenarioReleaseId: uuid(input.scenarioReleaseId, '场景版本'),
              purpose: requiredText(input.purpose, '办理用途'), intakeScope: intakeScope(input.scope)
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
          const readiness = routes.reportReleaseReadiness.exec(path);
          if (readiness) {
            queryFields(query, ['orgId']);
            return {status: 200, body: await intake.readReportReleaseReadiness(scope, uuid(query.get('orgId'), '组织'),
              uuid(readiness[1], '任务'), uuid(readiness[2], '报告'))};
          }
          const reopen = routes.reopenRequests.exec(path);
          if (reopen) {
            queryFields(query, ['orgId']);
            return {status: 200, body: await intake.listCaseReopenRequests(scope, uuid(query.get('orgId'), '组织'),
              uuid(reopen[2], '任务'), reopen[1] === 'customer')};
          }
          const reopenImpact = routes.reopenImpact.exec(path);
          if (reopenImpact) {
            queryFields(query, ['orgId']);
            return {status: 200, body: await intake.previewCaseReopen(scope, uuid(query.get('orgId'), '组织'),
              uuid(reopenImpact[2], '任务'), reopenImpact[1] === 'customer')};
          }
          const reviewSummary = routes.reviewSummary.exec(path);
          if (reviewSummary) {
            queryFields(query, ['orgId']);
            return {status: 200, body: await intake.readSubmissionReviewSummary(scope, uuid(query.get('orgId'), '组织'),
              uuid(reviewSummary[1], '任务'), revisionParam(reviewSummary[2]))};
          }
          const issues = routes.reviewIssues.exec(path);
          if (issues) {
            queryFields(query, ['orgId']);
            return {status: 200, body: await intake.listReviewIssues(scope, uuid(query.get('orgId'), '组织'),
              uuid(issues[2], '任务'), issues[1] === 'customer')};
          }
          if (path === '/v1/professional/model-templates') {
            queryFields(query, ['orgId']);
            return {status: 200, body: await intake.listModelTemplates(scope, uuid(query.get('orgId'), '组织'))};
          }
          const templateImpact = routes.modelTemplateImpact.exec(path);
          if (templateImpact) {
            queryFields(query, ['orgId']);
            return {status: 200, body: await intake.previewModelTemplateImpact(scope, uuid(query.get('orgId'), '组织'),
              templateImpact[1], revisionParam(templateImpact[2]))};
          }
          if (path === '/v1/session/workspace') {
            queryFields(query, ['view']);
            const view = query.get('view');
            if (!['customer', 'professional', 'admin'].includes(view)) badRequest('请选择有效的工作空间视图。');
            const preferredOrgId = context.orgId;
            if (preferredOrgId != null && (typeof preferredOrgId !== 'string' || !uuidPattern.test(preferredOrgId))) {
              fail(403, 'ACCESS_DENIED', '你没有该组织的操作权限。');
            }
            return {status: 200, body: await intake.resolveWorkspace(
              scope, view === 'professional' ? 'reviewer' : view, preferredOrgId?.toLowerCase() ?? null
            )};
          }
          if (path === '/v1/professional/factor-reference-regions') {
            queryFields(query, ['orgId', 'accountingBasis', 'dataYear']);
            const dataYear = query.get('dataYear');
            if (!/^(?!0000)\d{4}$/.test(dataYear)) badRequest('数据年份必须为四位年份。');
            return {status: 200, body: await intake.listFactorReferenceRegions(scope,
              uuid(query.get('orgId'), '组织'), factorScope(query.get('accountingBasis'), Number(dataYear)))};
          }
          if (path === '/v1/professional/factor-references') {
            queryFields(query, ['orgId', 'accountingBasis', 'regionCode', 'dataYear']);
            const orgId = uuid(query.get('orgId'), '组织');
            const accountingBasis = query.get('accountingBasis');
            const regionCode = query.get('regionCode');
            const dataYear = query.get('dataYear');
            if (!/^(?!0000)\d{4}$/.test(dataYear)) badRequest('数据年份必须为四位年份。');
            return {status: 200, body: await intake.listFactorReferences(scope,
              orgId, factorFilters(accountingBasis, regionCode, Number(dataYear)))};
          }
          const factorDecision = routes.factorDecision.exec(path);
          if (factorDecision) {
            queryFields(query, ['orgId']);
            const [, role, caseId, version] = factorDecision;
            return {status: 200, body: await intake.readFactorDecision(scope,
              uuid(query.get('orgId'), '组织'), uuid(caseId, '任务'), revisionParam(version), role === 'customer')};
          }
          const reportReview = routes.internalReportReview.exec(path);
          if (reportReview) {
            queryFields(query, ['orgId']);
            const [, role, caseId, draftId] = reportReview;
            return {status: 200, body: await intake.readInternalReportReview(scope,
              uuid(query.get('orgId'), '组织'), uuid(caseId, '任务'), uuid(draftId, '稿件'), role === 'customer')};
          }
          const activities = routes.activities.exec(path);
          if (activities) {
            queryFields(query, ['orgId', 'period', 'source', 'revision']);
            const period = query.get('period');
            const source = query.get('source');
            const version = query.get('revision');
            if (!monthPattern.test(period)) badRequest('请填写有效的活动月份 YYYY-MM。');
            if (source !== 'electricity' && source !== 'natural_gas') badRequest('请选择用电或天然气活动来源。');
            return {status: 200, body: await intake.readActivityRevision(scope,
              uuid(query.get('orgId'), '组织'), uuid(activities[1], '任务'), period, source,
              version === null ? null : revisionParam(version))};
          }
          const internalReportDrafts = routes.internalReportDrafts.exec(path);
          if (internalReportDrafts) {
            queryFields(query, ['orgId', 'limit', 'cursor']);
            const cursor = query.get('cursor');
            return {status: 200, body: await intake.listInternalReportDrafts(scope,
              uuid(query.get('orgId'), '组织'), uuid(internalReportDrafts[2], '任务'), pageLimit(query),
              cursor === null ? null : uuid(cursor, '稿件游标'), internalReportDrafts[1] === 'customer')};
          }
          const internalReportDraft = routes.internalReportDraft.exec(path);
          if (internalReportDraft) {
            queryFields(query, ['orgId']);
            return {status: 200, body: await intake.readInternalReportDraft(scope,
              uuid(query.get('orgId'), '组织'), uuid(internalReportDraft[1], '任务'), uuid(internalReportDraft[2], '稿件'))};
          }
          const reportDelivery = routes.reportDelivery.exec(path);
          if (reportDelivery) {
            queryFields(query, ['orgId']);
            const [, caseId, draftId, deliveryId] = reportDelivery;
            return {status: 200, body: await intake.readReportDelivery(scope, uuid(query.get('orgId'), '组织'),
              uuid(caseId, '任务'), uuid(draftId, '稿件'), uuid(deliveryId, '交付件'))};
          }
          const reportDeliveryPdf = routes.reportDeliveryPdf.exec(path);
          if (reportDeliveryPdf) {
            queryFields(query, ['orgId']);
            const [, caseId, draftId, deliveryId] = reportDeliveryPdf;
            const delivery = await intake.readReportDelivery(scope, uuid(query.get('orgId'), '组织'),
              uuid(caseId, '任务'), uuid(draftId, '稿件'), uuid(deliveryId, '交付件'));
            if (delivery.documentHtml === null) {
              fail(409, 'REPORT_DELIVERY_SOURCE_CONFLICT', '该交付件所属报告已不是当前有效版本。');
            }
            let pdf;
            try {
              pdf = await renderDeliveryPdf?.(delivery.documentHtml);
            } catch {
              fail(503, 'PDF_EXPORT_UNAVAILABLE', 'PDF 导出暂不可用，请稍后重试。');
            }
            if (!Buffer.isBuffer(pdf) || !pdf.length) {
              fail(503, 'PDF_EXPORT_UNAVAILABLE', 'PDF 导出暂不可用，请稍后重试。');
            }
            return {status: 200, body: pdf, headers: {
              'Content-Type': 'application/pdf',
              'Content-Disposition': `attachment; filename="carbon-delivery-${delivery.deliveryId}.pdf"`,
              'Cache-Control': 'no-store'
            }};
          }
          const reportDeliveries = routes.reportDeliveries.exec(path);
          if (reportDeliveries) {
            queryFields(query, ['orgId']);
            const [, caseId, draftId] = reportDeliveries;
            return {status: 200, body: await intake.listReportDeliveries(scope, uuid(query.get('orgId'), '组织'),
              uuid(caseId, '任务'), uuid(draftId, '稿件'))};
          }
          const calculationPreview = routes.calculationPreview.exec(path);
          if (calculationPreview) {
            queryFields(query, ['orgId', 'from', 'to']);
            return {status: 200, body: await intake.previewCalculation(scope,
              uuid(query.get('orgId'), '组织'), uuid(calculationPreview[1], '任务'),
              ...calculationMonths(query.get('from'), query.get('to')))};
          }
          const calculationSnapshot = routes.calculationSnapshot.exec(path);
          if (calculationSnapshot) {
            queryFields(query, ['orgId']);
            return {status: 200, body: await intake.readCalculationSnapshot(scope,
              uuid(query.get('orgId'), '组织'), uuid(calculationSnapshot[1], '任务'), uuid(calculationSnapshot[2], '快照'))};
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
          const scenarioReferences = routes.scenarioReferences.exec(path);
          if (scenarioReferences) {
            queryFields(query, ['orgId']);
            return {status: 200, body: await intake.listScenarioReferences(scope,
              uuid(query.get('orgId'), '组织'), uuid(scenarioReferences[1], '场景版本'))};
          }
          const ruleAssessment = routes.ruleAssessment.exec(path);
          if (ruleAssessment) {
            queryFields(query, ['orgId', 'revision']);
            const version = query.get('revision');
            return {status: 200, body: await intake.readRuleAssessment(scope, uuid(query.get('orgId'), '组织'),
              uuid(ruleAssessment[2], '任务'), version === null ? null : revisionParam(version), ruleAssessment[1] === 'customer')};
          }
          const productComparison = routes.productElectricityComparison.exec(path);
          if (productComparison) {
            queryFields(query, ['orgId', 'baseline', 'target']);
            const baseline = revisionParam(query.get('baseline'));
            const target = revisionParam(query.get('target'));
            if (baseline === target) badRequest('请选择两个不同的提交版本。');
            return {status: 200, body: await intake.compareProductElectricity(scope, uuid(query.get('orgId'), '组织'),
              uuid(productComparison[2], '任务'), baseline, target, productComparison[1] === 'customer')};
          }
          const productElectricity = routes.productElectricity.exec(path);
          if (productElectricity) {
            return {status: 200, body: await intake.readProductElectricity(scope, uuid(query.get('orgId'), '组织'),
              uuid(productElectricity[2], '任务'), revisionParam(productElectricity[3]), productElectricity[1] === 'customer')};
          }
          const gasCombustion = routes.gasCombustion.exec(path);
          if (gasCombustion) {
            queryFields(query, ['orgId', 'from', 'to']);
            const [from, to] = calculationMonths(combustionMonth(query.get('from')), combustionMonth(query.get('to')));
            return {status: 200, body: await intake.previewGasCombustion(scope, uuid(query.get('orgId'), '组织'),
              uuid(gasCombustion[2], '任务'), revisionParam(gasCombustion[3]), from, to, gasCombustion[1] === 'customer')};
          }
          const gasCombustionSnapshots = routes.gasCombustionSnapshots.exec(path);
          if (gasCombustionSnapshots) {
            queryFields(query, ['orgId']);
            return {status: 200, body: await intake.listGasCombustionSnapshots(scope, uuid(query.get('orgId'), '组织'),
              uuid(gasCombustionSnapshots[2], '任务'), revisionParam(gasCombustionSnapshots[3]), gasCombustionSnapshots[1] === 'customer')};
          }
          const gasCombustionSnapshot = routes.gasCombustionSnapshot.exec(path);
          if (gasCombustionSnapshot) {
            queryFields(query, ['orgId']);
            return {status: 200, body: await intake.readGasCombustionSnapshot(scope, uuid(query.get('orgId'), '组织'),
              uuid(gasCombustionSnapshot[2], '任务'), revisionParam(gasCombustionSnapshot[3]),
              uuid(gasCombustionSnapshot[4], '试算快照'), gasCombustionSnapshot[1] === 'customer')};
          }
          const gasRestatements = routes.gasRestatements.exec(path);
          if (gasRestatements) {
            queryFields(query, ['orgId']);
            return {status: 200, body: await intake.listGasRestatements(scope, uuid(query.get('orgId'), '组织'),
              uuid(gasRestatements[2], '任务'), gasRestatements[1] === 'customer')};
          }
          const gasCombustionComparison = routes.gasCombustionComparison.exec(path);
          if (gasCombustionComparison) {
            queryFields(query, ['orgId', 'baseline', 'target']);
            return {status: 200, body: await intake.compareGasCombustionSnapshots(scope, uuid(query.get('orgId'), '组织'),
              uuid(gasCombustionComparison[2], '任务'), uuid(query.get('baseline'), '基准快照'),
              uuid(query.get('target'), '对比快照'), gasCombustionComparison[1] === 'customer')};
          }
          const gasCalculationJobs = routes.gasCalculationJobs.exec(path);
          if (gasCalculationJobs) {
            queryFields(query, ['orgId']);
            return {status: 200, body: await intake.readGasCalculationJobs(scope, uuid(query.get('orgId'), '组织'),
              uuid(gasCalculationJobs[1], '任务'), gasCalculationJobs[2] ? uuid(gasCalculationJobs[2], '计算作业') : null)};
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
            const [, role, caseId, version] = revisionEvidence;
            return {status: 200, body: await intake.listRevisionEvidence(scope,
              uuid(query.get('orgId'), '组织'), uuid(caseId, '任务'), revisionParam(version), role === 'customer')};
          }
          const revisionActivities = routes.revisionActivities.exec(path);
          if (revisionActivities) {
            queryFields(query, ['orgId']);
            const [, role, caseId, version] = revisionActivities;
            return {status: 200, body: await intake.listSubmissionActivities(scope,
              uuid(query.get('orgId'), '组织'), uuid(caseId, '任务'), revisionParam(version), role === 'customer')};
          }
          const submissionCalculation = routes.submissionCalculation.exec(path);
          if (submissionCalculation) {
            queryFields(query, ['orgId', 'from', 'to']);
            const [, caseId, version] = submissionCalculation;
            return {status: 200, body: await intake.previewSubmissionCalculation(scope,
              uuid(query.get('orgId'), '组织'), uuid(caseId, '任务'), revisionParam(version),
              ...calculationMonths(query.get('from'), query.get('to')))};
          }
          const administration = routes.administration.exec(path);
          if (administration) {
            const orgId = uuid(administration[1], '组织');
            const [limit, offset] = paging(query);
            const read = administration[2] === 'grants' ? intake.listGrants : intake.listAudit;
            return {status: 200, body: await read(scope, orgId, limit, offset)};
          }
          const ruleCatalog = routes.ruleCatalog.exec(path);
          if (ruleCatalog) {
            queryFields(query, []);
            return {status: 200, body: await intake.listRuleCatalog(scope, uuid(ruleCatalog[1], '组织'))};
          }
          const adminRuleProposals = routes.adminRuleProposals.exec(path);
          if (adminRuleProposals) {
            queryFields(query, []);
            return {status: 200, body: await intake.listRuleProposals(scope, uuid(adminRuleProposals[1], '组织'), false)};
          }
          if (path === '/v1/professional/rule-proposals') {
            queryFields(query, ['orgId']);
            return {status: 200, body: await intake.listRuleProposals(scope, uuid(query.get('orgId'), '组织'), true)};
          }
        }
        fail(404, 'ROUTE_NOT_FOUND', '未找到该操作。');
      } catch (error) {
        return errorResponse(error);
      }
    }
  };
}
