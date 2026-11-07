import { reportItemDisplay, reportTotals, request } from './shared.mjs';

const element = id => document.getElementById(id);
const subjectTypes = {organization: '组织', facility: '设施', product: '产品', project: '项目'};
const sourceNames = {electricity: '购入电力', natural_gas: '天然气'};
const reviewStates = {submitted: '待内部复核', reviewed: '内部演示复核通过', returned: '内部演示稿已退回'};

try {
  const query = new URLSearchParams(location.search);
  const caseId = query.get('case');
  const draftId = query.get('draft');
  const orgId = query.get('orgId');
  const view = query.get('view');
  const back = element('internal-report-back');
  if (view === 'professional') {
    back.href = '/professional';
    back.textContent = '返回专业作业台';
  }
  if (caseId) back.href += `?${new URLSearchParams({case: caseId})}`;
  if (!caseId || !draftId || !orgId || !['customer', 'professional'].includes(view)) {
    throw new Error('报告链接不完整。请回到工作台重新打开。');
  }

  const suffix = view === 'professional' ? '/review' : '';
  const result = await request(`/v1/${view}/cases/${encodeURIComponent(caseId)}/internal-report-drafts/${encodeURIComponent(draftId)}${suffix}?${new URLSearchParams({orgId})}`);
  const draft = view === 'professional' ? result.draft : result;
  const { review } = result;
  const { report, mode, template, createdAt } = draft;
  const { scope, summary, items, limitations, factorDecision, excludedSources, restatement } = report;
  const date = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Shanghai' });

  element('internal-report-title').textContent = report.title;
  element('internal-report-watermark').textContent = report.watermark;
  element('internal-report-meta').textContent = `模板第 ${template.version} 版 · ${date.format(new Date(createdAt))} 冻结稿`;
  if (review && Object.hasOwn(reviewStates, review.status)) {
    const state = element('internal-report-review');
    const reviewLabel = mode === 'controlled'
      ? {submitted: '待内部复核', reviewed: '内部复核通过', returned: '管理稿已退回'}[review.status]
      : mode === 'internal_trial' ? {submitted: '待内部复核', reviewed: '内部试算复核通过', returned: '试算报告已退回'}[review.status]
        : reviewStates[review.status];
    state.textContent = [reviewLabel, review.reviewedAt && date.format(new Date(review.reviewedAt))].filter(Boolean).join(' · ');
    state.hidden = false;
    if (review.reason) {
      element('internal-report-review-reason').textContent = review.reason;
      element('internal-report-review-notes').hidden = false;
    }
  }
  const totals = reportTotals(report, mode);
  element('internal-report-total').textContent = totals.main;
  element('internal-report-total-kg').textContent = totals.note;

  const fields = [['核算期间', `${scope.from} 至 ${scope.to}`], ['办理用途', scope.purpose]];
  if (scope.submissionRevision) fields.push(['提交版本', `第 ${scope.submissionRevision} 版`]);
  if (restatement) {
    fields.push(['重述基准', `提交第 ${restatement.baselineRevision} 版`],
      ['重述差额', `${restatement.deltaKgCO2} kg CO₂`], ['重述原因', restatement.reason],
      ['重述批准时间', date.format(new Date(restatement.reviewedAt))]);
  }
  if (excludedSources?.length) fields.push(['范围外来源', excludedSources.map(source => sourceNames[source] ?? source).join('、')]);
  if (scope.declaredScope) {
    const { subjectType, subjectName, jurisdiction, reportingYear, recipient } = scope.declaredScope;
    fields.push(['报告对象', `${subjectTypes[subjectType]} · ${subjectName}`], ['地区', jurisdiction],
      ['申报年度', reportingYear], ['交付对象', recipient]);
  }
  const scopeList = element('internal-report-scope');
  for (const [label, value] of fields) {
    const term = document.createElement('dt');
    const definition = document.createElement('dd');
    term.textContent = label;
    definition.textContent = value;
    scopeList.append(term, definition);
  }

  if (factorDecision) {
    const {factor, methodReference, rationale} = factorDecision;
    const fields = element('internal-report-factor-fields');
    const factorDetails = [
      ['因子', `${factor.value} ${factor.outputUnit}/${factor.inputUnit} · ${factor.dataYear} 年 · 第 ${factor.version} 版`],
      ['方法或规则版本', methodReference], ['适用依据', rationale]
    ];
    const disclosure = {source_and_value: '可披露来源与数值', summary_only: '仅可披露汇总排放', internal_only: '仅限内部使用'}
      [draft.deliveryPolicy?.factorDisclosure];
    if (disclosure) factorDetails.push(['因子披露范围', disclosure]);
    for (const [label, value] of factorDetails) {
      const term = document.createElement('dt');
      const definition = document.createElement('dd');
      term.textContent = label;
      definition.textContent = value;
      fields.append(term, definition);
    }
    const source = element('internal-report-factor-source');
    source.href = factor.sourceUrl;
    source.textContent = factor.sourceTitle;
    element('internal-report-factor').hidden = false;
  }
  if (mode === 'internal_trial' && report.model?.sourceUrl) {
    const source = element('internal-report-trial-source');
    source.href = report.model.sourceUrl;
    source.textContent = `${report.model.sourceLocator} · 模型第 ${report.model.version} 版`;
    element('internal-report-trial-model').hidden = false;
  }

  for (const item of items) {
    const row = document.createElement('tr');
    const activity = document.createElement('th');
    activity.scope = 'row';
    const display = reportItemDisplay(item, mode, summary.outputUnit);
    activity.textContent = display.activity;
    row.append(activity);
    for (const value of [display.quantity, display.emissions, display.provenance]) {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.append(cell);
    }
    element('internal-report-lineage').append(row);
  }

  for (const limitation of limitations) {
    const item = document.createElement('li');
    item.textContent = limitation;
    element('internal-report-limitations').append(item);
  }
  element('internal-report').hidden = false;
} catch (error) {
  element('internal-report-error').textContent = error.message;
} finally {
  element('internal-report-status').textContent = '';
}
