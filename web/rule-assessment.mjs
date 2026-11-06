import { request } from './shared.mjs';

const publicationLabels = {
  effective: '现行', pilot: '试点', draft: '草案', superseded: '已替代', expired: '已失效', unclassified: '状态未核实'
};
const subjectLabels = {organization: '组织', facility: '设施', product: '产品', project: '项目'};

export function bindRuleAssessment(panel) {
  const state = panel.querySelector('[data-rule-state]');
  const error = panel.querySelector('[data-rule-error]');
  const content = panel.querySelector('[data-rule-content]');
  const form = panel.querySelector('[data-rule-form]');
  const choice = form?.querySelector('[data-rule-choice]');
  const outcome = form?.elements.namedItem('status');
  const reference = form?.elements.namedItem('referenceCode');
  const rationale = form?.elements.namedItem('rationale');
  const save = form?.querySelector('[type=submit]');
  let view;
  let reading;
  let saving;

  function paragraph(text, className) {
    const element = document.createElement('p');
    element.textContent = text;
    if (className) element.className = className;
    return element;
  }

  function updateChoice() {
    const confirming = outcome.value === 'confirmed';
    choice.hidden = !confirming;
    reference.disabled = !confirming;
    reference.required = confirming;
  }

  function render(result, current) {
    const {scenarioVersion, submissionRevision, status, context, candidates, gaps, decision, recalculation, recalculationOf} = result;
    const version = `场景第 ${scenarioVersion} 版${submissionRevision ? ` · 提交第 ${submissionRevision} 版` : ''}`;
    const resultLabel = status === 'confirmed' ? '已确认内部适用规则' : decision ? '已记录待核实' : '适用性待核实';
    state.textContent = `${resultLabel} · ${version}`;
    const scope = [context.industryName, subjectLabels[context.subjectType], context.jurisdiction,
      context.reportingYear && `${context.reportingYear} 年`, context.purpose].filter(Boolean);
    const details = [];
    if (!form && recalculationOf) {
      const source = document.createElement('a');
      source.href = `/customer?${new URLSearchParams({case: recalculationOf})}`;
      source.textContent = '查看原任务';
      details.push(source);
    }
    if (!form && recalculation) {
      const start = document.createElement('button');
      start.type = 'button';
      start.textContent = `按场景第 ${recalculation.scenarioVersion} 版创建重算任务`;
      start.addEventListener('click', async () => {
        start.disabled = true;
        error.textContent = '';
        try {
          const task = await request(`${current.base}/rule-recalculation`,
            {orgId: current.orgId, scenarioReleaseId: recalculation.scenarioReleaseId});
          if (view === current) location.assign(`/customer?${new URLSearchParams({case: task.id})}`);
        } catch (failure) {
          if (view === current) error.textContent = failure.message;
        } finally {
          start.disabled = false;
        }
      });
      details.push(start, paragraph('新任务保留原申报范围。请核对并重新提交所需活动数据。', 'muted'));
    }
    if (scope.length) details.push(paragraph(scope.join(' · '), 'muted'));
    if (gaps.length) {
      const list = document.createElement('ul');
      for (const gap of gaps) {
        const item = document.createElement('li');
        item.textContent = gap;
        list.append(item);
      }
      details.push(paragraph('待核对事项'), list);
    }
    if (decision) {
      const selected = candidates.find(candidate => candidate.code === decision.referenceCode);
      if (selected) details.push(paragraph(`选定规则：${selected.title}`));
      details.push(paragraph(`复核理由：${decision.rationale}`), paragraph('此记录仅用于内部复核。', 'muted'));
    }
    if (candidates.length) {
      const list = document.createElement('ul');
      list.className = 'history-list';
      for (const candidate of candidates) {
        const item = document.createElement('li');
        const url = typeof candidate.sourceUrl === 'string' ? URL.parse(candidate.sourceUrl) : null;
        const title = document.createElement(url?.protocol === 'https:' && !url.username && !url.password ? 'a' : 'strong');
        title.textContent = candidate.title;
        if (title.tagName === 'A') {
          title.href = url.href;
          title.target = '_blank';
          title.rel = 'noopener noreferrer';
        }
        const classification = publicationLabels[candidate.publicationStatus] ?? publicationLabels.unclassified;
        item.append(title, paragraph([candidate.publisher, classification, candidate.scopeNote].filter(Boolean).join(' · '), 'muted'));
        list.append(item);
      }
      details.push(list);
    } else {
      details.push(paragraph('该场景版本暂无参考规则。', 'muted'));
    }
    content.replaceChildren(...details);
    content.hidden = false;

    if (form) {
      const eligible = candidates.filter(candidate => ['effective', 'pilot'].includes(candidate.publicationStatus));
      const hasScope = Boolean(context.subjectType && context.jurisdiction && context.reportingYear);
      outcome.querySelector('[value=confirmed]').disabled = !hasScope || !eligible.length;
      if (outcome.value === 'confirmed' && (!hasScope || !eligible.length)) outcome.value = 'needs_review';
      const referenceCode = reference.value;
      reference.replaceChildren(new Option('请选择参考规则', ''), ...eligible.map(candidate =>
        new Option(`${candidate.title} · ${publicationLabels[candidate.publicationStatus]}`, candidate.code)));
      if (eligible.some(candidate => candidate.code === referenceCode)) reference.value = referenceCode;
      updateChoice();
      form.hidden = !current.canDecide || Boolean(decision);
    }
  }

  panel.addEventListener('toggle', async () => {
    const current = view;
    if (!current || !panel.open || saving) return;
    const sequence = Symbol();
    reading = sequence;
    state.textContent = '正在读取适用规则…';
    error.textContent = '';
    content.hidden = true;
    if (form) form.hidden = true;
    const query = new URLSearchParams({orgId: current.orgId});
    if (current.revision) query.set('revision', current.revision);
    try {
      const result = await request(`${current.base}/rule-assessment?${query}`);
      if (view === current && reading === sequence && panel.open) render(result, current);
    } catch (failure) {
      if (view !== current || reading !== sequence || !panel.open) return;
      state.textContent = '';
      error.textContent = failure.message;
    }
  });

  outcome?.addEventListener('change', updateChoice);
  form?.addEventListener('submit', async event => {
    event.preventDefault();
    const current = view;
    if (!current?.canDecide || form.hidden || saving) return;
    rationale.setCustomValidity(rationale.value.trim() ? '' : '请填写复核理由。');
    if (!form.reportValidity()) return;
    const body = {orgId: current.orgId, status: outcome.value, rationale: rationale.value.trim()};
    if (body.status === 'confirmed') body.referenceCode = reference.value;
    saving = current;
    save.disabled = true;
    error.textContent = '';
    try {
      const result = await request(`${current.base}/revisions/${current.revision}/rule-assessment`, body);
      if (view === current) render(result, current);
    } catch (failure) {
      if (view === current) error.textContent = failure.message;
    } finally {
      if (saving === current) {
        saving = undefined;
        save.disabled = false;
      }
    }
  });
  rationale?.addEventListener('input', () => rationale.setCustomValidity(''));

  return next => {
    if (view?.base === next?.base && view?.orgId === next?.orgId && view?.revision === next?.revision
      && view?.taskRevision === next?.taskRevision && view?.canDecide === next?.canDecide) return;
    view = next;
    reading = saving = undefined;
    panel.open = false;
    panel.hidden = !view;
    state.textContent = error.textContent = '';
    content.replaceChildren();
    content.hidden = true;
    if (form) {
      form.reset();
      form.hidden = true;
      save.disabled = false;
      rationale.setCustomValidity('');
      updateChoice();
    }
  };
}
