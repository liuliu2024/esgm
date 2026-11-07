import { request } from './shared.mjs';

export const factorDisclosureLabel = scope => ({
  source_and_value: '可披露来源与数值', summary_only: '仅可披露汇总排放', internal_only: '仅限内部使用'
})[scope] ?? '';

export function bindFactorRegions({basis, year, region, search, status, error, retry, getOrgId, clearResults}) {
  let sequence = 0;

  function reset() {
    sequence += 1;
    clearResults();
    region.replaceChildren(new Option('请选择地域', ''));
    region.disabled = search.disabled = true;
    retry.hidden = true;
    status.textContent = error.textContent = '';
  }

  async function load() {
    reset();
    const orgId = getOrgId();
    if (!orgId) return;
    if (!year.value || !year.validity.valid) {
      status.textContent = '请先填写有效的因子数据年份。';
      return;
    }
    const current = sequence;
    status.textContent = '正在读取适用地域…';
    try {
      const query = new URLSearchParams({orgId, accountingBasis: basis.value, dataYear: year.value});
      const {items} = await request(`/v1/professional/factor-reference-regions?${query}`);
      if (sequence !== current) return;
      region.append(...items.map(item => new Option(item.regionName, item.regionCode)));
      region.disabled = !items.length;
      if (items.some(item => item.regionCode === 'CN')) region.value = 'CN';
      search.disabled = !region.value;
      status.textContent = items.length ? '' : '该核算口径和年份暂无可选地域。';
    } catch (failure) {
      if (sequence !== current) return;
      status.textContent = '';
      error.textContent = failure.message;
      retry.hidden = false;
    }
  }

  basis.addEventListener('change', load);
  year.addEventListener(year.tagName === 'INPUT' ? 'input' : 'change', load);
  region.addEventListener('change', () => {
    clearResults();
    search.disabled = !region.value;
  });
  retry.addEventListener('click', async () => {
    await load();
    if (!retry.hidden) retry.focus();
    else if (!region.disabled) region.focus();
  });
  return {load, reset};
}

const byId = id => document.getElementById(id);
const panel = byId('case-factor-decision');
const form = byId('case-factor-form');
const status = byId('case-factor-status');
const error = byId('case-factor-error');
const result = byId('case-factor-result');
const basis = byId('case-factor-basis');
const year = byId('case-factor-year');
const region = byId('case-factor-region');
const choice = byId('case-factor-choice');
const source = byId('case-factor-source');
const search = byId('case-factor-search');
const save = form.querySelector('[type=submit]');
let view;
let candidates = [];
let candidateRequest;

function clearCandidates() {
  candidateRequest = undefined;
  candidates = [];
  choice.replaceChildren(new Option('请选择查到的因子版本', ''));
  source.textContent = '';
  error.textContent = '';
  save.disabled = true;
}

const regions = bindFactorRegions({basis, year, region, search, status: byId('case-factor-region-status'),
  error: byId('case-factor-region-error'), retry: byId('case-factor-region-retry'),
  getOrgId: () => view?.canDecide && view.orgId, clearResults: clearCandidates});

export function showFactorDecision(context) {
  view = context;
  panel.open = false;
  panel.hidden = !view;
  form.hidden = result.hidden = true;
  status.textContent = error.textContent = '';
  result.replaceChildren();
  form.reset();
  regions.reset();
}

function decisionPath(current) {
  return `${current.base}/revisions/${current.revision}/factor-decision`;
}

function renderDecision({factor, methodReference, rationale, decidedAt, submissionRevision}) {
  view.canDecide = false;
  const detail = document.createElement('p');
  const link = document.createElement('a');
  const basisNote = document.createElement('p');
  const reason = document.createElement('p');
  const regionName = region.value === factor.regionCode ? region.selectedOptions[0].textContent
    : factor.regionCode === 'CN' ? '全国' : factor.regionCode;
  detail.textContent = `${factor.value} ${factor.outputUnit}/${factor.inputUnit} · ${regionName} · ${factor.dataYear} 年 · 因子第 ${factor.version} 版`;
  link.href = factor.sourceUrl;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = `${factor.sourceTitle} · ${factor.sourceLocator}`;
  basisNote.textContent = `适用方法：${methodReference}`;
  reason.textContent = `适用依据：${rationale}`;
  status.textContent = `第 ${submissionRevision} 版已记录 · ${new Date(decidedAt).toLocaleString('zh-CN')}`;
  result.replaceChildren(detail, link, basisNote, reason);
  const disclosure = factorDisclosureLabel(factor.disclosureScope);
  if (disclosure) {
    const scope = document.createElement('p');
    scope.className = 'muted';
    scope.textContent = `披露范围 · ${disclosure}`;
    result.append(scope);
  }
  result.hidden = false;
  form.hidden = true;
}

panel.addEventListener('toggle', async () => {
  const current = view;
  if (!current || !panel.open) return;
  status.textContent = '正在读取因子决定…';
  error.textContent = '';
  try {
    const {decision} = await request(`${decisionPath(current)}?${new URLSearchParams({orgId: current.orgId})}`);
    if (view === current) renderDecision(decision);
  } catch (failure) {
    if (view !== current) return;
    status.textContent = '';
    if (failure.code === 'FACTOR_DECISION_NOT_FOUND') {
      status.textContent = `第 ${current.revision} 版尚无因子决定。`;
      form.hidden = !current.canDecide;
      if (current.canDecide) void regions.load();
    } else {
      error.textContent = failure.message;
    }
  }
});

choice.addEventListener('change', () => {
  const item = candidates[choice.value] ?? null;
  const disclosure = factorDisclosureLabel(item?.disclosureScope);
  source.textContent = item ? [item.sourceTitle, item.sourceLocator, item.usageNote, disclosure].filter(Boolean).join(' · ') : '';
  save.disabled = !item;
});

search.addEventListener('click', async () => {
  if (!view?.canDecide || !year.reportValidity() || !region.value || search.disabled) return;
  const current = view;
  const requestId = Symbol();
  clearCandidates();
  candidateRequest = requestId;
  search.disabled = true;
  source.textContent = '正在查找…';
  const params = new URLSearchParams({orgId: current.orgId, accountingBasis: basis.value,
    regionCode: region.value, dataYear: year.value});
  try {
    const {items} = await request(`/v1/professional/factor-references?${params}`);
    if (view !== current || candidateRequest !== requestId) return;
    candidates = items;
    choice.append(...items.map((item, index) => new Option(
      `${item.value} ${item.outputUnit}/${item.inputUnit} · 因子第 ${item.version} 版`, index)));
    source.textContent = items.length ? '' : '该核算口径、年份和地域暂无因子参考。';
  } catch (failure) {
    if (view !== current || candidateRequest !== requestId) return;
    source.textContent = '';
    error.textContent = failure.message;
  } finally {
    if (view === current && candidateRequest === requestId) search.disabled = !region.value;
  }
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  const current = view;
  const factor = candidates[choice.value];
  if (!current?.canDecide || current.saving || !factor || save.disabled) return;
  current.saving = true;
  save.disabled = true;
  error.textContent = '';
  const {factorId, version: factorVersion, accountingBasis, regionCode, dataYear} = factor;
  try {
    const {decision} = await request(decisionPath(current), {orgId: current.orgId,
      factorId, factorVersion, accountingBasis, regionCode, dataYear,
      methodReference: byId('case-factor-method').value, rationale: byId('case-factor-rationale').value});
    if (view === current) renderDecision(decision);
  } catch (failure) {
    if (view === current) {
      error.textContent = failure.message;
      save.disabled = !candidates[choice.value];
    }
  } finally {
    current.saving = false;
  }
});
