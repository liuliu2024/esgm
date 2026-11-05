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
const historyEvents = element('history-events');
const actionError = element('action-error');
const feedback = element('feedback');
const evidenceState = element('evidence-state');
const evidenceItems = element('evidence-items');
const evidenceForm = element('register-evidence');
const evidenceError = element('evidence-error');
const base = '/v1/customer/cases';
const notes = new Map();
let context;
let cases = [];
let selected;
let cursor;
let creating = false;
let busy = false;
let evidenceLoad = 0;

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

list.addEventListener('click', event => {
  const button = event.target.closest('button[data-id]');
  if (!button) return;
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
  loadEvidence();
});

newCase.addEventListener('click', () => {
  creating = true;
  element('create-error').textContent = '';
  renderList();
  renderDetail();
  element('purpose').focus();
});

element('cancel-create').addEventListener('click', () => {
  creating = false;
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
    const item = await request(base, {
      orgId: context.orgId,
      scenarioReleaseId: element('scenario').value,
      purpose: element('purpose').value
    });
    creating = false;
    element('purpose').value = '';
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
  element('scenario').options[0].value = context.scenarioReleaseId;
  await loadPage();
  newCase.disabled = false;
  refresh.disabled = false;
} catch (error) {
  listState.textContent = '无法读取受理单';
  feedback.textContent = error.message;
}
