import { getContext, renderHistory, request, statusLabel } from '/shared.mjs';

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
const drafts = new Map();
let orgId;
let selected;
let cursor;
let viewing;
let saving = false;

function setStatus(element, status) {
  element.dataset.status = status;
  element.textContent = statusLabel(status);
}

function drawCase(item, canReview) {
  setStatus(document.querySelector('#case-status'), item.status);
  document.querySelector('#case-revision').textContent = `第 ${item.revision} 版`;
  document.querySelector('#purpose').textContent = item.purpose;
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
    drawCase(current, canReview);
    renderHistory(history, events);
    if (focus) document.querySelector('#detail-heading').focus();
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
try {
  ({ orgId } = await getContext());
  await loadQueue();
} catch (error) {
  workspaceError.textContent = error.message;
  queueStatus.textContent = '';
  refreshButton.disabled = true;
}
