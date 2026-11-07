import {request} from './shared.mjs';

const states = {open: '待企业答复', answered: '待专业复核', closed: '已关闭'};
const severities = {low: '较低', normal: '一般', critical: '关键'};
const events = {opened: '发起问题', replied: '企业答复', request_follow_up: '要求补充', closed: '关闭问题'};
const actions = {reply: '提交答复', 'request-follow-up': '要求补充', close: '关闭问题'};
const timestamp = new Intl.DateTimeFormat('zh-CN', {dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Shanghai'});

export function bindReviewIssues(panel, role) {
  const state = panel.querySelector('[data-issue-state]');
  const error = panel.querySelector('[data-issue-error]');
  const refresh = panel.querySelector('[data-issue-refresh]');
  const list = panel.querySelector('[data-issue-items]');
  const create = panel.querySelector('[data-issue-open]');
  const evidencePicker = create?.elements.namedItem('evidenceId');
  const revisionHeading = panel.querySelector('[data-issue-revision]');
  let view;
  let reading;
  let saving;

  function paragraph(text) {
    const line = document.createElement('p');
    line.textContent = text;
    return line;
  }

  function renderOpenForm() {
    if (!create) return;
    const revision = view?.submissionRevision;
    create.hidden = !view?.canOpen || !revision;
    if (create.hidden) return;
    revisionHeading.textContent = `为提交第 ${revision} 版发起问题`;
    const selected = evidencePicker.value;
    const items = view.evidence.get(revision) ?? [];
    evidencePicker.replaceChildren(new Option('不附证据', ''), ...items.map(item => new Option(item.title, item.evidenceId)));
    if (items.some(item => item.evidenceId === selected)) evidencePicker.value = selected;
    evidencePicker.disabled = !items.length;
  }

  function renderItem(item, current, expanded) {
    const row = document.createElement('li');
    const detail = document.createElement('details');
    detail.dataset.issueId = item.issueId;
    detail.open = expanded;
    const title = document.createElement('summary');
    title.textContent = `${item.title} · ${states[item.status]} · ${severities[item.severity]} · ${item.overdue ? '已逾期' : `到期 ${item.dueDate}`} · 提交第 ${item.submissionRevision} 版`;
    detail.append(title, paragraph(item.description));
    if (item.overdue) detail.append(paragraph(`原到期日：${item.dueDate}（北京时间）`));
    if (item.evidenceId) {
      const material = current.evidence.get(item.submissionRevision)?.find(entry => entry.evidenceId === item.evidenceId);
      detail.append(paragraph(`固定证据：${material?.title ?? item.evidenceId}`));
    }
    const history = document.createElement('ol');
    history.className = 'history-list';
    for (const event of item.events) {
      const entry = document.createElement('li');
      entry.textContent = `${events[event.action] ?? event.action} · ${timestamp.format(new Date(event.createdAt))}${event.note ? ` · ${event.note}` : ''}`;
      history.append(entry);
    }
    detail.append(history);
    const saved = current.notes.get(item.issueId) ?? '';
    if (item.nextActions.length) {
      const form = document.createElement('form');
      const label = document.createElement('label');
      label.textContent = role === 'customer' ? '答复说明' : '处理说明或关闭结论';
      const note = document.createElement('textarea');
      note.maxLength = 1000;
      note.required = true;
      note.value = saved;
      label.append(note);
      const buttons = document.createElement('div');
      buttons.className = 'actions';
      for (const action of item.nextActions) {
        const button = document.createElement('button');
        button.type = 'submit';
        button.value = action;
        button.textContent = actions[action];
        buttons.append(button);
      }
      note.addEventListener('input', () => current.notes.set(item.issueId, note.value));
      form.addEventListener('submit', event => {
        event.preventDefault();
        const action = event.submitter?.value;
        const text = note.value.trim();
        if (!action || !text) {
          if (!text) { error.textContent = '请填写处理说明。'; note.focus(); }
          return;
        }
        const path = `${current.path}/${encodeURIComponent(item.issueId)}/${action}`;
        void write(current, path, {expectedVersion: item.version, note: text}, () => current.notes.delete(item.issueId), form.elements);
      });
      form.append(label, buttons);
      detail.append(form);
    } else if (saved) {
      detail.append(paragraph(`未提交的说明：${saved}`));
    }
    row.append(detail);
    return row;
  }

  async function load(current, message = '') {
    const token = Symbol();
    reading = token;
    refresh.disabled = true;
    state.textContent = '正在读取复核问题…';
    error.textContent = '';
    try {
      const data = await request(`${current.path}?${new URLSearchParams({orgId: current.orgId})}`);
      if (view !== current || reading !== token) return;
      current.canOpen = data.canOpen;
      current.items = data.items;
      renderItems(current);
      renderOpenForm();
      state.textContent = message || (!data.items.length ? '本任务暂无复核问题。' : '');
    } catch (failure) {
      if (view !== current || reading !== token) return;
      state.textContent = message;
      error.textContent = failure.message;
    } finally {
      if (reading === token) {
        reading = undefined;
        refresh.disabled = Boolean(saving);
      }
    }
  }

  function renderItems(current) {
    const expanded = new Set([...list.querySelectorAll('details[open]')].map(item => item.dataset.issueId));
    list.replaceChildren(...current.items.map(item => renderItem(item, current, expanded.has(item.issueId))));
    list.hidden = !current.items.length;
  }

  async function write(current, path, input, clearSaved, controls) {
    if (view !== current || reading || saving) return;
    saving = current;
    refresh.disabled = true;
    const buttons = [...controls].filter(control => control.type === 'submit');
    for (const button of buttons) button.disabled = true;
    error.textContent = '';
    try {
      await request(path, {orgId: current.orgId, ...input});
      if (view !== current) return;
      clearSaved();
      await load(current, '处理记录已保存。');
    } catch (failure) {
      if (view !== current) return;
      if (failure.status === 409) {
        await load(current, '问题或版本已更新，未提交的说明已保留。');
      } else error.textContent = failure.message;
    } finally {
      if (saving === current) {
        saving = undefined;
        refresh.disabled = false;
        for (const button of buttons) button.disabled = false;
      }
    }
  }

  panel.addEventListener('toggle', () => {
    if (panel.open && view && !reading && !saving) void load(view);
  });
  refresh.addEventListener('click', () => {
    if (view && !reading && !saving) void load(view);
  });
  create?.addEventListener('submit', event => {
    event.preventDefault();
    const current = view;
    if (!current?.canOpen || !current.submissionRevision) return;
    const {title, description, severity, dueDate, evidenceId} = Object.fromEntries(new FormData(create));
    if (!title.trim() || !description.trim()) {
      error.textContent = '请填写问题标题和说明。';
      return;
    }
    void write(current, current.path, {submissionRevision: current.submissionRevision, title: title.trim(),
      description: description.trim(), severity, dueDate, ...(evidenceId && {evidenceId})}, () => create.reset(), create.elements);
  });

  return {
    show(next) {
      if (view?.caseId === next?.caseId && view?.orgId === next?.orgId) return;
      view = next && {...next, path: `/v1/${role}/cases/${encodeURIComponent(next.caseId)}/review-issues`,
        items: [], notes: new Map(), evidence: new Map()};
      reading = saving = undefined;
      panel.open = false;
      panel.hidden = !view;
      refresh.disabled = false;
      list.replaceChildren();
      list.hidden = true;
      state.textContent = error.textContent = '';
      if (create) {
        create.reset();
        create.hidden = true;
        create.querySelector('[type=submit]').disabled = false;
      }
    },
    setRevision(revision) {
      if (!view || view.submissionRevision === revision) return;
      view.submissionRevision = revision;
      evidencePicker.value = '';
      renderOpenForm();
    },
    setEvidence(revision, items) {
      if (!view) return;
      view.evidence.set(revision, items);
      if (view.submissionRevision === revision) renderOpenForm();
    }
  };
}
