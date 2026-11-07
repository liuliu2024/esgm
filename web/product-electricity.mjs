import {reportItemDisplay, request} from './shared.mjs';

const productStates = {
  missing_profile: '本提交尚未记录生产用电口径。',
  missing_product_factor: '本提交缺少产品碳足迹口径的电力因子。',
  missing_months: '所选期间存在缺少用电数据或适用因子的月份。',
  calculated: '生产用电贡献已计算。'
};

const profileFieldNames = {outputQuantity: '功能单位产出数', allocationMethod: '用电归属',
  allocationBasis: '归属或分配依据', productMassKg: '目标产品质量（kg）', batchMassKg: '同期总产出质量（kg）'};

function bindProductComparison(panel, getRevisions) {
  const disclosure = panel.querySelector('[data-product-comparison]');
  const form = disclosure.querySelector('form');
  const baseline = form.elements.namedItem('baseline');
  const target = form.elements.namedItem('target');
  const compare = form.querySelector('[type=submit]');
  const state = disclosure.querySelector('[data-comparison-state]');
  const error = disclosure.querySelector('[data-comparison-error]');
  const result = disclosure.querySelector('[data-comparison-result]');
  let view;
  let pending;

  function clear() {
    pending = undefined;
    state.textContent = error.textContent = '';
    result.replaceChildren();
    result.hidden = true;
    compare.disabled = !baseline.value || !target.value || baseline.value === target.value;
  }

  disclosure.addEventListener('toggle', async () => {
    const current = view;
    clear();
    if (!current || !disclosure.open) return;
    const token = Symbol();
    pending = token;
    form.hidden = true;
    state.textContent = '正在读取提交版本…';
    try {
      const revisions = await getRevisions(current);
      if (view !== current || pending !== token) return;
      if (revisions.length < 2) {
        state.textContent = '至少需要两次提交才能对比。';
        return;
      }
      for (const select of [baseline, target]) select.replaceChildren(...revisions.map(revision => new Option(`第 ${revision} 版`, revision)));
      target.value = String(current.revision ?? revisions[0]);
      baseline.value = String(revisions.find(revision => revision < Number(target.value)) ?? revisions.find(revision => String(revision) !== target.value));
      form.hidden = false;
      clear();
    } catch (failure) {
      if (view !== current || pending !== token) return;
      state.textContent = '';
      error.textContent = failure.message;
    }
  });

  form.addEventListener('change', () => {
    clear();
    if (baseline.value && baseline.value === target.value) state.textContent = '请选择两个不同的提交版本。';
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const current = view;
    if (!current || compare.disabled) return;
    clear();
    const token = Symbol();
    pending = token;
    compare.disabled = true;
    state.textContent = '正在对比生产用电排放…';
    const query = new URLSearchParams({orgId: current.orgId, baseline: baseline.value, target: target.value});
    try {
      const data = await request(`${current.base}/product-electricity/comparison?${query}`);
      if (view !== current || pending !== token) return;
      const {baseline: baseData, target: targetData, delta, changes, functionalUnit, boundaryNote, from, to} = data;
      const scope = document.createElement('p');
      scope.textContent = `${from} 至 ${to} · ${functionalUnit} · ${boundaryNote}`;
      const metrics = document.createElement('dl');
      metrics.className = 'scope-grid';
      for (const [field, label, unit] of [
        ['kgCO2ePerFunctionalUnit', '每功能单位排放', `kgCO₂e / ${functionalUnit}`],
        ['allocatedKgCO2e', '归属产品排放', 'kgCO₂e'], ['electricityKgCO2e', '总用电排放', 'kgCO₂e']
      ]) {
        const title = document.createElement('dt');
        const value = document.createElement('dd');
        title.textContent = label;
        const difference = delta[field];
        const signed = difference !== '0' && !difference.startsWith('-') ? `+${difference}` : difference;
        value.textContent = `${baseData.result[field]} → ${targetData.result[field]} ${unit} · 差额 ${signed} ${unit}`;
        metrics.append(title, value);
      }
      const list = document.createElement('ul');
      list.className = 'history-list';
      const addChange = text => {
        const row = document.createElement('li');
        row.textContent = text;
        list.append(row);
      };
      for (const field of changes.profileFields) {
        const format = value => field === 'allocationMethod' ? (value === 'mass' ? '按质量分配' : '目标产品独占') : value ?? '—';
        addChange(`${profileFieldNames[field] ?? field}：${format(baseData.profile[field])} → ${format(targetData.profile[field])}`);
      }
      if (changes.factorChanged) {
        const factor = entry => `${entry.factor.value} kgCO₂e/kWh（${entry.factor.regionCode} · ${entry.factor.dataYear} 年 · 第 ${entry.factor.version} 版）`;
        addChange(`电力因子：${factor(baseData)} → ${factor(targetData)}`);
      }
      for (const month of changes.months) addChange(`${month.period} 用电量：${month.baselineKwh} → ${month.targetKwh} kWh`);
      if (!list.children.length) addChange('用电量、分配口径和因子均无变化。');
      result.replaceChildren(scope, metrics, list);
      result.hidden = false;
      state.textContent = `第 ${data.baselineRevision} 版 → 第 ${data.targetRevision} 版 · 仅比较生产用电`;
    } catch (failure) {
      if (view !== current || pending !== token) return;
      state.textContent = '';
      error.textContent = failure.message;
    } finally {
      if (view === current && pending === token) {
        pending = undefined;
        compare.disabled = false;
      }
    }
  });

  return next => {
    view = next;
    disclosure.open = false;
    form.hidden = true;
    baseline.replaceChildren();
    target.replaceChildren();
    clear();
  };
}

export function bindProductElectricity(panel) {
  const state = panel.querySelector('[data-product-state]');
  const error = panel.querySelector('[data-product-error]');
  const output = panel.querySelector('[data-product-result]');
  const revisionPicker = panel.querySelector('[data-product-revision]');
  const form = panel.querySelector('[data-product-form]');
  const mass = form?.querySelector('[data-product-mass]');
  const allocation = form?.elements.namedItem('allocationMethod');
  const submit = form?.querySelector('[type=submit]');
  let view;
  let reading;
  let saving;

  function getRevisions(current) {
    current.revisions ??= request(`${current.base}/history?${new URLSearchParams({orgId: current.orgId})}`)
      .then(({events}) => events.filter(event => event.action === 'submitted').map(event => event.revision).sort((a, b) => b - a))
      .catch(error => {
        current.revisions = undefined;
        throw error;
      });
    return current.revisions;
  }

  const showComparison = bindProductComparison(panel, getRevisions);

  function updateAllocation() {
    mass.hidden = allocation.value !== 'mass';
    for (const input of mass.querySelectorAll('input')) input.disabled = mass.hidden;
  }

  function render({submissionRevision, profile, status, result, items, coverage, factor, model}, current) {
    state.textContent = `提交第 ${submissionRevision ?? current.revision} 版 · ${productStates[status]}`;
    output.replaceChildren();
    output.hidden = !profile;
    if (form) form.hidden = !current.canRecord || Boolean(profile);
    if (!profile) return;

    if (result) {
      const total = document.createElement('strong');
      total.textContent = `${result.kgCO2ePerFunctionalUnit} kgCO₂e / ${profile.functionalUnit}`;
      const breakdown = document.createElement('p');
      breakdown.textContent = `用电排放 ${result.electricityKgCO2e} kgCO₂e · 归属比例 ${result.allocationShare} · 归属产品 ${result.allocatedKgCO2e} kgCO₂e`;
      output.append(total, breakdown);
    }
    const details = document.createElement('dl');
    details.className = 'scope-grid';
    const fields = [
      ['用电期间', `${profile.from} 至 ${profile.to}`], ['用电边界', profile.boundaryNote],
      ['功能单位与产出数', `${profile.functionalUnit} · ${profile.outputQuantity}`],
      ['归属方法', profile.allocationMethod === 'mass' ? `按质量分配 · ${profile.productMassKg} / ${profile.batchMassKg} kg` : '目标产品独占'],
      ['归属或分配依据', profile.allocationBasis], ['计算模板', `产品生产用电 · 第 ${model.version} 版`]
    ];
    if (coverage) fields.push(['月份覆盖', `${coverage.availableSlots} / ${coverage.expectedSlots}`]);
    for (const [label, value] of fields) {
      const name = document.createElement('dt');
      const description = document.createElement('dd');
      name.textContent = label;
      description.textContent = value;
      details.append(name, description);
    }
    output.append(details);
    if (factor) {
      const source = document.createElement('a');
      source.href = factor.sourceUrl;
      source.target = '_blank';
      source.rel = 'noopener noreferrer';
      source.textContent = `${factor.sourceTitle} · ${factor.value} kgCO₂e/kWh · 因子第 ${factor.version} 版`;
      output.append(source);
    }
    if (items?.length) {
      const months = document.createElement('ul');
      months.className = 'history-list';
      for (const item of items) {
        const row = document.createElement('li');
        const {activity, quantity, emissions, provenance} = reportItemDisplay(item, 'controlled', 'kgCO2e');
        row.textContent = [activity, quantity, emissions, provenance].join(' · ');
        months.append(row);
      }
      output.append(months);
    }
    const limitation = document.createElement('p');
    limitation.className = 'muted';
    limitation.textContent = '仅覆盖所列生产用电边界。';
    output.append(limitation);
  }

  async function load(current) {
    const token = Symbol();
    reading = token;
    state.textContent = '正在读取生产用电贡献…';
    error.textContent = '';
    output.hidden = true;
    if (form) form.hidden = true;
    const query = new URLSearchParams({orgId: current.orgId});
    try {
      if (revisionPicker && !revisionPicker.value) {
        const revisions = await getRevisions(current);
        if (view !== current || reading !== token) return;
        revisionPicker.replaceChildren(...revisions.map(revision => new Option(`第 ${revision} 版`, revision)));
        revisionPicker.disabled = !revisions.length;
        if (!revisions.length) {
          state.textContent = '暂无已提交版本。';
          return;
        }
      }
      const revision = revisionPicker?.value ?? current.revision;
      const result = await request(`${current.base}/revisions/${revision}/product-electricity?${query}`);
      if (view === current && reading === token && panel.open) render(result, current);
    } catch (failure) {
      if (view !== current || reading !== token) return;
      state.textContent = '';
      error.textContent = failure.message;
    } finally {
      if (reading === token) reading = undefined;
    }
  }

  panel.addEventListener('toggle', () => {
    if (panel.open && view && !saving) void load(view);
  });
  revisionPicker?.addEventListener('change', () => {
    if (view) void load(view);
  });
  allocation?.addEventListener('change', updateAllocation);
  form?.addEventListener('change', () => {
    form.elements.namedItem('to').setCustomValidity('');
    error.textContent = '';
  });
  form?.addEventListener('submit', async event => {
    event.preventDefault();
    const current = view;
    if (!current?.canRecord || form.hidden || saving) return;
    const input = Object.fromEntries([...new FormData(form)].map(([name, value]) => [name, value.trim()]));
    form.elements.namedItem('to').setCustomValidity(input.from <= input.to ? '' : '结束月不能早于起始月。');
    if (!form.reportValidity()) return;
    saving = current;
    submit.disabled = true;
    error.textContent = '';
    try {
      await request(`${current.base}/revisions/${current.revision}/product-electricity`, {orgId: current.orgId, ...input});
      if (view === current) await load(current);
    } catch (failure) {
      if (view === current) error.textContent = failure.message;
    } finally {
      if (saving === current) {
        saving = undefined;
        submit.disabled = false;
      }
    }
  });

  return next => {
    if (view?.base === next?.base && view?.orgId === next?.orgId && view?.revision === next?.revision
      && view?.taskRevision === next?.taskRevision && view?.canRecord === next?.canRecord) return;
    view = next && {...next};
    showComparison(view);
    reading = saving = undefined;
    panel.open = false;
    panel.hidden = !view;
    state.textContent = error.textContent = '';
    output.replaceChildren();
    output.hidden = true;
    if (revisionPicker) {
      revisionPicker.replaceChildren();
      revisionPicker.disabled = true;
    }
    if (form) {
      form.reset();
      for (const [name, month] of [['from', '01'], ['to', '12']]) {
        const input = form.elements.namedItem(name);
        input.setCustomValidity('');
        input.min = next?.reportingYear ? `${next.reportingYear}-01` : '';
        input.max = next?.reportingYear ? `${next.reportingYear}-12` : '';
        if (next?.reportingYear) input.value = `${next.reportingYear}-${month}`;
      }
      form.hidden = true;
      submit.disabled = false;
      updateAllocation();
    }
  };
}
