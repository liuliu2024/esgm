import { getContext, renderHistory, request, statusLabel } from './shared.mjs';

const element = id => document.getElementById(id);
const list = element('cases');
const listState = element('list-state');
const more = element('next-page');
const refresh = element('refresh');
const newCase = element('new-case');
const create = element('create');
const detail = element('detail');
const title = element('case-title');
const correction = element('correction');
const correctionForm = element('correct');
const submit = element('submit');
const history = element('history');
const reportHistory = element('report-history');
const reportHistoryList = element('report-history-list');
const reportHistoryMore = element('report-history-more');
const reportHistoryRetry = element('report-history-retry');
const reportHistoryResult = element('report-history-result');
const historyEvents = element('history-events');
const actionError = element('action-error');
const feedback = element('feedback');
const evidenceState = element('evidence-state');
const evidenceItems = element('evidence-items');
const evidenceForm = element('register-evidence');
const evidenceError = element('evidence-error');
const base = '/v1/customer/cases';
const notes = new Map();
const workflows = new Map();
const industry = element('industry');
const scenario = element('scenario');
const includeScope = element('include-intake-scope');
const scopeFields = element('intake-scope-fields');
const subjectTypes = {organization: '组织', facility: '设施', product: '产品', project: '项目'};
const scenarioReferences = element('scenario-references');
const referenceItems = element('scenario-reference-items');
const referenceState = element('scenario-references-state');
const referenceError = element('scenario-references-error');
const sampleCsv = 'period,source,quantity,unit\n2026-01,electricity,1000,kWh\n2026-01,natural_gas,200,m3';
const sourceLabels = { electricity: '购入电力', natural_gas: '天然气' };
const importActions = { insert: '新增', correct: '更正', unchanged: '无变更' };
let context;
let catalog = [];
let cases = [];
let selected;
let cursor;
let creating = false;
let busy = false;
let evidenceLoad = 0;
let caseDetailLoad = 0;
let workflowCaseId;
let reportHistoryView;
let referenceReleaseId;
let referenceLoad = 0;

function renderScenario() {
  const matches = catalog.filter(item => item.industryCode === industry.value);
  const previous = scenario.value;
  scenario.replaceChildren(new Option('请选择办理场景', ''), ...matches.map(item => new Option(item.title, item.id)));
  if (matches.some(item => item.id === previous)) scenario.value = previous;
  element('scenario-picker').hidden = !matches.length;
  scenario.required = Boolean(matches.length);
  renderScenarioContext();
}

function renderScenarioContext() {
  const item = catalog.find(candidate => candidate.id === scenario.value);
  element('scenario-context').textContent = item ? `${item.purpose} · 交付对象 ${item.recipient} · 适用规则待确认` : '';
  scenarioReferences.hidden = !item;
  if (referenceReleaseId === item?.id) return;
  referenceReleaseId = item?.id;
  referenceLoad += 1;
  referenceItems.replaceChildren();
  referenceItems.hidden = true;
  referenceState.textContent = '';
  referenceError.textContent = '';
  if (!item) scenarioReferences.open = false;
  else if (scenarioReferences.open) loadScenarioReferences();
}

async function loadScenarioReferences() {
  const releaseId = referenceReleaseId;
  if (!releaseId || !scenarioReferences.open) return;
  const load = ++referenceLoad;
  referenceItems.replaceChildren();
  referenceItems.hidden = true;
  referenceError.textContent = '';
  referenceState.textContent = '正在读取参考资料…';
  try {
    const {items} = await request(`/v1/customer/scenarios/${releaseId}/references?orgId=${context.orgId}`);
    if (load !== referenceLoad) return;
    const rows = items.map(({title, publisher, sourceUrl, scopeNote}) => {
      const item = document.createElement('li');
      const link = document.createElement('a');
      const url = new URL(sourceUrl);
      link.href = url.href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = title;
      const scope = document.createElement('p');
      scope.className = 'muted';
      scope.textContent = `${publisher} · ${url.hostname} · ${scopeNote}`;
      item.append(link, scope);
      return item;
    });
    referenceItems.replaceChildren(...rows);
    referenceItems.hidden = !rows.length;
    referenceState.textContent = rows.length ? '' : '暂无参考资料。';
  } catch {
    if (load !== referenceLoad) return;
    referenceState.textContent = '';
    referenceError.textContent = '暂时无法读取参考资料。可合上后重新打开。';
  }
}

scenarioReferences.addEventListener('toggle', loadScenarioReferences);

async function loadCatalog() {
  const {items} = await request('/v1/customer/scenarios?orgId=' + context.orgId);
  catalog = items;
  const industries = new Map(items.map(item => [item.industryCode, item.industryName]));
  const previous = industry.value;
  industry.replaceChildren(new Option('请选择行业', ''), ...Array.from(industries, ([code, name]) => new Option(name, code)));
  if (industries.has(previous)) industry.value = previous;
  renderScenario();
  if (!items.length) element('create-error').textContent = '此组织暂无已发布的办理场景。';
}

function setRows(container, lines) {
  container.replaceChildren(...lines.map(text => {
    const item = document.createElement('li');
    item.textContent = text;
    return item;
  }));
  container.hidden = !lines.length;
}

function calculationLine(item) {
  const label = `${item.period} ${sourceLabels[item.source]}`;
  if (item.status === 'missing_activity') return `${label} · 缺活动数据`;
  return `${label} · ${item.quantity} ${item.unit} · ${item.emissionsKgCO2e} kgCO₂e`;
}

function reportActivitySource(caseId, item) {
  const details = document.createElement('details');
  details.className = 'report-source';
  const toggle = document.createElement('summary');
  toggle.textContent = '查看来源';
  toggle.setAttribute('aria-label', `查看来源 ${item.period} ${sourceLabels[item.source]}`);
  const state = document.createElement('p');
  state.setAttribute('role', 'status');
  const error = document.createElement('p');
  error.setAttribute('role', 'alert');
  const values = document.createElement('div');
  values.className = 'report-source-values';
  values.hidden = true;
  details.append(toggle, state, error, values);

  let loading = false;
  details.addEventListener('toggle', async () => {
    if (!details.open || !values.hidden || loading || !details.isConnected) return;
    loading = true;
    state.textContent = '正在读取活动来源…';
    error.textContent = '';
    try {
      const query = new URLSearchParams({orgId: context.orgId, period: item.period, source: item.source,
        revision: item.lineage.activityRevision});
      const activity = await request(`${base}/${caseId}/activities?${query}`);
      if (!details.isConnected || selected?.id !== caseId) return;
      const {lineage} = activity;
      const amount = document.createElement('p');
      amount.textContent = `原始数量 ${lineage.originalQuantity} ${lineage.originalUnit} · 标准数量 ${activity.quantity} ${activity.unit}`;
      const source = document.createElement('p');
      source.textContent = `源文件第 ${lineage.sourceRow} 行 · 导入预览第 ${lineage.previewRevision} 版 · 活动第 ${activity.revision} 版`;
      values.replaceChildren(amount, source);
      values.hidden = false;
    } catch (failure) {
      if (details.isConnected && selected?.id === caseId) error.textContent = failure.message;
    } finally {
      state.textContent = '';
      loading = false;
    }
  });
  return details;
}

function reportReviewPanel(draft) {
  const panel = document.createElement('section');
  panel.className = 'report-review stack';
  panel.dataset.reviewDraft = draft.draftId;
  const heading = document.createElement('h5');
  heading.textContent = '演示稿复核';
  const status = document.createElement('p');
  status.className = 'report-review-status';
  status.setAttribute('role', 'status');
  status.tabIndex = -1;
  status.textContent = '正在读取复核状态…';
  const reason = document.createElement('p');
  reason.className = 'report-review-reason';
  reason.hidden = true;
  const error = document.createElement('p');
  error.className = 'report-review-error';
  error.setAttribute('role', 'alert');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'report-review-submit';
  button.textContent = '提交演示稿复核';
  button.hidden = true;
  panel.append(heading, status, reason, error, button);

  const {caseId, draftId} = draft;
  const path = `${base}/${caseId}/internal-report-drafts/${draftId}`;
  const active = () => panel.isConnected && selected?.id === caseId;
  const canSubmit = () => selected?.status === 'submitted' || selected?.status === 'approved';
  let posting = false;
  let submitted = false;

  function showReview(review) {
    submitted = true;
    status.textContent = {submitted: '待复核', reviewed: '内部复核已完成', returned: '内部复核已退回'}[review.status];
    reason.textContent = review.reason ? `退回原因 · ${review.reason}` : '';
    reason.hidden = !review.reason;
    error.textContent = '';
    button.hidden = true;
  }

  panel.addEventListener('report-review-submitted', event => showReview(event.detail));
  request(`${path}/review?orgId=${context.orgId}`).then(({review}) => {
    if (active() && !submitted) showReview(review);
  }).catch(failure => {
    if (!active() || submitted) return;
    if (failure.code === 'REPORT_REVIEW_NOT_FOUND') {
      status.textContent = '未提交';
      button.hidden = !canSubmit();
      button.disabled = busy;
    } else {
      status.textContent = '';
      error.textContent = failure.message;
    }
  });

  button.addEventListener('click', async () => {
    if (!active() || creating || !canSubmit() || submitted || posting || busy) return;
    posting = true;
    button.disabled = true;
    error.textContent = '';
    try {
      const {review} = await request(`${path}/submit-review`, {orgId: context.orgId});
      if (selected?.id !== caseId) return;
      for (const instance of document.querySelectorAll(`[data-review-draft="${draftId}"]`)) {
        instance.dispatchEvent(new CustomEvent('report-review-submitted', {detail: review}));
      }
      if (active() && !creating) status.focus();
    } catch (failure) {
      if (active()) error.textContent = failure.message;
    } finally {
      posting = false;
      button.disabled = busy;
    }
  });
  return panel;
}

function renderReport(container, draft, historical = false) {
  container.hidden = !draft;
  container.replaceChildren();
  if (!draft) return;
  const heading = document.createElement('h4');
  heading.textContent = historical ? `历史演示稿 · ${draft.report.title}` : draft.report.title;
  const watermark = document.createElement('strong');
  watermark.textContent = draft.report.watermark;
  const {from, to, declaredScope} = draft.report.scope;
  const summary = document.createElement('p');
  summary.textContent = `${declaredScope ? '核算期间 ' : ''}${from} 至 ${to} · ${draft.report.summary.totalKgCO2e} kgCO₂e（${draft.report.summary.totalTCO2e} tCO₂e）`;
  container.append(heading, watermark, summary);
  if (declaredScope) {
    const scope = document.createElement('dl');
    scope.className = 'scope-grid report-declared-scope';
    for (const [label, value] of [
      ['报告对象', `${subjectTypes[declaredScope.subjectType]} · ${declaredScope.subjectName}`],
      ['地区', declaredScope.jurisdiction],
      ['申报年度', declaredScope.reportingYear],
      ['交付对象', declaredScope.recipient]
    ]) {
      const term = document.createElement('dt');
      term.textContent = label;
      const definition = document.createElement('dd');
      definition.textContent = value;
      scope.append(term, definition);
    }
    container.append(scope);
  }
  const rows = document.createElement('ul');
  rows.className = 'history-list';
  for (const item of draft.report.items) {
    const row = document.createElement('li');
    const label = document.createElement('p');
    label.textContent = `${calculationLine(item)} · 源文件第 ${item.lineage.sourceRow} 行 · 活动第 ${item.lineage.activityRevision} 版 · 因子 v${item.factor.version}`;
    row.append(label, reportActivitySource(draft.caseId, item));
    rows.append(row);
  }
  container.append(rows, reportReviewPanel(draft));
}

function renderReportHistory() {
  const view = reportHistoryView;
  reportHistoryList.replaceChildren(...(view?.items ?? []).map(draft => {
    const row = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.draftId = draft.draftId;
    button.disabled = busy;
    const created = new Date(draft.createdAt).toLocaleString('zh-CN');
    button.textContent = `${draft.from} 至 ${draft.to} · ${created} · 模板 v${draft.templateVersion}`;
    row.append(button);
    return row;
  }));
  reportHistoryList.hidden = !view?.items.length;
  element('report-history-state').textContent = view?.loading ? '正在读取演示稿…' :
    view?.loaded && !view.items.length ? '暂无历史演示稿。' : '';
  element('report-history-error').textContent = view?.error ?? '';
  reportHistoryMore.hidden = !view?.cursor || view.loading || Boolean(view.error);
  reportHistoryRetry.hidden = !view?.error;
  element('report-history-detail-state').textContent = view?.detailLoading ? '正在读取原稿…' : '';
  element('report-history-detail-error').textContent = view?.detailError ?? '';
  renderReport(reportHistoryResult, view?.draft, true);
}

async function loadReportHistory(cursor = null) {
  if (!selected || creating || !reportHistory.open) return;
  if (!cursor) reportHistoryView = {caseId: selected.id, items: []};
  const view = reportHistoryView;
  if (!view || view.loading) return;
  view.loading = true;
  view.error = '';
  renderReportHistory();
  try {
    const query = new URLSearchParams({orgId: context.orgId, limit: '5'});
    if (cursor) query.set('cursor', cursor);
    const page = await request(`${base}/${view.caseId}/internal-report-drafts?${query}`);
    view.items.push(...page.items);
    view.cursor = page.nextCursor;
    view.loaded = true;
  } catch (error) {
    view.error = error.message;
    view.retryCursor = cursor;
  } finally {
    view.loading = false;
    if (reportHistoryView === view) renderReportHistory();
  }
}

reportHistory.addEventListener('toggle', () => {
  if (reportHistory.open) loadReportHistory();
  else reportHistoryView = null;
});

reportHistoryMore.addEventListener('click', async () => {
  const view = reportHistoryView;
  const oldCount = view.items.length;
  await loadReportHistory(view.cursor);
  if (view !== reportHistoryView) return;
  if (view.error) reportHistoryRetry.focus();
  else reportHistoryList.children[oldCount]?.firstElementChild.focus();
});

reportHistoryRetry.addEventListener('click', async () => {
  await loadReportHistory(reportHistoryView.retryCursor);
  if (!reportHistoryRetry.hidden) reportHistoryRetry.focus();
  else (reportHistoryList.querySelector('button') ?? reportHistory.querySelector('summary')).focus();
});

reportHistoryList.addEventListener('click', async event => {
  const button = event.target.closest('button[data-draft-id]');
  const view = reportHistoryView;
  if (!button || !view || view.detailLoading) return;
  view.detailLoading = true;
  view.detailError = '';
  view.draft = null;
  element('report-history-detail-state').textContent = '正在读取原稿…';
  element('report-history-detail-error').textContent = '';
  renderReport(reportHistoryResult, null, true);
  try {
    view.draft = await request(`${base}/${view.caseId}/internal-report-drafts/${button.dataset.draftId}?orgId=${context.orgId}`);
  } catch (error) {
    view.detailError = error.message;
  } finally {
    view.detailLoading = false;
    if (reportHistoryView === view && reportHistory.open) {
      element('report-history-detail-state').textContent = '';
      element('report-history-detail-error').textContent = view.detailError;
      renderReport(reportHistoryResult, view.draft, true);
      if (view.draft) reportHistoryResult.focus();
    }
  }
});

function renderWorkflow() {
  if (!selected || creating) return;
  if (workflowCaseId !== selected.id) {
    workflowCaseId = selected.id;
    element('activity-workflow').open = false;
    reportHistory.open = false;
    reportHistoryView = null;
    renderReportHistory();
  }
  if (!workflows.has(selected.id)) workflows.set(selected.id, {csv: '', from: '', to: ''});
  const state = workflows.get(selected.id);
  const editable = selected.status === 'draft' || selected.status === 'returned';
  const {batch, calculation, draft} = state;
  element('activity-import').hidden = !editable;
  element('activity-csv').value = state.csv;
  element('calc-from').value = state.from;
  element('calc-to').value = state.to;
  element('activity-error').textContent = state.importError ?? '';
  element('calc-error').textContent = state.calcError ?? '';
  element('activity-status').textContent = batch?.receipt
    ? `已入账 · 新增 ${batch.receipt.inserted} · 更正 ${batch.receipt.corrected} · 无变更 ${batch.receipt.unchanged}`
    : batch ? `预检第 ${batch.previewRevision} 版 · ${batch.status === 'blocked' ? '待修正' : '待确认'}` : '';
  setRows(element('activity-rows'), batch ? [
    ...batch.issues.map(issue => `第 ${issue.row} 行 · ${issue.column} · ${issue.remedy}`),
    ...batch.preview.map(row => {
      const quantity = row.action === 'correct' ? `${row.baseQuantity} → ${row.quantity}` : row.quantity;
      return `${row.period} ${sourceLabels[row.source]} · ${quantity} ${row.unit} · ${importActions[row.action]}`;
    })
  ] : []);
  element('activity-actions').hidden = !editable || batch?.status !== 'ready' || Boolean(batch.receipt);
  element('activity-confirm').hidden = Boolean(state.stale);
  element('activity-repreview').hidden = !state.stale;
  element('calc-status').textContent = calculation ? (
    calculation.coverage.status === 'complete' ? `覆盖完整 · ${calculation.totalKgCO2e} kgCO₂e` :
      calculation.coverage.status === 'partial' ? `已知小计 ${calculation.knownSubtotalKgCO2e} kgCO₂e · 缺 ${calculation.coverage.missingSlots} 项` : '暂无已入账的活动数据。'
  ) : '';
  setRows(element('calc-rows'), calculation?.items.map(calculationLine) ?? []);
  element('report-stage').hidden = !draft && calculation?.coverage.status !== 'complete';
  element('report-generate').hidden = calculation?.coverage.status !== 'complete';
  renderReport(element('report-result'), draft);
}

async function runWorkflow(errorField, operation) {
  if (busy || !selected || creating) return;
  const id = selected.id;
  const state = workflows.get(id);
  state[errorField] = '';
  setBusy(true);
  try {
    await operation(state, `${base}/${id}`, context.orgId);
  } catch (error) {
    if (error.code === 'IMPORT_STALE_BASELINE' || error.code === 'IMPORT_STALE_PREVIEW') state.stale = true;
    state[errorField] = error.message;
  } finally {
    setBusy(false);
    if (selected?.id === id) renderWorkflow();
  }
}

function renderList() {
  const items = cases.map(item => {
    const row = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.id = item.id;
    button.setAttribute('aria-current', String(!creating && selected?.id === item.id));
    button.disabled = busy;
    const purpose = document.createElement('span');
    purpose.textContent = item.purpose;
    const state = document.createElement('span');
    state.className = 'status';
    state.dataset.status = item.status;
    state.textContent = statusLabel(item.status);
    button.append(purpose, state);
    row.append(button);
    return row;
  });
  list.replaceChildren(...items);
  listState.textContent = cases.length ? '' : '暂无受理单';
  more.hidden = !cursor;
}

function renderDetail() {
  create.hidden = !creating;
  detail.hidden = creating || !selected;
  element('placeholder').hidden = !detail.hidden || creating;
  if (detail.hidden) return;
  title.textContent = selected.purpose;
  const status = element('case-status');
  status.textContent = statusLabel(selected.status);
  status.dataset.status = selected.status;
  element('case-revision').textContent = '第 ' + selected.revision + ' 版';
  const scope = selected.scope;
  element('case-intake-scope').hidden = !scope;
  element('case-scope-subject').textContent = scope ? `${subjectTypes[scope.subjectType]} · ${scope.subjectName}` : '';
  element('case-scope-jurisdiction').textContent = scope?.jurisdiction ?? '';
  element('case-scope-year').textContent = scope?.reportingYear ?? '';
  element('case-scope-recipient').textContent = scope?.recipient ?? '';
  element('returned').hidden = selected.status !== 'returned';
  element('return-reason').textContent = selected.returnReason ?? '';
  submit.hidden = selected.status !== 'draft';
  const canCorrect = selected.status === 'returned';
  evidenceForm.hidden = selected.status !== 'draft' && !canCorrect;
  const savedNote = notes.get(selected.id) ?? '';
  correctionForm.hidden = !canCorrect && !savedNote;
  correction.readOnly = !canCorrect;
  element('resubmit').hidden = !canCorrect;
  correction.value = savedNote;
  renderWorkflow();
}

function setBusy(value) {
  busy = value;
  for (const control of document.querySelectorAll('button, input, select, textarea')) {
    control.disabled = value;
  }
}

function updateCase(item) {
  cases = cases.map(existing => existing.id === item.id ? item : existing);
  selected = item;
  renderList();
  renderDetail();
  if (reportHistoryView?.draft) renderReport(reportHistoryResult, reportHistoryView.draft, true);
}

async function loadPage(after) {
  const query = new URLSearchParams({ orgId: context.orgId });
  if (after) query.set('cursor', after);
  const result = await request(base + '?' + query);
  if (after) {
    const known = new Set(cases.map(item => item.id));
    cases.push(...result.cases.filter(item => !known.has(item.id)));
  } else {
    cases = result.cases;
  }
  cursor = result.nextCursor;
  renderList();
}

async function loadHistory() {
  const item = selected;
  if (!item || !history.open) return;
  historyEvents.textContent = '正在读取…';
  try {
    const result = await request(base + '/' + item.id + '/history?orgId=' + context.orgId);
    if (selected === item) renderHistory(historyEvents, result.events);
  } catch (error) {
    if (selected === item) historyEvents.textContent = error.message;
  }
}

async function loadEvidence() {
  const item = selected;
  if (!item || creating) return;
  const load = ++evidenceLoad;
  evidenceState.textContent = '正在读取材料…';
  evidenceItems.replaceChildren();
  try {
    const { items } = await request(base + '/' + item.id + '/evidence?orgId=' + context.orgId);
    if (selected !== item || creating || load !== evidenceLoad) return;
    evidenceState.textContent = items.length ? '' : '暂无登记材料';
    for (const evidence of items) {
      const entry = document.createElement('li');
      const title = document.createElement('strong');
      const label = { pending_file: '待补文件', pending_scan: '待检查' }[evidence.status];
      title.textContent = evidence.title + ' · ' + (label ?? evidence.status);
      const source = document.createElement('p');
      source.textContent = evidence.sourceDescription;
      entry.append(title, source);
      if (evidence.status === 'pending_file' && (item.status === 'draft' || item.status === 'returned')) {
        const form = element('evidence-upload').content.firstElementChild.cloneNode(true);
        const input = form.querySelector('input');
        const alert = form.querySelector('[role="alert"]');
        input.disabled = busy;
        form.querySelector('button').disabled = busy;
        form.addEventListener('submit', async event => {
          event.preventDefault();
          const file = input.files[0];
          if (busy || selected !== item || creating || !file) return;
          alert.textContent = '';
          feedback.textContent = '';
          setBusy(true);
          try {
            const response = await fetch(base + '/' + item.id + '/evidence/' + evidence.id + '/file?orgId=' + context.orgId, {
              method: 'POST',
              headers: { 'Content-Type': file.type },
              body: file
            });
            if (!response.ok) {
              const result = await response.json();
              throw new Error(result.error?.message ?? '文件未接收。');
            }
            if (selected === item && !creating) {
              feedback.textContent = '文件已接收，待检查。';
              await loadEvidence();
            }
          } catch (error) {
            if (selected === item && !creating) alert.textContent = error.message;
          } finally {
            setBusy(false);
          }
        });
        entry.append(form);
      }
      evidenceItems.append(entry);
    }
  } catch (error) {
    if (selected === item && !creating && load === evidenceLoad) evidenceState.textContent = error.message;
  }
}

list.addEventListener('click', async event => {
  const button = event.target.closest('button[data-id]');
  if (!button) return;
  if (creating) resetCreate();
  if (selected?.id !== button.dataset.id) evidenceForm.reset();
  evidenceError.textContent = '';
  selected = cases.find(item => item.id === button.dataset.id);
  creating = false;
  history.open = false;
  actionError.textContent = '';
  feedback.textContent = '';
  renderList();
  renderDetail();
  title.focus();
  const item = selected;
  const load = ++caseDetailLoad;
  try {
    const current = await request(`${base}/${item.id}?orgId=${context.orgId}`);
    if (selected !== item || creating || load !== caseDetailLoad) return;
    updateCase(current);
    await loadEvidence();
  } catch (error) {
    if (selected === item && !creating && load === caseDetailLoad) feedback.textContent = error.message;
  }
});

newCase.addEventListener('click', async () => {
  creating = true;
  element('create-error').textContent = '';
  renderList();
  renderDetail();
  setBusy(true);
  try {
    await loadCatalog();
  } catch (error) {
    industry.replaceChildren(new Option('无法读取行业', ''));
    scenario.replaceChildren();
    renderScenario();
    element('create-error').textContent = error.message;
  } finally {
    setBusy(false);
    industry.focus();
  }
});

industry.addEventListener('change', renderScenario);
scenario.addEventListener('change', renderScenarioContext);

function toggleIntakeScope() {
  scopeFields.hidden = !includeScope.checked;
  scopeFields.disabled = !includeScope.checked;
}

includeScope.addEventListener('change', toggleIntakeScope);

function resetCreate() {
  create.reset();
  toggleIntakeScope();
  renderScenario();
}

element('cancel-create').addEventListener('click', () => {
  creating = false;
  resetCreate();
  renderList();
  renderDetail();
  newCase.focus();
  loadEvidence();
});

create.addEventListener('submit', async event => {
  event.preventDefault();
  const errorMessage = element('create-error');
  errorMessage.textContent = '';
  setBusy(true);
  try {
    const body = {
      orgId: context.orgId,
      scenarioReleaseId: element('scenario').value,
      purpose: element('purpose').value
    };
    if (includeScope.checked) {
      body.scope = {
        subjectType: element('scope-subject-type').value,
        subjectName: element('scope-subject-name').value,
        jurisdiction: element('scope-jurisdiction').value,
        reportingYear: element('scope-reporting-year').value,
        recipient: element('scope-recipient').value
      };
    }
    const item = await request(base, body);
    creating = false;
    resetCreate();
    cases = [item, ...cases];
    history.open = false;
    actionError.textContent = '';
    evidenceForm.reset();
    evidenceError.textContent = '';
    updateCase(item);
    feedback.textContent = '草稿已保存。';
    await loadEvidence();
  } catch (error) {
    errorMessage.textContent = error.message;
  } finally {
    setBusy(false);
  }
  if (!creating) title.focus();
});

async function sendCase(isCorrection) {
  const item = selected;
  actionError.textContent = '';
  feedback.textContent = '';
  if (isCorrection) notes.set(item.id, correction.value);
  const body = { orgId: context.orgId, revision: item.revision };
  if (isCorrection) body.correctionNote = correction.value;
  setBusy(true);
  try {
    const action = isCorrection ? 'resubmit' : 'submit';
    const current = await request(base + '/' + item.id + '/' + action, body);
    notes.delete(item.id);
    updateCase(current);
    feedback.textContent = '已提交复核。';
    await Promise.all([loadHistory(), loadEvidence()]);
  } catch (error) {
    actionError.textContent = error.message;
    if (error.status === 409) {
      try {
        updateCase(await request(base + '/' + item.id + '?orgId=' + context.orgId));
        feedback.textContent = '已刷新为最新状态。';
        if (isCorrection && correction.readOnly) actionError.textContent = '任务状态已变化。本次补正未提交。';
        await Promise.all([loadHistory(), loadEvidence()]);
      } catch (refreshError) {
        feedback.textContent = refreshError.message;
      }
    }
  } finally {
    setBusy(false);
  }
  if (isCorrection && !correctionForm.hidden && !correction.readOnly) correction.focus();
  else title.focus();
}

submit.addEventListener('click', () => sendCase(false));
correctionForm.addEventListener('submit', event => {
  event.preventDefault();
  sendCase(true);
});
correction.addEventListener('input', () => notes.set(selected.id, correction.value));
history.addEventListener('toggle', loadHistory);

element('activity-csv').addEventListener('input', event => {
  const state = workflows.get(selected.id);
  state.csv = event.target.value;
  if (!state.batch && !state.importError) return;
  state.batch = null;
  state.stale = false;
  state.importError = '';
  renderWorkflow();
});

element('activity-sample').addEventListener('click', () => {
  const state = workflows.get(selected.id);
  Object.assign(state, {csv: sampleCsv, from: '2026-01', to: '2026-01', batch: null, calculation: null, draft: null,
    stale: false, importError: '', calcError: ''});
  renderWorkflow();
  element('activity-csv').focus();
});

element('activity-import').addEventListener('submit', async event => {
  event.preventDefault();
  await runWorkflow('importError', async (state, path, orgId) => {
    state.batch = await request(path + '/imports', {orgId, csv: state.csv});
    state.stale = false;
  });
  if (!element('activity-actions').hidden) element('activity-confirm').focus();
});

element('activity-confirm').addEventListener('click', async () => {
  await runWorkflow('importError', async (state, path, orgId) => {
    const {batchId, previewRevision} = state.batch;
    state.batch.receipt = await request(`${path}/imports/${batchId}/commit`, {orgId, previewRevision});
    state.calculation = null;
    state.draft = null;
  });
  if (!element('activity-repreview').hidden) element('activity-repreview').focus();
  else if (element('activity-actions').hidden) element('calc-from').focus();
});

element('activity-repreview').addEventListener('click', async () => {
  await runWorkflow('importError', async (state, path, orgId) => {
    const batchPath = `${path}/imports/${state.batch.batchId}`;
    const latest = await request(`${batchPath}?orgId=${orgId}`);
    state.batch = latest.receipt ? latest : await request(`${batchPath}/repreview`, {orgId, previewRevision: latest.previewRevision});
    state.stale = false;
  });
  if (!element('activity-actions').hidden && !element('activity-confirm').hidden) element('activity-confirm').focus();
});

for (const bound of ['from', 'to']) {
  element(`calc-${bound}`).addEventListener('change', event => {
    const state = workflows.get(selected.id);
    state[bound] = event.target.value;
    state.calculation = null;
    state.draft = null;
    state.calcError = '';
    renderWorkflow();
  });
}

element('calc-form').addEventListener('submit', async event => {
  event.preventDefault();
  await runWorkflow('calcError', async (state, path, orgId) => {
    const {from, to} = state;
    const query = new URLSearchParams({orgId, from, to});
    state.calculation = await request(`${path}/calculation-preview?${query}`);
  });
});

element('report-generate').addEventListener('click', async () => {
  let generated = false;
  await runWorkflow('calcError', async (state, path, orgId) => {
    const {from, to} = state.calculation;
    const {snapshotId} = await request(`${path}/calculation-snapshots`, {orgId, from, to});
    state.draft = await request(`${path}/internal-report-drafts`, {orgId, snapshotId});
    generated = true;
  });
  if (generated) {
    element('report-result').focus();
    if (reportHistory.open) loadReportHistory();
  }
});

evidenceForm.addEventListener('submit', async event => {
  event.preventDefault();
  const item = selected;
  if (busy || !item || evidenceForm.hidden) return;
  evidenceError.textContent = '';
  feedback.textContent = '';
  setBusy(true);
  try {
    await request(base + '/' + item.id + '/evidence', {
      orgId: context.orgId,
      title: element('evidence-title').value,
      sourceDescription: element('evidence-source').value
    });
    evidenceForm.reset();
    feedback.textContent = '材料已登记。';
    await loadEvidence();
  } catch (error) {
    evidenceError.textContent = error.message;
  } finally {
    setBusy(false);
  }
});

more.addEventListener('click', async () => {
  setBusy(true);
  try {
    await loadPage(cursor);
  } catch (error) {
    feedback.textContent = error.message;
  } finally {
    setBusy(false);
  }
});

refresh.addEventListener('click', async () => {
  feedback.textContent = '';
  actionError.textContent = '';
  setBusy(true);
  try {
    await loadPage();
    if (selected && !creating) {
      updateCase(await request(base + '/' + selected.id + '?orgId=' + context.orgId));
      await Promise.all([loadHistory(), loadEvidence()]);
    }
    feedback.textContent = '已刷新。';
  } catch (error) {
    feedback.textContent = error.message;
  } finally {
    setBusy(false);
    refresh.focus();
  }
});

try {
  context = await getContext();
  await loadPage();
  newCase.disabled = false;
  refresh.disabled = false;
} catch (error) {
  listState.textContent = '无法读取受理单';
  feedback.textContent = error.message;
}
