import {internalReportHref, request} from './shared.mjs';

const states = {pending: '待独立审批', approved: '已批准', returned: '已退回'};
const date = new Intl.DateTimeFormat('zh-CN', {timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short'});
const pairLabel = item => `基准第 ${item.baselineRevision} 版 → 目标第 ${item.targetRevision} 版 · ${item.from === item.to ? item.from : `${item.from} 至 ${item.to}`}`;

export function bindGasRestatement(panel, role) {
  const state = panel.querySelector('[data-restatement-state]');
  const error = panel.querySelector('[data-restatement-error]');
  const refresh = panel.querySelector('[data-restatement-refresh]');
  const list = panel.querySelector('[data-restatement-items]');
  const form = panel.querySelector('[data-restatement-request]');
  const pair = form?.elements.namedItem('pair');
  const reason = form?.elements.namedItem('reason');
  let view;
  let loading;
  let saving;
  let candidates = [];

  function paragraph(text) {
    const line = document.createElement('p');
    line.textContent = text;
    return line;
  }

  async function write(current, path, body, controls, message) {
    if (view !== current || saving || loading) return;
    saving = current;
    refresh.disabled = true;
    for (const control of controls) control.disabled = true;
    error.textContent = '';
    try {
      await request(path, {orgId: current.orgId, ...body});
      if (view !== current) return;
      form?.reset();
      await load(current, message);
    } catch (failure) {
      if (view === current) error.textContent = failure.message;
    } finally {
      if (saving === current) {
        saving = undefined;
        refresh.disabled = false;
        for (const control of controls) control.disabled = false;
      }
    }
  }

  function itemRow(item, current) {
    const row = document.createElement('li');
    const title = document.createElement('strong');
    title.textContent = `${pairLabel(item)} · ${states[item.status] ?? item.status}`;
    row.append(title, paragraph(`申请原因：${item.reason}`));
    if (item.deltaKgCO2 != null) row.append(paragraph(`排放差额：${item.deltaKgCO2} kgCO₂`));
    const compare = document.createElement('button');
    compare.type = 'button';
    compare.textContent = '查看月度差额';
    const months = document.createElement('ul');
    months.className = 'history-list';
    compare.addEventListener('click', async () => {
      const query = new URLSearchParams({orgId: current.orgId, baseline: item.baselineSnapshotId, target: item.targetSnapshotId});
      compare.disabled = true;
      error.textContent = '';
      try {
        const result = await request(current.path.replace(/restatements$/, `comparison?${query}`));
        if (view !== current) return;
        months.replaceChildren(...result.items.map(month => {
          const line = document.createElement('li');
          line.textContent = `${month.period} · ${month.baselineKgCO2} → ${month.targetKgCO2} kgCO₂ · 差额 ${month.deltaKgCO2} kgCO₂`;
          return line;
        }));
      } catch (failure) {
        if (view === current) error.textContent = failure.message;
      } finally {
        compare.disabled = false;
      }
    });
    row.append(compare, months);
    if (item.reviewReason) row.append(paragraph(`审批意见：${item.reviewReason}`));
    const timing = paragraph(`申请于 ${date.format(new Date(item.createdAt))}${item.reviewedAt ? ` · 审批于 ${date.format(new Date(item.reviewedAt))}` : ''}`);
    timing.className = 'muted';
    row.append(timing);
    const links = document.createElement('div');
    links.className = 'actions';
    for (const [label, ids] of [['基准报告', item.baselineDraftIds], ['目标报告', item.targetDraftIds]]) {
      for (const [index, draftId] of (ids ?? []).entries()) {
        const link = document.createElement('a');
        link.href = internalReportHref({orgId: current.orgId, caseId: current.caseId, draftId, view: role});
        link.textContent = ids.length === 1 ? label : `${label} ${index + 1}`;
        links.append(link);
      }
    }
    if (links.children.length) row.append(links);
    if (role !== 'professional' || !item.canReview) return row;

    const review = document.createElement('form');
    const label = document.createElement('label');
    label.textContent = '审批意见（退回时必填）';
    const note = document.createElement('textarea');
    note.maxLength = 500;
    label.append(note);
    const actions = document.createElement('div');
    actions.className = 'actions';
    for (const [value, text] of [['approved', '批准重述'], ['returned', '退回申请']]) {
      const button = document.createElement('button');
      button.type = 'submit';
      button.value = value;
      button.textContent = text;
      actions.append(button);
    }
    review.append(label, actions);
    review.addEventListener('submit', event => {
      event.preventDefault();
      const decision = event.submitter?.value;
      if (!decision) return;
      const reason = note.value.trim();
      if (decision === 'returned' && !reason) {
        error.textContent = '请填写退回原因。';
        note.focus();
        return;
      }
      const path = `${current.path}/${encodeURIComponent(item.id)}/review`;
      void write(current, path, {decision, ...(reason && {reason})}, review.elements,
        decision === 'approved' ? '已批准本次重述。' : '已退回重述申请。');
    });
    row.append(review);
    return row;
  }

  async function load(current, message = '') {
    const token = Symbol();
    loading = token;
    refresh.disabled = true;
    state.textContent = '正在读取重述申请…';
    error.textContent = '';
    try {
      const data = await request(`${current.path}?${new URLSearchParams({orgId: current.orgId})}`);
      if (view !== current || loading !== token) return;
      list.replaceChildren(...data.items.map(item => itemRow(item, current)));
      list.hidden = !data.items.length;
      if (form) {
        candidates = data.candidates;
        pair.replaceChildren(new Option('请选择冻结快照组合', ''), ...candidates.map((item, index) => new Option(pairLabel(item), String(index))));
        if (candidates.length === 1) pair.value = '0';
        form.hidden = !candidates.length;
      }
      state.textContent = message || (!data.items.length
        ? form && !candidates.length ? '暂无重述申请或符合条件的快照组合。' : '暂无重述申请。' : '');
    } catch (failure) {
      if (view !== current || loading !== token) return;
      state.textContent = '';
      error.textContent = failure.message;
    } finally {
      if (loading === token) {
        loading = undefined;
        refresh.disabled = Boolean(saving);
      }
    }
  }

  refresh.addEventListener('click', () => {
    if (view && !saving && !loading) void load(view);
  });
  panel.addEventListener('toggle', () => {
    if (view && panel.open && !saving && !loading) void load(view);
  });
  form?.addEventListener('submit', event => {
    event.preventDefault();
    const current = view;
    const candidate = pair.value === '' ? null : candidates[Number(pair.value)];
    if (!current || !candidate) return;
    const explanation = reason.value.trim();
    if (!explanation) {
      error.textContent = '请填写重述原因。';
      reason.focus();
      return;
    }
    const {baselineSnapshotId, targetSnapshotId} = candidate;
    void write(current, current.path, {baselineSnapshotId, targetSnapshotId, reason: explanation}, form.elements, '重述申请已提交。');
  });

  return next => {
    if (view?.caseId === next?.caseId && view?.revision === next?.revision && view?.orgId === next?.orgId) return;
    view = next && {...next, path: `/v1/${role}/cases/${encodeURIComponent(next.caseId)}/gas-combustion/restatements`};
    loading = saving = undefined;
    candidates = [];
    panel.hidden = !view;
    panel.open = false;
    refresh.disabled = false;
    list.replaceChildren();
    list.hidden = true;
    state.textContent = error.textContent = '';
    if (form) {
      form.reset();
      for (const control of form.elements) control.disabled = false;
      pair.replaceChildren();
      form.hidden = true;
    }
  };
}
