import { request } from './shared.mjs';

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
  const { report, template, createdAt } = draft;
  const { scope, summary, items, limitations } = report;
  const date = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Shanghai' });

  element('internal-report-title').textContent = report.title;
  element('internal-report-watermark').textContent = report.watermark;
  element('internal-report-meta').textContent = `模板第 ${template.version} 版 · ${date.format(new Date(createdAt))} 冻结稿`;
  if (review && Object.hasOwn(reviewStates, review.status)) {
    const state = element('internal-report-review');
    state.textContent = [reviewStates[review.status], review.reviewedAt && date.format(new Date(review.reviewedAt))].filter(Boolean).join(' · ');
    state.hidden = false;
    if (review.reason) {
      element('internal-report-review-reason').textContent = review.reason;
      element('internal-report-review-notes').hidden = false;
    }
  }
  element('internal-report-total').textContent = `${summary.totalTCO2e} tCO₂e`;
  element('internal-report-total-kg').textContent = `合计 ${summary.totalKgCO2e} kgCO₂e`;

  const fields = [['核算期间', `${scope.from} 至 ${scope.to}`], ['办理用途', scope.purpose]];
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

  for (const item of items) {
    const row = document.createElement('tr');
    const activity = document.createElement('th');
    activity.scope = 'row';
    activity.textContent = `${item.period} · ${sourceNames[item.source] ?? item.source}`;
    row.append(activity);
    for (const value of [`${item.quantity} ${item.unit}`, `${item.emissionsKgCO2e} kgCO₂e`,
      `源文件第 ${item.lineage.sourceRow} 行 · 活动第 ${item.lineage.activityRevision} 版 · 因子第 ${item.factor.version} 版`]) {
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
