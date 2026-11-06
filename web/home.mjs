import { getContext, request } from './shared.mjs';

const element = id => document.getElementById(id);
const industry = element('home-industry');
const scenario = element('home-scenario');
const scenarioContext = element('home-context');
const create = element('home-create');
const references = element('home-references');
const catalogState = element('home-catalog-state');
const catalogError = element('home-catalog-error');
const catalogRetry = element('home-catalog-retry');
const referenceState = element('home-reference-state');
const referenceError = element('home-reference-error');
const referenceRetry = element('home-reference-retry');
let orgId;
let catalog = [];
let referenceLoad = 0;

async function loadCatalog() {
  industry.disabled = true;
  catalogRetry.hidden = true;
  catalogState.textContent = '正在读取行业场景…';
  catalogError.textContent = '';
  try {
    ({orgId} = await getContext());
    const {items} = await request(`/v1/customer/scenarios?${new URLSearchParams({orgId})}`);
    catalog = items;
    const industries = new Map(catalog.map(item => [item.industryCode, item.industryName]));
    industry.replaceChildren(new Option('请选择行业', ''), ...Array.from(industries, ([code, name]) => new Option(name, code)));
    industry.disabled = !industries.size;
    catalogState.textContent = industries.size ? '' : '暂无可办理的行业场景。';
    const linkedIndustry = new URLSearchParams(location.search).get('industry');
    if (industries.has(linkedIndustry)) {
      industry.value = linkedIndustry;
      industry.dispatchEvent(new Event('change'));
    }
  } catch (error) {
    catalogState.textContent = '';
    catalogError.textContent = error.message;
    catalogRetry.hidden = false;
  }
}

function showScenario() {
  const item = catalog.find(candidate => candidate.id === scenario.value);
  referenceLoad += 1;
  references.replaceChildren();
  referenceState.textContent = '';
  referenceError.textContent = '';
  referenceRetry.hidden = true;
  scenarioContext.hidden = !item;
  element('home-context-empty').hidden = Boolean(item);
  create.hidden = !item;
  if (!item) {
    create.removeAttribute('href');
    return;
  }
  element('home-scenario-title').textContent = item.title;
  element('home-scenario-purpose').textContent = item.purpose;
  element('home-scenario-recipient').textContent = item.recipient;
  create.href = `/customer?${new URLSearchParams({scenario: item.id})}`;
  loadReferences();
}

async function loadReferences() {
  const scenarioId = scenario.value;
  if (!scenarioId) return;
  const load = ++referenceLoad;
  referenceState.textContent = '正在读取参考资料…';
  referenceError.textContent = '';
  referenceRetry.hidden = true;
  try {
    const {items} = await request(`/v1/customer/scenarios/${scenarioId}/references?${new URLSearchParams({orgId})}`);
    if (load !== referenceLoad) return;
    references.replaceChildren(...items.map(({title, sourceUrl, publisher, scopeNote}) => {
      const row = document.createElement('li');
      const url = new URL(sourceUrl);
      const link = document.createElement('a');
      link.textContent = title;
      link.href = url.href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      const details = document.createElement('p');
      details.textContent = `${publisher} · ${url.hostname} · ${scopeNote}`;
      row.append(link, details);
      return row;
    }));
    referenceState.textContent = items.length ? '' : '暂无参考资料。';
  } catch (error) {
    if (load !== referenceLoad) return;
    referenceState.textContent = '';
    referenceError.textContent = error.message;
    referenceRetry.hidden = false;
  }
}

industry.addEventListener('change', () => {
  const items = catalog.filter(item => item.industryCode === industry.value);
  scenario.replaceChildren(new Option(industry.value ? '请选择办理场景' : '请先选择行业', ''),
    ...items.map(item => new Option(item.title, item.id)));
  scenario.disabled = !items.length;
  showScenario();
});

scenario.addEventListener('change', showScenario);
catalogRetry.addEventListener('click', async () => {
  await loadCatalog();
  if (!industry.disabled) industry.focus();
  else if (!catalogRetry.hidden) catalogRetry.focus();
});
referenceRetry.addEventListener('click', async () => {
  await loadReferences();
  if (!referenceRetry.hidden) referenceRetry.focus();
  else references.querySelector('a')?.focus();
});
loadCatalog();
