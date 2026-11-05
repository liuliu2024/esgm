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

export const getContext = () => request('/demo/context');
export const statusLabel = status => statuses[status] ?? status;

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
