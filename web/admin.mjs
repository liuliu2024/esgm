import { getContext, request, statusLabel } from '/shared.mjs';

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

const impactPanel = document.querySelector('#rule-impact-panel');
const impactForm = document.querySelector('#rule-impact-form');
const impactScenario = document.querySelector('#rule-impact-scenario');
const impactReference = document.querySelector('#rule-impact-reference');
const impactFields = document.querySelector('#rule-impact-fields');
const impactPublication = document.querySelector('#rule-impact-publication');
const impactNote = document.querySelector('#rule-impact-note');
const impactPreview = document.querySelector('#rule-impact-preview');
const impactStatus = document.querySelector('#rule-impact-status');
const impactError = document.querySelector('#rule-impact-error');
const impactResult = document.querySelector('#rule-impact-result');
const impactChanges = document.querySelector('#rule-impact-changes');
const impactCounts = document.querySelector('#rule-impact-counts');
const impactNoTasks = document.querySelector('#rule-impact-no-tasks');
const impactDependencies = document.querySelector('#rule-impact-dependencies');
const catalogRetry = document.querySelector('#rule-catalog-retry');
const proposalSubmit = document.querySelector('#rule-proposal-submit');
const proposalsPanel = document.querySelector('#rule-proposals-panel');
const proposalsStatus = document.querySelector('#rule-proposals-status');
const proposalsError = document.querySelector('#rule-proposals-error');
const proposalsList = document.querySelector('#rule-proposals-list');
const proposalsRefresh = document.querySelector('#rule-proposals-refresh');
const proposalStates = {submitted: '待独立审批', approved: '已审批 · 待发布', returned: '已退回', published: '已发布'};
let ruleCatalog;
let loadingCatalog = false;
let impactRequest;
let impactProposal;
let submittingProposal = false;

function clearRuleImpact() {
  impactRequest = undefined;
  impactProposal = undefined;
  proposalSubmit.hidden = true;
  impactResult.hidden = true;
  impactChanges.replaceChildren();
  impactCounts.replaceChildren();
  impactStatus.textContent = impactError.textContent = '';
  impactPreview.disabled = false;
}

async function loadRuleCatalog() {
  if (!orgId || ruleCatalog || loadingCatalog) return;
  loadingCatalog = true;
  catalogRetry.hidden = true;
  impactError.textContent = '';
  impactStatus.textContent = '正在读取规则目录…';
  try {
    const {items} = await request(`/v1/admin/organizations/${orgId}/rule-catalog`);
    ruleCatalog = items;
    impactScenario.replaceChildren(new Option('请选择场景版本', ''), ...items.map(item =>
      new Option(`${item.title} · 第 ${item.scenarioVersion} 版`, item.scenarioReleaseId)));
    impactForm.hidden = !items.length;
    impactStatus.textContent = items.length ? '' : '暂无已发布场景版本。';
  } catch (error) {
    impactStatus.textContent = '';
    impactError.textContent = error.message;
    catalogRetry.hidden = false;
  } finally {
    loadingCatalog = false;
  }
}

function selectImpactReference() {
  clearRuleImpact();
  const scenario = ruleCatalog.find(item => item.scenarioReleaseId === impactScenario.value);
  const reference = scenario?.references.find(item => item.code === impactReference.value);
  impactFields.hidden = !reference;
  impactPublication.value = reference?.publicationStatus ?? '';
  impactNote.value = reference?.scopeNote ?? '';
  impactNote.setCustomValidity('');
  if (scenario && !scenario.references.length) impactStatus.textContent = '该场景版本暂无可比较的参考规则。';
}

function renderRuleImpact({scenarioVersion, changes, taskCounts, dependencies}, proposed) {
  if (!changes.length) {
    impactStatus.textContent = '与现有规则一致。';
    return;
  }
  const labels = {added: '新增', changed: '变更', removed: '移除'};
  impactChanges.replaceChildren(...changes.map(({code, type, before, after}) => {
    const row = document.createElement('li');
    const title = document.createElement('strong');
    title.textContent = `${after?.title ?? before?.title ?? code} · ${labels[type]}`;
    row.append(title);
    for (const [label, reference] of [['现有', before], ['拟议', after]]) {
      if (!reference) continue;
      const note = document.createElement('p');
      const publication = [...impactPublication.options].find(option => option.value === reference.publicationStatus);
      note.textContent = `${label} · ${publication?.textContent ?? '状态未核实'} · ${reference.scopeNote}`;
      row.append(note);
    }
    return row;
  }));
  impactCounts.replaceChildren(...taskCounts.map(({status, count}) => {
    const row = document.createElement('li');
    row.textContent = `${statusLabel(status)} · ${count} 项`;
    return row;
  }));
  impactNoTasks.hidden = Boolean(taskCounts.length);
  impactDependencies.textContent = dependencies
    ? `关联因子 ${dependencies.factorCount} · 模型 ${dependencies.modelCount} · 报告 ${dependencies.reportCount}` : '';
  impactResult.hidden = false;
  impactStatus.textContent = `场景第 ${scenarioVersion} 版 · ${changes.length} 项差异`;
  impactProposal = proposed;
  proposalSubmit.hidden = false;
  proposalSubmit.disabled = submittingProposal;
}

impactPanel.addEventListener('toggle', () => {
  if (impactPanel.open) void loadRuleCatalog();
});
catalogRetry.addEventListener('click', () => void loadRuleCatalog());
impactScenario.addEventListener('change', () => {
  const scenario = ruleCatalog.find(item => item.scenarioReleaseId === impactScenario.value);
  const references = scenario?.references ?? [];
  impactReference.replaceChildren(new Option('请选择参考规则', ''), ...references.map(item => new Option(item.title, item.code)));
  impactReference.disabled = !references.length;
  if (references.length === 1) impactReference.value = references[0].code;
  selectImpactReference();
});
impactReference.addEventListener('change', selectImpactReference);
impactPublication.addEventListener('change', clearRuleImpact);
impactNote.addEventListener('input', () => {
  impactNote.setCustomValidity('');
  clearRuleImpact();
});
impactForm.addEventListener('submit', async event => {
  event.preventDefault();
  const scenario = ruleCatalog.find(item => item.scenarioReleaseId === impactScenario.value);
  if (!scenario || !impactReference.value || impactRequest) return;
  const scopeNote = impactNote.value.trim();
  impactNote.setCustomValidity(scopeNote ? '' : '请填写拟议适用说明。');
  if (!impactForm.reportValidity()) return;
  const references = scenario.references.map(item => item.code === impactReference.value
    ? {...item, scopeNote, publicationStatus: impactPublication.value} : item);
  clearRuleImpact();
  const token = Symbol();
  impactRequest = token;
  impactPreview.disabled = true;
  impactStatus.textContent = '正在预览影响…';
  try {
    const proposed = {scenarioReleaseId: scenario.scenarioReleaseId, references};
    const result = await request(`/v1/admin/organizations/${orgId}/rule-impact`, proposed);
    if (impactRequest === token) renderRuleImpact(result, proposed);
  } catch (error) {
    if (impactRequest === token) {
      impactStatus.textContent = '';
      impactError.textContent = error.message;
    }
  } finally {
    if (impactRequest === token) {
      impactRequest = undefined;
      impactPreview.disabled = false;
    }
  }
});

async function loadProposals() {
  if (!orgId || proposalsRefresh.disabled) return;
  proposalsRefresh.disabled = true;
  proposalsStatus.textContent = '正在读取草案进度…';
  proposalsError.textContent = '';
  try {
    const {items} = await request(`/v1/admin/organizations/${orgId}/rule-proposals`);
    proposalsList.replaceChildren(...items.map(item => {
      const row = document.createElement('li');
      const heading = document.createElement('strong');
      heading.textContent = `${item.title} · 第 ${item.scenarioVersion} 版 · ${proposalStates[item.status] ?? item.status}`;
      const meta = document.createElement('p');
      meta.className = 'muted';
      meta.textContent = dateFormat.format(new Date(item.createdAt));
      row.append(heading, meta);
      if (item.reviewNote) {
        const note = document.createElement('p');
        note.textContent = item.reviewNote;
        row.append(note);
      }
      return row;
    }));
    proposalsList.hidden = !items.length;
    proposalsStatus.textContent = items.length ? '' : '本组织暂无规则草案。';
  } catch (error) {
    proposalsStatus.textContent = '';
    proposalsError.textContent = error.message;
  } finally {
    proposalsRefresh.disabled = false;
  }
}

proposalsPanel.addEventListener('toggle', () => {
  if (proposalsPanel.open) void loadProposals();
});
proposalsRefresh.addEventListener('click', () => void loadProposals());
proposalSubmit.addEventListener('click', async () => {
  const proposal = impactProposal;
  if (!proposal || submittingProposal) return;
  proposalSubmit.disabled = submittingProposal = true;
  impactError.textContent = '';
  try {
    await request(`/v1/admin/organizations/${orgId}/rule-proposals`, proposal);
    if (impactProposal === proposal) {
      impactProposal = undefined;
      proposalSubmit.hidden = true;
      impactStatus.textContent = '已提交独立审批。';
    }
    if (proposalsPanel.open) void loadProposals();
    else proposalsPanel.open = true;
  } catch (error) {
    if (impactProposal === proposal) impactError.textContent = error.message;
  } finally {
    proposalSubmit.disabled = submittingProposal = false;
  }
});

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
  ({ orgId } = await getContext('admin'));
  if (impactPanel.open) void loadRuleCatalog();
  if (proposalsPanel.open) void loadProposals();
  await loadAudit(0);
} catch (error) {
  alert.textContent = error.message;
  status.textContent = '';
  refresh.disabled = true;
}
