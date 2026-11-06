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
const intentButtons = [...document.querySelectorAll('.intent-options [data-intent]')];
const intents = {
  buyer: {
    title: '准备买方要求的碳资料',
    note: '按买方的模板和交付口径，选择产品足迹或境外客户报告。',
    links: [['产品碳足迹资料受理', '/customer?scenarioCode=product-footprint-prep'], ['境外客户报告资料受理', '/customer?scenarioCode=overseas-report-prep']]
  },
  inventory: {
    title: '梳理企业或设施排放',
    note: '准备组织盘查，或按排放基线和减排目标整理零碳管理资料。',
    links: [['组织碳盘查准备', '/?industry=buildings&scenarioCode=building-inventory#guide'], ['零碳管理资料受理', '/customer?scenarioCode=zero-carbon-prep']]
  },
  compliance: {
    title: '准备碳核查或履约资料',
    note: '按报告凭证与修订记录准备核查，按账户、持仓和履约期间准备履约。',
    links: [['碳核查资料受理', '/customer?scenarioCode=verification-prep'], ['碳交易与履约资料受理', '/customer?scenarioCode=compliance-prep']]
  },
  disclosure: {
    title: '整理披露指标与证据',
    note: '按披露框架归集指标，或按境外客户问卷整理指定附件。',
    links: [['ESG 与可持续披露资料受理', '/customer?scenarioCode=esg-disclosure-prep'], ['境外客户报告资料受理', '/customer?scenarioCode=overseas-report-prep']]
  }
};
let orgId;
let catalog = [];
let referenceLoad = 0;

function showIntent(button) {
  const {title, note, links} = intents[button.dataset.intent];
  for (const option of intentButtons) option.setAttribute('aria-pressed', String(option === button));
  element('intent-title').textContent = title;
  element('intent-note').textContent = note;
  element('intent-links').replaceChildren(...links.map(([label, href]) => {
    const link = document.createElement('a');
    link.className = 'intent-link';
    link.href = href;
    link.textContent = label;
    return link;
  }));
}

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
for (const button of intentButtons) button.addEventListener('click', () => showIntent(button));
if (intentButtons.length) showIntent(intentButtons.find(button => button.getAttribute('aria-pressed') === 'true') ?? intentButtons[0]);
loadCatalog();
