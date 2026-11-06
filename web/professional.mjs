import { getContext, renderCasePreparation, renderHistory, request, statusLabel } from '/shared.mjs';

const queue = document.querySelector('#queue');
const queueStatus = document.querySelector('#queue-status');
const refreshButton = document.querySelector('#refresh-queue');
const nextPage = document.querySelector('#next-page');
const workspaceError = document.querySelector('#workspace-error');
const detail = document.querySelector('#case-detail');
const detailStatus = document.querySelector('#detail-status');
const form = document.querySelector('#review-form');
const reason = document.querySelector('#reason');
const reviewError = document.querySelector('#review-error');
const approveButton = document.querySelector('#approve');
const returnButton = document.querySelector('#return');
const history = document.querySelector('#history');
const evidenceStatus = document.querySelector('#evidence-status');
const evidenceList = document.querySelector('#evidence-list');
const factorForm = document.querySelector('#factor-reference-form');
const factorBasis = document.querySelector('#factor-accounting-basis');
const factorYear = document.querySelector('#factor-data-year');
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
const reportForm = document.querySelector('#report-review-form');
const reportReason = document.querySelector('#report-review-reason');
const reportApprove = document.querySelector('#report-review-approve');
const reportReturn = document.querySelector('#report-review-return');
const reportStates = { submitted: '待复核', reviewed: '演示复核通过', returned: '演示稿已退回' };
const subjectTypes = { organization: '组织', facility: '设施', product: '产品', project: '项目' };
const drafts = new Map();
let orgId;
let selected;
let cursor;
let viewing;
let saving = false;
let reportView;

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
  reportListStatus.textContent = '正在读取演示稿…';
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
      button.textContent = `${item.from} 至 ${item.to} · ${date} · ${reportStates[item.reviewStatus]}`;
      button.addEventListener('click', () => void loadReport(view, item.draftId, true));
      row.append(button);
      reportList.append(row);
    }
    view.cursor = nextCursor;
    reportMore.hidden = !nextCursor;
    reportListStatus.textContent = reportList.children.length ? '' : '暂无已提交演示稿。';
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
  document.querySelector('#report-review-watermark').textContent = report.watermark;
  document.querySelector('#report-review-summary').textContent = `${report.scope.from} 至 ${report.scope.to} · ${report.summary.totalKgCO2e} kgCO₂e（${report.summary.totalTCO2e} tCO₂e）`;
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
    const source = item.source === 'electricity' ? '购入电力' : '天然气';
    row.textContent = `${item.period} ${source} · ${item.quantity} ${item.unit} · ${item.emissionsKgCO2e} kgCO₂e · 源文件第 ${item.lineage.sourceRow} 行 · 活动第 ${item.lineage.activityRevision} 版 · 因子 v${item.factor.version}`;
    return row;
  }));
  document.querySelector('#report-review-decision').textContent = [reportStates[review.status],
    review.reviewedAt && new Date(review.reviewedAt).toLocaleString('zh-CN'), review.reason].filter(Boolean).join(' · ');
  reportDraft.hidden = false;
  reportForm.hidden = review.status !== 'submitted' || !['submitted', 'approved'].includes(view.caseStatus);
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

function drawCase(item, canReview) {
  setStatus(document.querySelector('#case-status'), item.status);
  document.querySelector('#case-revision').textContent = `第 ${item.revision} 版`;
  document.querySelector('#purpose').textContent = item.purpose;
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
  detailStatus.textContent = '';
}

async function loadCase(item, focus = false) {
  const selection = Symbol();
  viewing = selection;
  resetReportView();
  detail.hidden = true;
  detailStatus.textContent = '正在加载详情';
  reviewError.textContent = '';
  try {
    const base = `/v1/professional/cases/${item.id}`;
    const query = new URLSearchParams({ orgId });
    const [current, { events }] = await Promise.all([
      request(`${base}?${query}`),
      request(`${base}/history?${query}`)
    ]);
    if (viewing !== selection) return;
    const canReview = item.nextAction === 'review' && current.status === 'submitted';
    selected = { ...current, nextAction: canReview ? 'review' : 'none' };
    reportView = { base: `${base}/internal-report-drafts`, caseStatus: current.status };
    evidenceList.replaceChildren();
    evidenceList.hidden = true;
    evidenceStatus.textContent = '正在加载材料';
    drawCase(current, canReview);
    renderHistory(history, events);
    if (focus) document.querySelector('#detail-heading').focus();
    void request(`${base}/evidence?${query}`).then(({ items }) => {
      if (viewing !== selection) return;
      for (const item of items) {
        const row = document.createElement('li');
        const title = document.createElement('strong');
        const source = document.createElement('p');
        title.textContent = item.title;
        source.textContent = `来源：${item.sourceDescription}`;
        row.append(title);
        if (item.status === 'pending_file' || item.status === 'pending_scan') {
          const status = document.createElement('span');
          status.className = 'status';
          status.textContent = item.status === 'pending_scan' ? '待检查' : '待补文件';
          row.append(' ', status);
        }
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
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = item.purpose;
      button.addEventListener('click', () => {
        if (!saving) void loadCase(item, true);
      });
      const status = document.createElement('span');
      status.className = 'status';
      setStatus(status, item.status);
      row.append(button, ' ', status);
      queue.append(row);
    }
    cursor = page.nextCursor;
    nextPage.hidden = !cursor;
    queue.hidden = queue.children.length === 0;
    queueStatus.textContent = queue.hidden ? '暂无复核任务' : '';
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
  const body = { orgId, revision: item.revision, decision };
  if (decision === 'returned') body.reason = reason.value.trim();
  try {
    await request(`/v1/professional/cases/${item.id}/review`, body);
    drafts.delete(item.id);
    await Promise.all([loadQueue(), loadCase({ ...item, nextAction: 'none' })]);
    detailStatus.textContent = decision === 'approved' ? '已批准' : '已退回补正';
  } catch (error) {
    if (error.status === 409) {
      await Promise.all([loadQueue(), loadCase(item)]);
      reviewError.textContent = '任务已更新。请核对最新版本，未提交理由已保留。';
    } else {
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
factorForm.addEventListener('change', () => {
  factorStatus.textContent = factorError.textContent = '';
  factorResults.replaceChildren();
  factorResults.hidden = true;
});
factorForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (factorSearch.disabled) return;
  factorSearch.disabled = factorBasis.disabled = factorYear.disabled = true;
  factorStatus.textContent = '正在查询因子…';
  factorError.textContent = '';
  factorResults.hidden = true;
  factorResults.replaceChildren();
  const query = new URLSearchParams({ orgId, accountingBasis: factorBasis.value, regionCode: 'CN', dataYear: factorYear.value });
  try {
    const { items } = await request(`/v1/professional/factor-references?${query}`);
    for (const item of items) {
      const row = document.createElement('li');
      const value = document.createElement('strong');
      const source = document.createElement('a');
      const note = document.createElement('p');
      value.textContent = `${item.value} ${item.outputUnit}/${item.inputUnit} · 全国 · ${item.dataYear} 年 · 版本 ${item.version}`;
      source.href = item.sourceUrl;
      source.target = '_blank';
      source.rel = 'noopener noreferrer';
      source.textContent = `${item.sourceTitle} · ${item.sourceLocator}`;
      note.textContent = item.usageNote;
      const reference = document.createElement('p');
      reference.append(source);
      row.append(value, reference, note);
      factorResults.append(row);
    }
    factorResults.hidden = items.length === 0;
    factorStatus.textContent = items.length ? `找到 ${items.length} 条因子参考。` : '该口径和年份暂无全国因子。';
  } catch (error) {
    factorStatus.textContent = '';
    factorError.textContent = error.message;
  } finally {
    factorSearch.disabled = factorBasis.disabled = factorYear.disabled = false;
  }
});
try {
  ({ orgId } = await getContext());
  factorSearch.disabled = false;
  await loadQueue();
} catch (error) {
  workspaceError.textContent = error.message;
  queueStatus.textContent = '';
  refreshButton.disabled = true;
}
