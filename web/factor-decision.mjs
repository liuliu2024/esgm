import { request } from './shared.mjs';

const byId = id => document.getElementById(id);
const panel = byId('case-factor-decision');
const form = byId('case-factor-form');
const status = byId('case-factor-status');
const error = byId('case-factor-error');
const result = byId('case-factor-result');
const basis = byId('case-factor-basis');
const year = byId('case-factor-year');
const choice = byId('case-factor-choice');
const source = byId('case-factor-source');
const search = byId('case-factor-search');
const save = form.querySelector('[type=submit]');
let view;
let candidates = [];
let candidateRequest;

function clearCandidates() {
  candidateRequest = undefined;
  search.disabled = false;
  candidates = [];
  choice.replaceChildren(new Option('请选择查到的因子版本', ''));
  source.textContent = '';
  save.disabled = true;
}

export function showFactorDecision(context) {
  view = context;
  panel.open = false;
  panel.hidden = !view;
  form.hidden = result.hidden = true;
  status.textContent = error.textContent = '';
  result.replaceChildren();
  form.reset();
  clearCandidates();
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
  detail.textContent = `${factor.value} ${factor.outputUnit}/${factor.inputUnit} · ${factor.regionCode} · ${factor.dataYear} 年 · 因子第 ${factor.version} 版`;
  link.href = factor.sourceUrl;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = `${factor.sourceTitle} · ${factor.sourceLocator}`;
  basisNote.textContent = `适用方法：${methodReference}`;
  reason.textContent = `适用依据：${rationale}`;
  status.textContent = `第 ${submissionRevision} 版已记录 · ${new Date(decidedAt).toLocaleString('zh-CN')}`;
  result.replaceChildren(detail, link, basisNote, reason);
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
    } else {
      error.textContent = failure.message;
    }
  }
});

basis.addEventListener('change', clearCandidates);
year.addEventListener('input', clearCandidates);
choice.addEventListener('change', () => {
  const item = candidates[choice.value] ?? null;
  source.textContent = item ? `${item.sourceTitle} · ${item.sourceLocator}。${item.usageNote}` : '';
  save.disabled = !item;
});

search.addEventListener('click', async () => {
  if (!view?.canDecide || !year.reportValidity()) return;
  const current = view;
  const requestId = Symbol();
  clearCandidates();
  candidateRequest = requestId;
  search.disabled = true;
  error.textContent = '';
  source.textContent = '正在查找…';
  const params = new URLSearchParams({orgId: current.orgId, accountingBasis: basis.value,
    regionCode: 'CN', dataYear: year.value});
  try {
    const {items} = await request(`/v1/professional/factor-references?${params}`);
    if (view !== current || candidateRequest !== requestId) return;
    candidates = items;
    choice.append(...items.map((item, index) => new Option(
      `${item.value} ${item.outputUnit}/${item.inputUnit} · 因子第 ${item.version} 版`, index)));
    source.textContent = items.length ? '' : '该口径和年份暂无全国参考。';
  } catch (failure) {
    if (view !== current || candidateRequest !== requestId) return;
    source.textContent = '';
    error.textContent = failure.message;
  } finally {
    if (view === current && candidateRequest === requestId) search.disabled = false;
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
