const statuses = { draft: '草稿', submitted: '待复核', returned: '待补正', approved: '已通过' };
const actions = { created: '创建受理单', submitted: '提交复核', returned: '退回补正', approved: '复核通过' };

export async function request(path, body) {
  const response = await fetch(path, body === undefined ? undefined : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (response.ok) return data;
  const error = new Error(data.error?.message ?? '请求未完成。');
  error.status = response.status;
  error.code = data.error?.code;
  throw error;
}

export const getContext = (view = 'customer') => request(`/v1/session/workspace?${new URLSearchParams({view})}`);
export const statusLabel = status => statuses[status] ?? status;
export const internalReportHref = ({orgId, caseId, draftId, view}) =>
  `/reports/internal-draft?${new URLSearchParams({orgId, case: caseId, draft: draftId, view})}`;
const evidenceStatuses = { pending_file: '待补文件', pending_scan: '待检查', passed: '检查通过', rejected: '检查未通过' };
export const evidenceStatusLabel = status => evidenceStatuses[status] ?? status;

export function renderRevisionEvidence(list, items) {
  list.replaceChildren(...items.map(({title, sourceDescription, sha256}) => {
    const row = document.createElement('li');
    const heading = document.createElement('strong');
    const source = document.createElement('p');
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    const digest = document.createElement('code');
    heading.textContent = title;
    source.textContent = sourceDescription;
    summary.textContent = `SHA-256 ${sha256.slice(0, 12)}…`;
    digest.textContent = sha256;
    details.append(summary, digest);
    row.append(heading, source, details);
    return row;
  }));
  list.hidden = !items.length;
}

export function renderCasePreparation(disclosure, caseId, preparation) {
  if (disclosure.dataset.caseId !== caseId || !preparation) disclosure.open = false;
  disclosure.dataset.caseId = caseId;
  disclosure.hidden = !preparation;
  const content = disclosure.querySelector('div');
  content.replaceChildren();
  if (!preparation) return;

  const title = document.createElement('p');
  title.textContent = `${preparation.title} · 场景第 ${preparation.version} 版`;
  content.append(title);
  for (const [label, entries] of [['准备材料', preparation.materials], ['报告要求', preparation.reportRequirements]]) {
    if (!entries.length) continue;
    const heading = document.createElement('h3');
    heading.textContent = label;
    const list = document.createElement('ul');
    list.className = 'history-list';
    for (const entry of entries) {
      const item = document.createElement('li');
      item.textContent = entry;
      list.append(item);
    }
    content.append(heading, list);
  }
}

export function renderHistory(container, events) {
  const list = document.createElement('ol');
  list.className = 'history-list';
  for (const event of events) {
    const item = document.createElement('li');
    const label = document.createElement('strong');
    label.textContent = `第 ${event.revision} 版 · ${event.correctionNote ? '补正重提' : actions[event.action] ?? event.action}`;
    item.append(label);
    if (event.reason || event.correctionNote) {
      const note = document.createElement('p');
      note.textContent = event.reason ?? event.correctionNote;
      item.append(note);
    }
    list.append(item);
  }
  container.replaceChildren(list);
}
