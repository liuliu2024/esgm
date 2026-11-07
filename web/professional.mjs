import { evidenceStatusLabel, getContext, internalReportHref, renderCasePreparation, renderHistory, renderRevisionEvidence, reportItemDisplay, reportKind, reportTotals, request, statusLabel } from '/shared.mjs';
import { bindFactorRegions, factorDisclosureLabel, showFactorDecision } from '/factor-decision.mjs';
import { bindRuleAssessment } from '/rule-assessment.mjs';
import { bindGasCombustion } from '/combustion.mjs';
import { bindProductElectricity } from '/product-electricity.mjs';
import { bindGasRestatement } from '/gas-restatement.mjs';
import { bindReviewIssues } from '/review-issues.mjs';
import { bindCaseReopen } from '/case-reopen.mjs';

const queue = document.querySelector('#queue');
const queueColumns = document.querySelector('#queue-columns');
const queueStatus = document.querySelector('#queue-status');
const refreshButton = document.querySelector('#refresh-queue');
const nextPage = document.querySelector('#next-page');
const workspaceError = document.querySelector('#workspace-error');
const detail = document.querySelector('#case-detail');
const caseReviewWorkspace = document.querySelector('#case-review-workspace');
const queueWorkspace = document.querySelector('#review-queue-workspace');
const reviewTools = document.querySelector('#review-tools');
const dossierButtons = [...document.querySelectorAll('.dossier-nav button')];
const detailHeading = document.querySelector('#detail-heading');
const detailStatus = document.querySelector('#detail-status');
const form = document.querySelector('#review-form');
const reason = document.querySelector('#reason');
const reviewError = document.querySelector('#review-error');
const approveButton = document.querySelector('#approve');
const returnButton = document.querySelector('#return');
const history = document.querySelector('#history');
const evidenceStatus = document.querySelector('#evidence-status');
const evidenceList = document.querySelector('#evidence-list');
const revisionEvidenceSection = document.querySelector('#revision-evidence-section');
const reviewIssues = bindReviewIssues(document.querySelector('#review-issues'), 'professional');
const showCaseReopen = bindCaseReopen(document.querySelector('#case-reopen'), 'professional');
const evidenceRevision = document.querySelector('#evidence-revision');
const combustion = bindGasCombustion(document.querySelector('#gas-combustion'), evidenceRevision);
const showGasRestatement = bindGasRestatement(document.querySelector('#gas-restatement'), 'professional');
const showProductElectricity = bindProductElectricity(document.querySelector('#product-electricity'));
const showRuleAssessment = bindRuleAssessment(document.querySelector('#case-rule-assessment'));
const revisionEvidenceStatus = document.querySelector('#revision-evidence-status');
const revisionEvidenceError = document.querySelector('#revision-evidence-error');
const revisionEvidenceList = document.querySelector('#revision-evidence-list');
const revisionSummary = document.querySelector('#submission-review-summary');
const revisionSummaryState = document.querySelector('#submission-review-state');
const revisionSummaryError = document.querySelector('#submission-review-error');
const revisionSummaryFields = document.querySelector('#submission-review-fields');
const revisionSummaryChanges = document.querySelector('#submission-review-changes');
const revisionActivity = document.querySelector('#revision-activity');
const revisionActivityStatus = document.querySelector('#revision-activity-status');
const revisionActivityList = document.querySelector('#revision-activity-list');
const revisionCalculation = document.querySelector('#revision-calculation');
const calculationForm = document.querySelector('#revision-calculation-form');
const calculationFrom = document.querySelector('#revision-calculation-from');
const calculationTo = document.querySelector('#revision-calculation-to');
const calculationRun = document.querySelector('#revision-calculation-run');
const calculationStatus = document.querySelector('#revision-calculation-status');
const calculationError = document.querySelector('#revision-calculation-error');
const calculationExcluded = document.querySelector('#revision-calculation-excluded');
const calculationList = document.querySelector('#revision-calculation-list');
const factorForm = document.querySelector('#factor-reference-form');
const factorBasis = document.querySelector('#factor-accounting-basis');
const factorYear = document.querySelector('#factor-data-year');
const factorRegion = document.querySelector('#factor-region');
const factorSearch = document.querySelector('#factor-reference-search');
const factorStatus = document.querySelector('#factor-reference-status');
const factorError = document.querySelector('#factor-reference-error');
const factorResults = document.querySelector('#factor-reference-results');
const reportPanel = document.querySelector('#report-review');
const reportList = document.querySelector('#report-review-list');
const reportListStatus = document.querySelector('#report-review-list-status');
const reportListError = document.querySelector('#report-review-list-error');
const reportMore = document.querySelector('#report-review-more');
const reportStatus = document.querySelector('#report-review-status');
const reportError = document.querySelector('#report-review-error');
const reportDraft = document.querySelector('#report-review-draft');
const reportTitle = document.querySelector('#report-review-title');
const reportReleaseStatus = document.querySelector('#report-release-status');
const reportReleaseError = document.querySelector('#report-release-error');
const reportReleaseChecks = document.querySelector('#report-release-checks');
const reportForm = document.querySelector('#report-review-form');
const reportReason = document.querySelector('#report-review-reason');
const reportApprove = document.querySelector('#report-review-approve');
const reportReturn = document.querySelector('#report-review-return');
const reportStates = { submitted: '待复核', reviewed: '内部复核通过', returned: '稿件已退回' };
const subjectTypes = { organization: '组织', facility: '设施', product: '产品', project: '项目' };
const drafts = new Map();
let orgId;
const modelTemplates = document.querySelector('#model-templates');
const templateChoice = document.querySelector('#model-template-choice');
const templateDependencies = document.querySelector('#model-template-dependencies');
const templateDependencyList = document.querySelector('#model-template-dependency-list');
const templateStatus = document.querySelector('#model-template-status');
const templateError = document.querySelector('#model-template-error');
const templateImpacts = document.querySelector('#model-template-impacts');
let templateItems = [];
let templateCatalogLoad;
let templateImpactLoad;

function clearTemplateImpact() {
  templateImpactLoad = undefined;
  templateStatus.textContent = templateError.textContent = '';
  templateDependencies.hidden = templateImpacts.hidden = true;
  templateDependencyList.replaceChildren();
  templateImpacts.replaceChildren();
}

async function loadTemplateImpact() {
  clearTemplateImpact();
  const template = templateItems.find(item => `${item.templateId}:${item.version}` === templateChoice.value);
  if (!orgId || !modelTemplates.open || !template) return;
  const {templateId, version, dependencies} = template;
  for (const dependency of dependencies) {
    const entry = document.createElement('li');
    const name = templateItems.find(item => item.templateId === dependency.templateId && item.version === dependency.version)?.title;
    entry.textContent = `${name ?? dependency.templateId} · 第 ${dependency.version} 版`;
    templateDependencyList.append(entry);
  }
  templateDependencies.hidden = !dependencies.length;
  templateStatus.textContent = '正在读取引用任务…';
  const load = Symbol();
  templateImpactLoad = load;
  try {
    const path = `/v1/professional/model-templates/${encodeURIComponent(templateId)}/versions/${version}/impact`;
    const {total, items} = await request(`${path}?${new URLSearchParams({orgId})}`);
    if (templateImpactLoad !== load || !modelTemplates.open) return;
    templateImpacts.replaceChildren(...items.map(item => {
      const entry = document.createElement('li');
      const link = document.createElement('a');
      link.href = `/professional?${new URLSearchParams({case: item.caseId})}`;
      link.textContent = item.purpose;
      const detail = document.createElement('p');
      detail.className = 'muted';
      const name = templateItems.find(model => model.templateId === item.modelTemplateId && model.version === item.modelTemplateVersion)?.title;
      detail.textContent = `提交第 ${item.submissionRevision} 版 · ${name ?? item.modelTemplateId} 第 ${item.modelTemplateVersion} 版`;
      entry.append(link, detail);
      return entry;
    }));
    templateImpacts.hidden = !items.length;
    templateStatus.textContent = total > items.length ? `${total} 次任务提交引用，仅显示前 ${items.length} 条。`
      : total ? `${total} 次任务提交引用。` : '暂无任务提交引用此版本。';
  } catch (failure) {
    if (templateImpactLoad !== load || !modelTemplates.open) return;
    templateStatus.textContent = '';
    templateError.textContent = failure.message;
  }
}

async function loadModelTemplates() {
  clearTemplateImpact();
  if (!orgId || !modelTemplates.open) return;
  const load = Symbol();
  const selected = templateChoice.value;
  templateCatalogLoad = load;
  templateChoice.disabled = true;
  templateStatus.textContent = '正在读取模型模板…';
  try {
    const {items} = await request(`/v1/professional/model-templates?${new URLSearchParams({orgId})}`);
    if (templateCatalogLoad !== load || !modelTemplates.open) return;
    templateItems = items;
    templateChoice.replaceChildren(new Option('请选择模板版本', ''), ...items.map(item =>
      new Option(`${item.title} · 第 ${item.version} 版`, `${item.templateId}:${item.version}`)));
    if ([...templateChoice.options].some(option => option.value === selected)) templateChoice.value = selected;
    templateChoice.disabled = !items.length;
    templateStatus.textContent = items.length ? '' : '暂无可查的模型模板。';
    if (templateChoice.value) void loadTemplateImpact();
  } catch (failure) {
    if (templateCatalogLoad !== load || !modelTemplates.open) return;
    templateStatus.textContent = '';
    templateError.textContent = failure.message;
  }
}

modelTemplates.addEventListener('toggle', () => {
  if (modelTemplates.open) void loadModelTemplates();
  else {
    templateCatalogLoad = undefined;
    clearTemplateImpact();
  }
});
templateChoice.addEventListener('change', () => void loadTemplateImpact());
let queueCaseId;
const ruleProposalPanel = document.querySelector('#rule-proposal-review');
const ruleProposalStatus = document.querySelector('#rule-proposal-review-status');
const ruleProposalError = document.querySelector('#rule-proposal-review-error');
const ruleProposalList = document.querySelector('#rule-proposal-review-list');
const ruleProposalRefresh = document.querySelector('#rule-proposal-review-refresh');
const proposalStateLabels = {submitted: '待审批', approved: '已审批 · 待发布', returned: '已退回', published: '已发布'};
const publicationLabels = {effective: '现行', pilot: '试点', draft: '草案', superseded: '已替代', expired: '已失效', unclassified: '状态未核实'};
let reviewingProposal = false;

function proposalRow(item) {
  const row = document.createElement('li');
  const heading = document.createElement('strong');
  heading.textContent = `${item.title} · 第 ${item.scenarioVersion} 版 · ${proposalStateLabels[item.status] ?? item.status}`;
  row.append(heading);
  if (item.reviewNote) {
    const note = document.createElement('p');
    note.textContent = `审批意见：${item.reviewNote}`;
    row.append(note);
  }
  const changeLabels = {added: '新增', changed: '变更', removed: '移除'};
  for (const {code, type, before, after} of item.changes ?? []) {
    const detail = document.createElement('details');
    const title = document.createElement('summary');
    title.textContent = `${changeLabels[type]} · ${after?.title ?? before?.title ?? code}`;
    detail.append(title);
    for (const [label, reference] of [['现有', before], ['拟议', after]]) {
      if (!reference) continue;
      const description = document.createElement('p');
      description.textContent = `${label} · ${publicationLabels[reference.publicationStatus] ?? '状态未核实'} · ${reference.scopeNote}`;
      detail.append(description);
    }
    row.append(detail);
  }
  if (item.status !== 'submitted' || !item.canReview) return row;

  const form = document.createElement('form');
  const label = document.createElement('label');
  label.textContent = '审批意见';
  const reason = document.createElement('textarea');
  reason.maxLength = 500;
  reason.required = true;
  label.append(reason);
  const error = document.createElement('p');
  error.setAttribute('role', 'alert');
  const actions = document.createElement('div');
  actions.className = 'actions';
  for (const [value, name] of [['approved', '批准草案'], ['returned', '退回草案']]) {
    const button = document.createElement('button');
    button.type = 'submit';
    button.value = value;
    button.textContent = name;
    actions.append(button);
  }
  form.append(label, error, actions);
  reason.addEventListener('input', () => reason.setCustomValidity(''));
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (reviewingProposal || ruleProposalRefresh.disabled || !event.submitter) return;
    const explanation = reason.value.trim();
    reason.setCustomValidity(explanation ? '' : '请填写审批意见。');
    if (!reason.reportValidity()) return;
    reviewingProposal = ruleProposalRefresh.disabled = true;
    for (const control of form.elements) control.disabled = true;
    error.textContent = '';
    try {
      const updated = await request(`/v1/professional/rule-proposals/${encodeURIComponent(item.proposalId)}/review`,
        {orgId, decision: event.submitter.value, reason: explanation});
      row.replaceWith(proposalRow({...item, ...updated}));
      ruleProposalStatus.textContent = updated.status === 'approved' ? '已批准草案，等待发布岗发布。' : '已退回草案。';
    } catch (failure) {
      error.textContent = failure.message;
    } finally {
      for (const control of form.elements) control.disabled = false;
      reviewingProposal = ruleProposalRefresh.disabled = false;
    }
  });
  row.append(form);
  return row;
}

async function loadRuleProposals() {
  if (!orgId || ruleProposalRefresh.disabled) return;
  ruleProposalRefresh.disabled = true;
  ruleProposalError.textContent = '';
  ruleProposalStatus.textContent = '正在读取草案…';
  try {
    const {items} = await request(`/v1/professional/rule-proposals?${new URLSearchParams({orgId})}`);
    ruleProposalList.replaceChildren(...items.map(proposalRow));
    ruleProposalList.hidden = !items.length;
    ruleProposalStatus.textContent = items.length ? '' : '本组织暂无规则草案。';
  } catch (error) {
    ruleProposalStatus.textContent = '';
    ruleProposalError.textContent = error.message;
  } finally {
    ruleProposalRefresh.disabled = false;
  }
}

ruleProposalPanel.addEventListener('toggle', () => {
  if (ruleProposalPanel.open) void loadRuleProposals();
});
ruleProposalRefresh.addEventListener('click', () => void loadRuleProposals());
let selected;
let cursor;
let viewing;
let saving = false;
let reportView;
let revisionEvidenceView;
const activityNames = {electricity: '购入电力', natural_gas: '天然气'};

function clearRevisionCalculation() {
  if (revisionEvidenceView) revisionEvidenceView.calculationSelection = undefined;
  calculationStatus.textContent = calculationError.textContent = calculationExcluded.textContent = '';
  calculationList.replaceChildren();
  calculationList.hidden = true;
  calculationRun.disabled = false;
}

async function calculateRevision() {
  const view = revisionEvidenceView;
  const revision = evidenceRevision.value;
  if (!view || !revision || calculationRun.disabled) return;
  const selection = Symbol();
  clearRevisionCalculation();
  view.calculationSelection = selection;
  calculationRun.disabled = true;
  calculationStatus.textContent = '正在试算…';
  const query = new URLSearchParams({orgId, from: calculationFrom.value, to: calculationTo.value});
  try {
    const result = await request(`${view.base}/revisions/${revision}/calculation-preview?${query}`);
    if (revisionEvidenceView !== view || view.calculationSelection !== selection) return;
    const {coverage, items, outputUnit, knownSubtotalKg, totalKg, totalT, excludedSources} = result;
    const unit = {kgCO2: 'kg CO₂', kgCO2e: 'kg CO₂e'}[outputUnit] ?? outputUnit;
    const totalUnit = {kgCO2: 't CO₂', kgCO2e: 't CO₂e'}[outputUnit];
    const amount = totalKg !== null ? `合计 ${totalKg} ${unit}（${totalT} ${totalUnit}）`
      : knownSubtotalKg !== null ? `已知小计 ${knownSubtotalKg} ${unit}` : '暂无可计算结果';
    calculationStatus.textContent = `已试算 ${coverage.availableSlots}/${coverage.expectedSlots} 项 · ${amount} · 正式报告资格未具备`;
    calculationExcluded.textContent = excludedSources.length
      ? `本次范围外：${excludedSources.map(source => activityNames[source] ?? source).join('、')}` : '';
    calculationList.replaceChildren(...items.map(item => {
      const row = document.createElement('li');
      const label = [item.period, activityNames[item.source] ?? item.source];
      if (item.quantity !== null) label.push(`${item.quantity} ${item.unit}`);
      label.push({calculated: `${item.emissionsKg} ${unit}`, missing_activity: '缺已提交活动数据',
        missing_factor: '缺适用因子'}[item.status]);
      row.textContent = label.join(' · ');
      return row;
    }));
    calculationList.hidden = !items.length;
  } catch (error) {
    if (revisionEvidenceView !== view || view.calculationSelection !== selection) return;
    calculationStatus.textContent = '';
    calculationError.textContent = error.message;
  } finally {
    if (revisionEvidenceView === view && view.calculationSelection === selection) calculationRun.disabled = false;
  }
}

async function loadRevisionActivity() {
  const view = revisionEvidenceView;
  const revision = evidenceRevision.value;
  if (!view || !revision || !revisionActivity.open) return;
  const selection = Symbol();
  view.activitySelection = selection;
  revisionActivityList.replaceChildren();
  revisionActivityList.hidden = true;
  revisionActivityStatus.textContent = '正在读取提交时的数据…';
  try {
    const {status, items} = await request(`${view.base}/revisions/${revision}/activities?${new URLSearchParams({orgId})}`);
    if (revisionEvidenceView !== view || view.activitySelection !== selection) return;
    revisionActivityList.replaceChildren(...items.map(item => {
      const row = document.createElement('li');
      const amount = document.createElement('p');
      const origin = document.createElement('p');
      const { originalQuantity, originalUnit, previewRevision, sourceRow } = item.lineage;
      amount.textContent = `${item.period} · ${activityNames[item.source] ?? item.source} · ${item.quantity} ${item.unit}`;
      origin.className = 'muted';
      origin.textContent = `原始量 ${originalQuantity} ${originalUnit} · 活动第 ${item.revision} 版 · 导入预览第 ${previewRevision} 版 · 源文件第 ${sourceRow} 行`;
      row.append(amount, origin);
      return row;
    }));
    revisionActivityList.hidden = !items.length;
    revisionActivityStatus.textContent = status === 'legacy_unavailable' ? '该提交早于活动数据版本记录。'
      : items.length ? '' : '该提交没有已入账的活动数据。';
  } catch (error) {
    if (revisionEvidenceView === view && view.activitySelection === selection) revisionActivityStatus.textContent = error.message;
  }
}

async function loadRevisionEvidence() {
  const view = revisionEvidenceView;
  if (!view) return;
  const selection = Symbol();
  view.selection = selection;
  renderRevisionEvidence(revisionEvidenceList, []);
  revisionEvidenceStatus.textContent = '正在读取提交证据…';
  revisionEvidenceError.textContent = '';
  try {
    const { items } = await request(`${view.base}/revisions/${evidenceRevision.value}/evidence?${new URLSearchParams({ orgId })}`);
    if (revisionEvidenceView !== view || view.selection !== selection) return;
    renderRevisionEvidence(revisionEvidenceList, items);
    reviewIssues.setEvidence(Number(evidenceRevision.value), items);
    combustion.setEvidence(items);
    revisionEvidenceStatus.textContent = items.length ? '' : '该版本未绑定证据。';
  } catch (error) {
    if (revisionEvidenceView !== view || view.selection !== selection) return;
    revisionEvidenceStatus.textContent = '';
    revisionEvidenceError.textContent = error.message;
    combustion.setEvidence([], '未能读取该版本的固定证据。');
  }
}

async function loadRevisionSummary() {
  const view = revisionEvidenceView;
  const revision = evidenceRevision.value;
  if (!view || !revision) return;
  const token = Symbol();
  view.summarySelection = token;
  const active = () => revisionEvidenceView === view && view.summarySelection === token
    && evidenceRevision.value === revision && !caseReviewWorkspace.hidden;
  revisionSummary.hidden = false;
  revisionSummaryFields.hidden = revisionSummaryChanges.hidden = true;
  revisionSummaryFields.replaceChildren();
  revisionSummaryChanges.replaceChildren();
  revisionSummaryState.textContent = '正在读取版本摘要…';
  revisionSummaryError.textContent = '';
  try {
    const data = await request(`${view.base}/revisions/${revision}/review-summary?${new URLSearchParams({orgId})}`);
    if (!active()) return;
    const rules = {confirmed: '已确认', needs_review: '待核实', not_recorded: '未记录'};
    const fields = [
      ['固定证据', `${data.evidenceCount} 项`],
      ['活动数据', data.activityStatus === 'captured' ? `${data.activityCount} 项` : '历史版本未留存'],
      ['适用规则', rules[data.ruleStatus]],
      ['因子版本', data.factorVersion ? `${data.factorVersion.id} · 第 ${data.factorVersion.version} 版` : '未记录'],
      ['未关闭问题', `${data.openIssueCount} 项 · 关键 ${data.criticalIssueCount} 项`]
    ];
    for (const [label, value] of fields) {
      const field = document.createElement('div');
      const name = document.createElement('dt');
      const detail = document.createElement('dd');
      name.textContent = label;
      detail.textContent = value;
      field.append(name, detail);
      revisionSummaryFields.append(field);
    }
    revisionSummaryFields.hidden = false;
    revisionSummaryState.textContent = `提交第 ${data.submissionRevision} 版`;
    if (data.changes && data.previousRevision !== null) {
      const title = document.createElement('h4');
      title.textContent = `与提交第 ${data.previousRevision} 版相比`;
      const describe = (label, change) => {
        const line = document.createElement('p');
        line.textContent = change ? `${label} · 新增 ${change.added} · 移除 ${change.removed} · 变更 ${change.changed}`
          : `${label} · 有版本未留存，无法比较`;
        return line;
      };
      revisionSummaryChanges.append(title, describe('证据', data.changes.evidence), describe('活动数据', data.changes.activity));
      revisionSummaryChanges.hidden = false;
    }
  } catch (failure) {
    if (!active()) return;
    revisionSummaryState.textContent = '';
    revisionSummaryError.textContent = failure.message;
  }
}

function resetReportView() {
  reportView = undefined;
  reportPanel.open = false;
  reportList.replaceChildren();
  reportListStatus.textContent = reportListError.textContent = '';
  reportStatus.textContent = reportError.textContent = '';
  reportMore.hidden = reportDraft.hidden = reportForm.hidden = true;
  reportApprove.disabled = reportReturn.disabled = reportReason.disabled = false;
}

async function loadReports(view, after = null) {
  if (view.loading) return;
  view.loading = true;
  reportMore.disabled = true;
  reportListError.textContent = '';
  reportListStatus.textContent = '正在读取稿件…';
  const query = new URLSearchParams({ orgId, limit: '10' });
  if (after) query.set('cursor', after);
  try {
    const { items, nextCursor } = await request(`${view.base}?${query}`);
    if (reportView !== view) return;
    if (!after) reportList.replaceChildren();
    for (const item of items) {
      const row = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.draftId = item.draftId;
      const date = new Date(item.createdAt).toLocaleString('zh-CN');
      button.textContent = `${reportKind(item.mode)} · ${item.from} 至 ${item.to} · ${date} · ${reportStates[item.reviewStatus]}`;
      button.addEventListener('click', () => void loadReport(view, item.draftId, true));
      row.append(button);
      reportList.append(row);
    }
    view.cursor = nextCursor;
    reportMore.hidden = !nextCursor;
    reportListStatus.textContent = reportList.children.length ? '' : '暂无已提交稿件。';
  } catch (error) {
    if (reportView !== view) return;
    reportListStatus.textContent = '';
    reportListError.textContent = error.message;
  } finally {
    view.loading = false;
    if (reportView === view) reportMore.disabled = false;
  }
}

function drawReport(view, { draft, review }) {
  const report = draft.report;
  reportTitle.textContent = report.title;
  document.querySelector('#report-review-full').href = internalReportHref({orgId, caseId: draft.caseId,
    draftId: draft.draftId, view: 'professional'});
  document.querySelector('#report-review-watermark').textContent = report.watermark;
  const totals = reportTotals(report, draft.mode);
  document.querySelector('#report-review-summary').textContent = `${report.scope.from} 至 ${report.scope.to} · ${totals.main} · ${totals.note}`;
  document.querySelector('#report-review-purpose').textContent = report.scope.purpose;
  const declaredScope = report.scope.declaredScope;
  const scope = document.querySelector('#report-review-scope');
  scope.replaceChildren();
  scope.hidden = !declaredScope;
  if (declaredScope) {
    for (const [label, value] of [
      ['报告对象', `${subjectTypes[declaredScope.subjectType]} · ${declaredScope.subjectName}`],
      ['地区', declaredScope.jurisdiction], ['报告年度', declaredScope.reportingYear], ['交付对象', declaredScope.recipient]
    ]) {
      const term = document.createElement('dt');
      const definition = document.createElement('dd');
      term.textContent = label;
      definition.textContent = value;
      scope.append(term, definition);
    }
  }
  document.querySelector('#report-review-items').replaceChildren(...report.items.map(item => {
    const row = document.createElement('li');
    const {activity, quantity, emissions, provenance} = reportItemDisplay(item, draft.mode, report.summary.outputUnit);
    row.textContent = [activity, quantity, emissions, provenance].join(' · ');
    return row;
  }));
  document.querySelector('#report-review-decision').textContent = [reportStates[review.status],
    review.reviewedAt && new Date(review.reviewedAt).toLocaleString('zh-CN'), review.reason].filter(Boolean).join(' · ');
  reportDraft.hidden = false;
  const currentSubmission = view.caseStatus === 'approved' ? view.caseRevision - 1 : view.caseRevision;
  reportForm.hidden = review.status !== 'submitted' || !['submitted', 'approved'].includes(view.caseStatus)
    || (draft.mode === 'internal_trial' && report.scope.submissionRevision !== currentSubmission);
}

async function loadReleaseReadiness(view, draftId) {
  const token = Symbol();
  view.releaseRead = token;
  const active = () => reportView === view && view.releaseRead === token && view.current?.draft.draftId === draftId
    && !caseReviewWorkspace.hidden;
  reportReleaseStatus.textContent = '正在核对正式发布条件…';
  reportReleaseError.textContent = '';
  reportReleaseChecks.replaceChildren();
  reportReleaseChecks.hidden = true;
  try {
    const path = `${view.base}/${encodeURIComponent(draftId)}/release-readiness`;
    const {canPublish, criticalIssueCount, checks} = await request(`${path}?${new URLSearchParams({orgId})}`);
    if (!active()) return;
    const labels = {
      approved_case: '受理已批准', current_submission: '稿件对应当前有效提交', declared_scope: '已登记申报范围',
      complete_coverage: '所选期间数据覆盖完整', independent_review: '独立报告复核已通过',
      no_critical_issues: '关键问题已全部关闭', formal_eligibility: '满足正式报告资格'
    };
    for (const {code, passed} of checks) {
      const item = document.createElement('li');
      const count = code === 'no_critical_issues' ? ` · 未关闭 ${criticalIssueCount} 项` : '';
      item.textContent = `${passed ? '通过' : '待满足'} · ${labels[code] ?? code}${count}`;
      reportReleaseChecks.append(item);
    }
    reportReleaseChecks.hidden = false;
    reportReleaseStatus.textContent = canPublish ? '已满足发布条件。' : '当前稿件不可正式发布。';
  } catch (failure) {
    if (!active()) return;
    reportReleaseStatus.textContent = '';
    reportReleaseError.textContent = failure.message;
  }
}

async function loadReport(view, draftId, focus = false) {
  if (view.saving) return;
  const selection = Symbol();
  view.selection = selection;
  view.current = undefined;
  reportForm.reset();
  reportReason.setCustomValidity('');
  reportDraft.hidden = reportForm.hidden = true;
  reportError.textContent = '';
  reportStatus.textContent = '正在读取原稿…';
  const url = `${view.base}/${draftId}/review`;
  try {
    const result = await request(`${url}?${new URLSearchParams({ orgId })}`);
    if (reportView !== view || view.selection !== selection) return;
    view.current = { ...result, url };
    reportStatus.textContent = '';
    drawReport(view, result);
    void loadReleaseReadiness(view, draftId);
    if (focus) reportTitle.focus();
  } catch (error) {
    if (reportView !== view || view.selection !== selection) return;
    reportStatus.textContent = '';
    reportError.textContent = error.message;
  }
}

async function decideReport(decision) {
  const view = reportView;
  const current = view?.current;
  if (!current || view.saving || reportForm.hidden) return;
  const body = { orgId, decision };
  if (decision === 'returned') body.reason = reportReason.value.trim();
  view.saving = reportApprove.disabled = reportReturn.disabled = reportReason.disabled = true;
  reportError.textContent = '';
  try {
    const { review } = await request(current.url, body);
    if (reportView !== view) return;
    current.review = review;
    drawReport(view, current);
    void loadReleaseReadiness(view, current.draft.draftId);
    reportTitle.focus();
    reportStatus.textContent = reportStates[review.status];
    void loadReports(view);
  } catch (error) {
    if (reportView !== view) return;
    if (error.status === 409) reportForm.hidden = true;
    reportError.textContent = error.message;
  } finally {
    view.saving = false;
    if (reportView === view) reportApprove.disabled = reportReturn.disabled = reportReason.disabled = false;
  }
}

function setStatus(element, status) {
  element.dataset.status = status;
  element.textContent = statusLabel(status);
}

function showDossierSection(active) {
  for (const button of dossierButtons) {
    const selected = button === active;
    button.setAttribute('aria-pressed', String(selected));
    document.getElementById(button.getAttribute('aria-controls')).hidden = !selected;
  }
  if (active.getAttribute('aria-controls') === 'dossier-reports') reportPanel.open = true;
}

for (const button of dossierButtons) {
  button.addEventListener('click', () => showDossierSection(button));
}

for (const link of document.querySelectorAll('[data-review-home]')) {
  link.addEventListener('click', event => {
    if (caseReviewWorkspace.hidden) return;
    event.preventDefault();
    viewing = undefined;
    reviewIssues.show();
    showCaseReopen();
    showGasRestatement();
    caseReviewWorkspace.hidden = true;
    queueWorkspace.hidden = reviewTools.hidden = false;
    const task = link.hasAttribute('data-return-to-task')
      ? queue.querySelector('[aria-current="true"]') : null;
    (task ?? document.querySelector(link.hash)).focus();
  });
}

function drawCase(item, canReview) {
  setStatus(document.querySelector('#case-status'), item.status);
  document.querySelector('#case-revision').textContent = `第 ${item.revision} 版`;
  detailHeading.textContent = item.purpose;
  renderCasePreparation(document.querySelector('#case-scenario-preparation'), item.id, item.scenarioPreparation);
  const { scope } = item;
  document.querySelector('#scope-section').hidden = !scope;
  document.querySelector('#scope-subject').textContent = scope ? `${subjectTypes[scope.subjectType]} · ${scope.subjectName}` : '';
  document.querySelector('#scope-jurisdiction').textContent = scope?.jurisdiction ?? '';
  document.querySelector('#scope-year').textContent = scope?.reportingYear ?? '';
  document.querySelector('#scope-recipient').textContent = scope?.recipient ?? '';
  document.querySelector('#correction-section').hidden = !item.correctionNote;
  document.querySelector('#correction').textContent = item.correctionNote ?? '';
  document.querySelector('#return-section').hidden = !item.returnReason;
  document.querySelector('#return-reason').textContent = item.returnReason ?? '';
  reason.value = drafts.get(item.id) ?? '';
  reason.setCustomValidity('');
  document.querySelector('#preserved-reason').hidden = canReview || !reason.value;
  document.querySelector('#preserved-reason-text').textContent = reason.value;
  form.hidden = !canReview;
  detail.hidden = false;
  if (dossierButtons[2].getAttribute('aria-pressed') === 'true') reportPanel.open = true;
  detailStatus.textContent = '';
}

async function loadCase(item, focus = false) {
  if (focus) showDossierSection(dossierButtons[0]);
  queueCaseId = item.id;
  for (const button of queue.querySelectorAll('[data-case-id]')) {
    button.setAttribute('aria-current', String(button.dataset.caseId === queueCaseId));
  }
  caseReviewWorkspace.hidden = false;
  queueWorkspace.hidden = reviewTools.hidden = true;
  detailHeading.textContent = item.purpose ?? '复核案卷';
  const selection = Symbol();
  viewing = selection;
  revisionEvidenceView = undefined;
  revisionSummary.hidden = true;
  revisionEvidenceSection.hidden = true;
  revisionActivity.open = false;
  revisionCalculation.open = false;
  calculationForm.reset();
  clearRevisionCalculation();
  showFactorDecision();
  showRuleAssessment();
  combustion.show();
  showGasRestatement();
  reviewIssues.show();
  showCaseReopen();
  showProductElectricity();
  resetReportView();
  detail.hidden = true;
  detailStatus.textContent = '正在加载详情';
  reviewError.textContent = '';
  if (focus) detailHeading.focus();
  try {
    const base = `/v1/professional/cases/${encodeURIComponent(item.id)}`;
    const query = new URLSearchParams({ orgId });
    const [current, { events }] = await Promise.all([
      request(`${base}?${query}`),
      request(`${base}/history?${query}`)
    ]);
    if (viewing !== selection) return;
    const canReview = item.nextAction === 'review' && current.status === 'submitted';
    selected = { ...current, nextAction: canReview ? 'review' : 'none' };
    if (current.status === 'approved' && current.scope?.reportingYear) showCaseReopen({caseId: current.id, orgId});
    if (current.gasCombustionAvailable) showGasRestatement({caseId: current.id, orgId, revision: current.revision});
    reportView = { base: `${base}/internal-report-drafts`, caseStatus: current.status, caseRevision: current.revision };
    const submitted = events.filter(event => event.action === 'submitted').sort((a, b) => b.revision - a.revision);
    evidenceRevision.replaceChildren(...submitted.map(event => new Option(`第 ${event.revision} 版`, event.revision)));
    revisionEvidenceSection.hidden = !submitted.length;
    if (submitted.length) {
      revisionEvidenceView = { base };
      reviewIssues.show({caseId: current.id, orgId});
      reviewIssues.setRevision(submitted[0].revision);
      if (current.gasCombustionAvailable) combustion.show({base, orgId, revision: submitted[0].revision,
        canRecord: canReview && submitted[0].revision === current.revision});
      if (current.productElectricityAvailable) showProductElectricity({base, orgId, revision: submitted[0].revision,
        reportingYear: current.scope?.reportingYear, canRecord: canReview && submitted[0].revision === current.revision});
      void loadRevisionEvidence();
      void loadRevisionSummary();
      showFactorDecision({base, orgId, revision: submitted[0].revision,
        canDecide: canReview && submitted[0].revision === current.revision});
      showRuleAssessment({base, orgId, revision: submitted[0].revision,
        canDecide: canReview && submitted[0].revision === current.revision});
    }
    evidenceList.replaceChildren();
    evidenceList.hidden = true;
    evidenceStatus.textContent = '正在加载材料';
    drawCase(current, canReview);
    renderHistory(history, events);
    void request(`${base}/evidence?${query}`).then(({ items }) => {
      if (viewing !== selection) return;
      for (const item of items) {
        const row = document.createElement('li');
        const title = document.createElement('strong');
        const source = document.createElement('p');
        title.textContent = item.title;
        source.textContent = `来源：${item.sourceDescription}`;
        row.append(title);
        const status = document.createElement('span');
        status.className = 'status';
        status.textContent = evidenceStatusLabel(item.status);
        row.append(' ', status);
        row.append(source);
        evidenceList.append(row);
      }
      evidenceList.hidden = items.length === 0;
      evidenceStatus.textContent = evidenceList.hidden ? '暂无登记材料' : '';
    }).catch(error => {
      if (viewing === selection) evidenceStatus.textContent = `材料加载失败：${error.message}`;
    });
  } catch (error) {
    if (viewing !== selection) return;
    selected = undefined;
    detailStatus.textContent = error.message;
  }
}

async function loadQueue(append = false) {
  nextPage.disabled = refreshButton.disabled = true;
  workspaceError.textContent = '';
  const query = new URLSearchParams({ orgId, limit: '10' });
  if (append && cursor) query.set('cursor', cursor);
  try {
    const page = await request(`/v1/professional/cases?${query}`);
    if (!append) queue.replaceChildren();
    for (const item of page.cases) {
      const row = document.createElement('li');
      const purpose = document.createElement('strong');
      purpose.className = 'queue-purpose';
      purpose.textContent = item.purpose;
      const status = document.createElement('span');
      status.className = 'status';
      setStatus(status, item.status);
      const version = document.createElement('span');
      version.className = 'muted';
      version.textContent = `第 ${item.revision} 版`;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = item.nextAction === 'review' ? 'queue-action primary' : 'queue-action';
      button.dataset.caseId = item.id;
      button.textContent = item.nextAction === 'review' ? '开始复核' : '查看记录';
      button.setAttribute('aria-label', `${button.textContent}：${item.purpose}`);
      button.setAttribute('aria-current', String(item.id === queueCaseId));
      button.addEventListener('click', () => {
        if (!saving) void loadCase(item, true);
      });
      row.append(purpose, status, version, button);
      queue.append(row);
    }
    cursor = page.nextCursor;
    nextPage.hidden = !cursor;
    queue.hidden = queue.children.length === 0;
    queueColumns.hidden = queue.hidden;
    queueStatus.textContent = queue.hidden ? '暂无复核任务' : '';
    return page.cases;
  } catch (error) {
    workspaceError.textContent = error.message;
    queueStatus.textContent = '';
  } finally {
    nextPage.disabled = refreshButton.disabled = false;
  }
}

async function decide(decision) {
  if (!selected || selected.nextAction !== 'review' || saving) return;
  saving = approveButton.disabled = returnButton.disabled = reason.disabled = true;
  reviewError.textContent = '';
  const item = selected;
  const selection = viewing;
  const body = { orgId, revision: item.revision, decision };
  if (decision === 'returned') body.reason = reason.value.trim();
  try {
    await request(`/v1/professional/cases/${item.id}/review`, body);
    drafts.delete(item.id);
    if (viewing === selection) {
      await Promise.all([loadQueue(), loadCase({ ...item, nextAction: 'none' })]);
      if (!caseReviewWorkspace.hidden) detailStatus.textContent = decision === 'approved' ? '已批准' : '已退回补正';
    } else {
      await loadQueue();
    }
  } catch (error) {
    if (error.status === 409) {
      if (viewing === selection) {
        await Promise.all([loadQueue(), loadCase(item)]);
        reviewError.textContent = '任务已更新。请核对最新版本，未提交理由已保留。';
      } else {
        await loadQueue();
      }
    } else if (viewing === selection) {
      reviewError.textContent = error.message;
    }
  } finally {
    saving = approveButton.disabled = returnButton.disabled = reason.disabled = false;
  }
}

reason.addEventListener('input', () => {
  reason.setCustomValidity('');
  if (selected) drafts.set(selected.id, reason.value);
});
reportPanel.addEventListener('toggle', () => {
  if (reportPanel.open && reportView) void loadReports(reportView);
});
evidenceRevision.addEventListener('change', () => {
  if (!revisionEvidenceView || !selected) return;
  clearRevisionCalculation();
  const revision = Number(evidenceRevision.value);
  reviewIssues.setRevision(revision);
  combustion.show(selected.gasCombustionAvailable ? {base: revisionEvidenceView.base, orgId, revision,
    canRecord: selected.nextAction === 'review' && selected.revision === revision} : undefined);
  showProductElectricity(selected.productElectricityAvailable ? {base: revisionEvidenceView.base, orgId, revision,
    reportingYear: selected.scope?.reportingYear, canRecord: selected.nextAction === 'review' && selected.revision === revision} : undefined);
  void loadRevisionEvidence();
  void loadRevisionSummary();
  void loadRevisionActivity();
  showFactorDecision({base: revisionEvidenceView.base, orgId, revision,
    canDecide: selected.nextAction === 'review' && selected.revision === revision});
  showRuleAssessment({base: revisionEvidenceView.base, orgId, revision,
    canDecide: selected.nextAction === 'review' && selected.revision === revision});
});
revisionActivity.addEventListener('toggle', () => void loadRevisionActivity());
calculationForm.addEventListener('change', clearRevisionCalculation);
calculationForm.addEventListener('submit', event => {
  event.preventDefault();
  void calculateRevision();
});
reportMore.addEventListener('click', () => {
  if (reportView?.cursor) void loadReports(reportView, reportView.cursor);
});
reportReason.addEventListener('input', () => reportReason.setCustomValidity(''));
reportApprove.addEventListener('click', () => void decideReport('reviewed'));
reportForm.addEventListener('submit', event => {
  event.preventDefault();
  if (!reportReason.value.trim()) {
    reportReason.setCustomValidity('请填写退回稿件原因。');
    reportReason.reportValidity();
    return;
  }
  void decideReport('returned');
});
form.addEventListener('submit', event => {
  event.preventDefault();
  if (!reason.value.trim()) {
    reason.setCustomValidity('请填写退回理由。');
    reason.reportValidity();
    return;
  }
  void decide('returned');
});
approveButton.addEventListener('click', () => void decide('approved'));
refreshButton.addEventListener('click', () => {
  if (!saving) void loadQueue();
});
nextPage.addEventListener('click', () => {
  if (!saving && cursor) void loadQueue(true);
});
let factorRequest;
function clearFactorResults() {
  factorRequest = undefined;
  factorStatus.textContent = factorError.textContent = '';
  factorResults.replaceChildren();
  factorResults.hidden = true;
}
const factorRegions = bindFactorRegions({basis: factorBasis, year: factorYear, region: factorRegion, search: factorSearch,
  status: document.querySelector('#factor-region-status'), error: document.querySelector('#factor-region-error'),
  retry: document.querySelector('#factor-region-retry'), getOrgId: () => orgId, clearResults: clearFactorResults});

factorForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (factorSearch.disabled || !factorRegion.value) return;
  clearFactorResults();
  const current = Symbol();
  factorRequest = current;
  factorSearch.disabled = true;
  factorStatus.textContent = '正在查询因子…';
  const regionName = factorRegion.selectedOptions[0].textContent;
  const query = new URLSearchParams({orgId, accountingBasis: factorBasis.value, regionCode: factorRegion.value, dataYear: factorYear.value});
  try {
    const { items } = await request(`/v1/professional/factor-references?${query}`);
    if (factorRequest !== current) return;
    for (const item of items) {
      const row = document.createElement('li');
      const value = document.createElement('strong');
      const source = document.createElement('a');
      const note = document.createElement('p');
      value.textContent = `${item.value} ${item.outputUnit}/${item.inputUnit} · ${regionName} · ${item.dataYear} 年 · 版本 ${item.version}`;
      source.href = item.sourceUrl;
      source.target = '_blank';
      source.rel = 'noopener noreferrer';
      source.textContent = `${item.sourceTitle} · ${item.sourceLocator}`;
      note.textContent = [item.usageNote, factorDisclosureLabel(item.disclosureScope)].filter(Boolean).join(' · ');
      const reference = document.createElement('p');
      reference.append(source);
      row.append(value, reference, note);
      factorResults.append(row);
    }
    factorResults.hidden = items.length === 0;
    factorStatus.textContent = items.length ? `找到 ${items.length} 条因子参考。` : '该核算口径、年份和地域暂无因子参考。';
  } catch (error) {
    if (factorRequest !== current) return;
    factorStatus.textContent = '';
    factorError.textContent = error.message;
  } finally {
    if (factorRequest === current) factorSearch.disabled = !factorRegion.value;
  }
});
try {
  ({ orgId } = await getContext('professional'));
  if (modelTemplates.open) void loadModelTemplates();
  if (ruleProposalPanel.open) void loadRuleProposals();
  void factorRegions.load();
  const page = await loadQueue();
  const linkedCase = new URLSearchParams(location.search).get('case');
  if (linkedCase) await loadCase(page?.find(item => item.id === linkedCase) ?? {id: linkedCase, nextAction: 'none'});
} catch (error) {
  workspaceError.textContent = error.message;
  queueStatus.textContent = '';
  refreshButton.disabled = true;
}
