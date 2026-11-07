import {internalReportHref, reportKind, request} from './shared.mjs';

const states = {pending: '待独立审批', approved: '已批准重开', returned: '已退回'};
const date = new Intl.DateTimeFormat('zh-CN', {timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short'});

export function bindCaseReopen(panel, role) {
  const state = panel.querySelector('[data-reopen-status]');
  const error = panel.querySelector('[data-reopen-error]');
  const impact = panel.querySelector('[data-reopen-impact]');
  const refresh = panel.querySelector('[data-reopen-refresh]');
  const application = panel.querySelector('[data-reopen-request]');
  const list = panel.querySelector('[data-reopen-requests]');
  let view;
  let loading;
  let saving;

  function paragraph(text) {
    const line = document.createElement('p');
    line.textContent = text;
    return line;
  }

  function renderImpact(data, current) {
    const version = document.createElement('strong');
    version.textContent = `${data.reportingYear} 年已锁定 · 批准第 ${data.approvedRevision} 版 · 提交第 ${data.submissionRevision} 版`;
    const counts = paragraph(`固定证据 ${data.evidenceCount} 项 · 活动数据 ${data.activityCount} 项 · 未关闭关键问题 ${data.openCriticalIssues} 项`);
    const retention = paragraph('重开会创建关联新草稿。原任务、快照及报告保留在锁定版本。');
    retention.className = 'muted';
    impact.replaceChildren(version, counts, retention);
    if (data.reports.length) {
      const reports = document.createElement('ul');
      reports.className = 'history-list';
      for (const report of data.reports) {
        const row = document.createElement('li');
        const link = document.createElement('a');
        link.href = internalReportHref({orgId: current.orgId, caseId: current.caseId, draftId: report.draftId, view: role});
        link.textContent = `${reportKind(report.mode)} · ${report.from === report.to ? report.from : `${report.from} 至 ${report.to}`}`;
        row.append(link);
        reports.append(row);
      }
      impact.append(reports);
    }
    impact.hidden = false;
  }

  async function write(current, path, input, controls, message, onSuccess) {
    if (view !== current || saving || loading) return;
    saving = current;
    refresh.disabled = true;
    for (const control of controls) control.disabled = true;
    error.textContent = '';
    try {
      const result = await request(path, {orgId: current.orgId, ...input});
      if (view !== current) return;
      onSuccess?.(result);
      await load(current, message);
    } catch (failure) {
      if (view !== current) return;
      if (failure.status === 409) await load(current, failure.message);
      else error.textContent = failure.message;
    } finally {
      if (saving === current) {
        saving = undefined;
        refresh.disabled = false;
        for (const control of controls) control.disabled = false;
      }
    }
  }

  function renderRequests(current) {
    const focusHref = list.contains(document.activeElement) ? document.activeElement.getAttribute('href') : null;
    list.replaceChildren(...current.items.map(item => {
      const row = document.createElement('li');
      const title = document.createElement('strong');
      title.textContent = `${states[item.status]} · 原批准第 ${item.approvedRevision} 版`;
      row.append(title, paragraph(`重开原因：${item.reason}`));
      if (item.reviewReason) row.append(paragraph(`审批说明：${item.reviewReason}`));
      const timing = paragraph(`申请于 ${date.format(new Date(item.createdAt))}${item.reviewedAt ? ` · 审批于 ${date.format(new Date(item.reviewedAt))}` : ''}`);
      timing.className = 'muted';
      row.append(timing);
      const path = `${current.path}/reopen-requests/${encodeURIComponent(item.requestId)}`;
      if (role === 'customer' && item.childCaseId) {
        const link = document.createElement('a');
        link.href = `/customer?${new URLSearchParams({case: item.childCaseId})}`;
        link.textContent = '打开关联任务';
        row.append(link);
      } else if (role === 'customer' && item.canCreateDraft) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = '创建关联草稿';
        button.addEventListener('click', () => void write(current, `${path}/draft`, {}, [button], '已创建关联草稿。', draft => {
          item.childCaseId = draft.id;
          item.canCreateDraft = false;
          renderRequests(current);
          list.querySelector(`a[href="/customer?${new URLSearchParams({case: draft.id})}"]`)?.focus();
        }));
        row.append(button);
      }
      if (role === 'professional' && item.canReview) {
        const form = document.createElement('form');
        const label = document.createElement('label');
        label.textContent = '审批说明（退回时必填）';
        const note = document.createElement('textarea');
        note.maxLength = 500;
        note.value = current.notes.get(item.requestId) ?? '';
        note.addEventListener('input', () => current.notes.set(item.requestId, note.value));
        label.append(note);
        const actions = document.createElement('div');
        actions.className = 'actions';
        for (const [value, text] of [['approved', '批准重开'], ['returned', '退回申请']]) {
          const button = document.createElement('button');
          button.type = 'submit';
          button.value = value;
          button.textContent = text;
          actions.append(button);
        }
        form.append(label, actions);
        form.addEventListener('submit', event => {
          event.preventDefault();
          const decision = event.submitter?.value;
          if (!decision) return;
          const reason = note.value.trim();
          if (decision === 'returned' && !reason) {
            error.textContent = '请填写退回原因。';
            note.focus();
            return;
          }
          void write(current, `${path}/review`, {decision, ...(reason && {reason})}, form.elements,
            decision === 'approved' ? '已批准重开，原任务仍锁定。' : '已退回重开申请。',
            () => current.notes.delete(item.requestId));
        });
        row.append(form);
      }
      return row;
    }));
    list.hidden = !current.items.length;
    if (focusHref) [...list.querySelectorAll('a')].find(link => link.getAttribute('href') === focusHref)?.focus();
  }

  async function load(current, message = '') {
    const token = Symbol();
    loading = token;
    refresh.disabled = true;
    state.textContent = '正在读取锁定版本和重开申请…';
    error.textContent = '';
    const query = new URLSearchParams({orgId: current.orgId});
    try {
      const [summary, requests] = await Promise.all([
        request(`${current.path}/reopen-impact?${query}`), request(`${current.path}/reopen-requests?${query}`)
      ]);
      if (view !== current || loading !== token) return;
      current.approvedRevision = summary.approvedRevision;
      current.items = requests.items;
      renderImpact(summary, current);
      renderRequests(current);
      if (application) application.hidden = !requests.canRequest;
      state.textContent = message || (!requests.items.length ? '暂无重开申请。' : '');
    } catch (failure) {
      if (view !== current || loading !== token) return;
      if ([403, 404, 409].includes(failure.status)) {
        impact.hidden = list.hidden = true;
        if (application) application.hidden = true;
      }
      state.textContent = message;
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
  application?.addEventListener('submit', event => {
    event.preventDefault();
    const current = view;
    if (!current?.approvedRevision || application.hidden) return;
    const field = application.elements.namedItem('reason');
    const reason = field.value.trim();
    if (!reason) {
      error.textContent = '请填写重开原因。';
      field.focus();
      return;
    }
    void write(current, `${current.path}/reopen-requests`, {approvedRevision: current.approvedRevision, reason},
      application.elements, '重开申请已提交。', () => { application.reset(); application.hidden = true; });
  });

  return next => {
    if (view?.caseId === next?.caseId && view?.orgId === next?.orgId) return;
    view = next && {...next, path: `/v1/${role}/cases/${encodeURIComponent(next.caseId)}`, items: [], notes: new Map()};
    loading = saving = undefined;
    panel.hidden = !view;
    panel.open = false;
    refresh.disabled = false;
    impact.replaceChildren();
    list.replaceChildren();
    impact.hidden = list.hidden = true;
    state.textContent = error.textContent = '';
    if (application) {
      application.reset();
      for (const control of application.elements) control.disabled = false;
      application.hidden = true;
    }
  };
}
