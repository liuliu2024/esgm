import { getContext, request } from '/shared.mjs';

const rows = document.querySelector('#audit-rows');
const table = document.querySelector('#audit-table');
const alert = document.querySelector('#audit-error');
const status = document.querySelector('#audit-status');
const refresh = document.querySelector('#refresh-audit');
const pagination = document.querySelector('#audit-pagination');
const previous = document.querySelector('#previous-page');
const next = document.querySelector('#next-page');
const pageNumber = document.querySelector('#page-number');
const actions = { created: '创建受理单', submitted: '提交复核', returned: '退回补正', approved: '复核通过' };
const dateFormat = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short'
});
const limit = 10;
let orgId;
let offset = 0;
let nextOffset = null;

async function loadAudit(target) {
  refresh.disabled = previous.disabled = next.disabled = true;
  alert.textContent = '';
  try {
    const query = new URLSearchParams({ limit, offset: target });
    const page = await request(`/v1/admin/organizations/${orgId}/audit?${query}`);
    offset = target;
    nextOffset = page.nextOffset;
    const items = page.events.map(event => {
      const row = document.createElement('tr');
      const values = [
        dateFormat.format(new Date(event.createdAt)),
        event.caseId,
        event.revision,
        event.correctionNote ? '补正重提' : actions[event.action] ?? event.action,
        event.reason ?? event.correctionNote ?? '—'
      ];
      for (const value of values) {
        const cell = document.createElement('td');
        cell.textContent = value;
        row.append(cell);
      }
      return row;
    });
    rows.replaceChildren(...items);
    table.hidden = items.length === 0;
    status.textContent = table.hidden ? '暂无审计记录' : '';
    pagination.hidden = offset === 0 && nextOffset === null;
    pageNumber.textContent = `第 ${offset / limit + 1} 页`;
  } catch (error) {
    alert.textContent = error.message;
    status.textContent = '';
  } finally {
    refresh.disabled = false;
    previous.disabled = offset === 0;
    next.disabled = nextOffset === null;
  }
}

refresh.addEventListener('click', () => void loadAudit(0));
previous.addEventListener('click', () => void loadAudit(Math.max(0, offset - limit)));
next.addEventListener('click', () => {
  if (nextOffset !== null) void loadAudit(nextOffset);
});
try {
  ({ orgId } = await getContext());
  await loadAudit(0);
} catch (error) {
  alert.textContent = error.message;
  status.textContent = '';
  refresh.disabled = true;
}
