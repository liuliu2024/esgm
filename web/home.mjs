import { getContext, request } from './shared.mjs';

const element = id => document.getElementById(id);
const industry = element('home-industry');
const scenario = element('home-scenario');
const scenarioContext = element('home-context');
const preparation = element('home-preparation');
const preparationItems = element('home-preparation-items');
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
  const previousIndustry = industry.value;
  const previousScenario = scenario.value;
  industry.disabled = true;
  scenario.disabled = true;
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
    const params = new URLSearchParams(location.search);
    const linkedCode = params.get('scenarioCode');
    const linkedScenario = linkedCode && catalog.find(item => item.code === linkedCode);
    const preferredIndustry = industries.has(previousIndustry) ? previousIndustry
      : linkedScenario?.industryCode ?? params.get('industry');
    if (industries.has(preferredIndustry)) industry.value = preferredIndustry;
    populateScenarios(previousScenario || linkedScenario?.id);
    if (industries.size && linkedCode && !linkedScenario && !previousIndustry) {
      catalogState.textContent = '链接中的场景暂不可用，请重新选择。';
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
  if (preparation && preparationItems) {
    const materials = item?.preparation?.materials ?? [];
    preparationItems.replaceChildren(...materials.map(text => {
      const row = document.createElement('li');
      row.textContent = text;
      return row;
    }));
    preparation.hidden = !materials.length;
  }
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

function populateScenarios(preselectedId) {
  const items = catalog.filter(item => item.industryCode === industry.value);
  scenario.replaceChildren(new Option(industry.value ? '请选择办理场景' : '请先选择行业', ''),
    ...items.map(item => new Option(item.title, item.id)));
  scenario.disabled = !items.length;
  if (items.some(item => item.id === preselectedId)) scenario.value = preselectedId;
  showScenario();
}

industry.addEventListener('change', () => {
  catalogState.textContent = '';
  populateScenarios();
});

scenario.addEventListener('change', showScenario);
catalogRetry.addEventListener('click', async () => {
  await loadCatalog();
  if (!industry.disabled) industry.focus();
  else if (!catalogRetry.hidden) catalogRetry.focus();
});
referenceRetry.addEventListener('click', async () => {
  const selectedId = scenario.value;
  await loadReferences();
  if (scenario.value !== selectedId) return;
  if (!referenceRetry.hidden) referenceRetry.focus();
  else (references.querySelector('a') ?? scenario).focus();
});
loadCatalog();
