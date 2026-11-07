import {request} from './shared.mjs';

const combustionInputLabels = {methodBranch: '含碳量计算方法', standardVolumeNm3: '标准体积（Nm³）',
  ncvGjPer10kNm3: '低位发热量（GJ/万 Nm³）', carbonTcPerGj: '单位热值含碳量（tC/GJ）',
  elementalCarbonTcPer10kNm3: '实测元素碳含量（tC/万 Nm³）', oxidationFraction: '碳氧化率'};
const signed = value => value === '0' || value.startsWith('-') ? value : `+${value}`;

function bindGasComparison(panel, taskRevisions) {
  const disclosure = panel.querySelector('[data-combustion-comparison]');
  const form = disclosure.querySelector('form');
  const state = disclosure.querySelector('[data-comparison-status]');
  const error = disclosure.querySelector('[data-comparison-error]');
  const results = disclosure.querySelector('[data-comparison-months]');
  const run = form.querySelector('[type=submit]');
  const sides = ['baseline', 'target'];
  const revisions = sides.map(side => form.elements.namedItem(`${side}Revision`));
  const snapshots = sides.map(side => form.elements.namedItem(side));
  let view;
  let loading;
  let comparing;

  function updateButton() {
    const [baseline, target] = snapshots.map(select => select.value);
    run.disabled = Boolean(loading || comparing || !baseline || !target || baseline === target);
  }

  function clearComparison() {
    comparing = undefined;
    state.textContent = error.textContent = '';
    results.hidden = true;
    results.replaceChildren();
    updateButton();
  }

  async function loadSnapshots() {
    const current = view;
    const token = Symbol();
    loading = token;
    clearComparison();
    const [baseRevision, targetRevision] = revisions.map(select => select.value);
    const previous = snapshots.map(select => select.value);
    for (const select of snapshots) {
      select.replaceChildren(new Option('正在读取快照…', ''));
      select.disabled = true;
    }
    const list = async revision => {
      const path = `${current.base}/revisions/${revision}/gas-combustion/snapshots`;
      const {items} = await request(`${path}?${new URLSearchParams({orgId: current.orgId})}`);
      return items;
    };
    try {
      const baselineList = list(baseRevision);
      const pairs = await Promise.all([baselineList, baseRevision === targetRevision ? baselineList : list(targetRevision)]);
      if (view !== current || loading !== token) return;
      for (const [index, items] of pairs.entries()) {
        const select = snapshots[index];
        select.replaceChildren(new Option(items.length ? '请选择快照' : '该版本暂无冻结快照', ''), ...items.map(item => {
          const span = item.from === item.to ? item.from : `${item.from} 至 ${item.to}`;
          return new Option(`${span} · ${item.totalKgCO2} kgCO₂`, item.snapshotId);
        }));
        select.disabled = !items.length;
        if (items.some(item => item.snapshotId === previous[index])) select.value = previous[index];
        else if (items.length === 1) select.value = items[0].snapshotId;
      }
      if (pairs.some(items => !items.length)) state.textContent = '请选择已有冻结快照的提交版本。';
      else if (snapshots[0].value && snapshots[0].value === snapshots[1].value) state.textContent = '请选择两份不同的快照。';
    } catch (failure) {
      if (view !== current || loading !== token) return;
      for (const select of snapshots) select.replaceChildren(new Option('快照读取失败', ''));
      error.textContent = failure.message;
    } finally {
      if (view === current && loading === token) {
        loading = undefined;
        updateButton();
      }
    }
  }

  disclosure.addEventListener('toggle', () => {
    if (!view || !disclosure.open) return;
    const available = [...taskRevisions.options];
    const target = String(view.revision);
    for (const select of revisions) select.replaceChildren(...available.map(option => new Option(option.textContent, option.value)));
    revisions[1].value = target;
    revisions[0].value = available.find(option => option.value !== target)?.value ?? target;
    void loadSnapshots();
  });
  for (const select of revisions) select.addEventListener('change', () => void loadSnapshots());
  for (const select of snapshots) select.addEventListener('change', () => {
    clearComparison();
    if (snapshots[0].value && snapshots[0].value === snapshots[1].value) state.textContent = '请选择两份不同的快照。';
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!view || run.disabled) return;
    const current = view;
    const token = Symbol();
    clearComparison();
    comparing = token;
    updateButton();
    state.textContent = '正在对比试算快照…';
    const [baseline, target] = snapshots.map(select => select.value);
    const query = new URLSearchParams({orgId: current.orgId, baseline, target});
    try {
      const data = await request(`${current.base}/gas-combustion/comparison?${query}`);
      if (view !== current || comparing !== token) return;
      const changed = data.items.filter(item => item.deltaKgCO2 !== '0' || item.changedInputs.length);
      state.textContent = `排放总差额 ${signed(data.totalDeltaKgCO2)} kgCO₂ · ${data.baselineKgCO2} → ${data.targetKgCO2} kgCO₂ · ${changed.length} 个月有变化`;
      for (const item of changed) {
        const row = document.createElement('li');
        const label = document.createElement('strong');
        label.textContent = `${item.period} · ${signed(item.deltaKgCO2)} kgCO₂ · ${item.baselineKgCO2} → ${item.targetKgCO2} kgCO₂`;
        row.append(label);
        for (const {field, before, after} of item.changedInputs) {
          const format = value => value == null ? '—' : field !== 'methodBranch' ? value
            : value === 'measured_carbon' ? '实测元素碳含量' : '低位发热量法';
          const description = document.createElement('p');
          description.textContent = `${combustionInputLabels[field] ?? field}：${format(before)} → ${format(after)}`;
          row.append(description);
        }
        results.append(row);
      }
      results.hidden = !changed.length;
    } catch (failure) {
      if (view !== current || comparing !== token) return;
      state.textContent = '';
      error.textContent = failure.message;
    } finally {
      if (view === current && comparing === token) {
        comparing = undefined;
        updateButton();
      }
    }
  });

  return next => {
    view = next;
    loading = undefined;
    disclosure.open = false;
    for (const select of [...revisions, ...snapshots]) select.replaceChildren();
    for (const select of snapshots) select.disabled = true;
    clearComparison();
  };
}

export function bindGasCombustion(panel, taskRevisions) {
  const showComparison = bindGasComparison(panel, taskRevisions);
  const range = panel.querySelector('[data-combustion-range]');
  const entry = panel.querySelector('[data-combustion-entry]');
  const state = panel.querySelector('[data-combustion-status]');
  const error = panel.querySelector('[data-combustion-error]');
  const evidenceStatus = panel.querySelector('[data-combustion-evidence]');
  const entryError = panel.querySelector('[data-combustion-entry-error]');
  const result = panel.querySelector('[data-combustion-result]');
  const months = panel.querySelector('[data-combustion-months]');
  const source = panel.querySelector('[data-combustion-source]');
  const submit = entry.querySelector('[type=submit]');
  const queryButton = range.querySelector('[type=submit]');
  const period = entry.elements.namedItem('period');
  const selects = [...entry.querySelectorAll('select[name$="EvidenceId"]')];
  const method = entry.elements.namedItem('methodBranch');
  const methodFields = [...entry.querySelectorAll('[data-combustion-method]')];
  let view;
  let reading;
  let recording;
  let evidence = new Map();
  let recordedMonths = new Set();

  function updateMethod() {
    for (const field of methodFields) {
      const visible = field.dataset.combustionMethod === method.value;
      field.hidden = field.querySelector('input').disabled = !visible;
    }
  }

  method.addEventListener('change', updateMethod);

  function updateEntry() {
    const recorded = recordedMonths.has(period.value);
    period.setCustomValidity(recorded ? '该月份已记录，请选择其他月份。' : '');
    submit.disabled = !evidence.size || Boolean(recording) || recorded;
    if (recorded) entryError.textContent = '该月份已记录，请选择其他月份。';
  }

  function setEvidence(items, message) {
    if (!view) return;
    evidence = new Map(items.map(item => [item.evidenceId, item.title]));
    if (!view.canRecord) return;
    for (const select of selects) {
      select.replaceChildren(new Option('请选择已固定证据', ''), ...items.map(item => new Option(item.title, item.evidenceId)));
      select.disabled = !items.length;
    }
    evidenceStatus.textContent = message ?? (items.length ? '' : '该提交尚无固定证据，暂不能记录。');
    updateEntry();
  }

  function render(data) {
    const {coverage, facility, from, to, items, model, knownSubtotalKgCO2, totalKgCO2} = data;
    const amount = totalKgCO2 !== null ? `总量 ${totalKgCO2} kgCO₂`
      : knownSubtotalKgCO2 !== null ? `已知小计 ${knownSubtotalKgCO2} kgCO₂` : '暂无已录入数据';
    const rangeLabel = from === to ? from : `${from} 至 ${to}`;
    state.textContent = [facility, rangeLabel, `已录 ${coverage.availableSlots}/${coverage.expectedSlots} 个月`, amount].join(' · ');
    source.href = model.sourceUrl;
    source.textContent = `${model.sourceLocator} · 模型第 ${model.version} 版`;
    months.replaceChildren(...items.map(item => {
      const row = document.createElement('li');
      const heading = document.createElement('strong');
      if (item.status !== 'calculated') {
        heading.textContent = `${item.period} · 缺少活动量或参数`;
        row.append(heading);
        return row;
      }
      recordedMonths.add(item.period);
      heading.textContent = `${item.period} · ${item.emissionsKgCO2} kgCO₂`;
      const inputs = document.createElement('p');
      const carbon = item.methodBranch === 'measured_carbon'
        ? [`实测元素碳 ${item.elementalCarbonTcPer10kNm3} tC/万 Nm³`]
        : [`${item.ncvGjPer10kNm3} GJ/万 Nm³`, `${item.carbonTcPerGj} tC/GJ`];
      inputs.textContent = [`${item.standardVolumeNm3} Nm³`, ...carbon, `氧化率 ${item.oxidationFraction}`].join(' · ');
      const provenance = document.createElement('p');
      const names = [evidence.get(item.activityEvidenceId), evidence.get(item.parameterEvidenceId)].filter(Boolean);
      provenance.className = 'muted';
      provenance.textContent = [...names, item.parameterBasis].filter(Boolean).join(' · ');
      row.append(heading, inputs, provenance);
      return row;
    }));
    result.hidden = false;
    updateEntry();
  }

  function clearRange() {
    reading = undefined;
    result.hidden = true;
    state.textContent = error.textContent = '';
    queryButton.disabled = Boolean(recording);
  }

  range.addEventListener('change', () => {
    range.elements.namedItem('to').setCustomValidity('');
    clearRange();
  });
  range.addEventListener('submit', async event => {
    event.preventDefault();
    const current = view;
    if (!current || reading || recording) return;
    const {from, to} = Object.fromEntries(new FormData(range));
    range.elements.namedItem('to').setCustomValidity(from <= to ? '' : '结束月不能早于起始月。');
    if (!range.reportValidity()) return;
    clearRange();
    const token = Symbol();
    reading = token;
    queryButton.disabled = true;
    state.textContent = '正在查询固定燃烧试算…';
    try {
      const data = await request(`${current.path}?${new URLSearchParams({orgId: current.orgId, from, to})}`);
      if (reading === token && view === current) render(data);
    } catch (failure) {
      if (reading !== token || view !== current) return;
      state.textContent = '';
      error.textContent = failure.message;
    } finally {
      if (reading === token) {
        reading = undefined;
        queryButton.disabled = false;
      }
    }
  });

  period.addEventListener('change', () => {
    entryError.textContent = '';
    updateEntry();
  });
  entry.addEventListener('submit', async event => {
    event.preventDefault();
    const current = view;
    if (!current?.canRecord || submit.disabled) return;
    const body = Object.fromEntries([...new FormData(entry)].map(([name, value]) => [name, value.trim()]));
    clearRange();
    recording = current;
    submit.disabled = queryButton.disabled = true;
    entryError.textContent = '';
    try {
      const data = await request(current.path, {orgId: current.orgId, ...body});
      if (view !== current) return;
      entry.reset();
      updateMethod();
      range.elements.namedItem('from').value = range.elements.namedItem('to').value = body.period;
      render(data);
    } catch (failure) {
      if (view === current) entryError.textContent = failure.message;
    } finally {
      if (recording === current) {
        recording = undefined;
        queryButton.disabled = false;
        updateEntry();
      }
    }
  });

  return {
    show(next) {
      view = next && {...next, path: `${next.base}/revisions/${next.revision}/gas-combustion`};
      showComparison(view);
      recording = undefined;
      recordedMonths = new Set();
      evidence = new Map();
      panel.open = false;
      panel.hidden = !view;
      range.reset();
      range.elements.namedItem('to').setCustomValidity('');
      entry.reset();
      updateMethod();
      entry.hidden = !view?.canRecord;
      entryError.textContent = '';
      clearRange();
      setEvidence([], '正在读取该版本的固定证据…');
      updateEntry();
    },
    setEvidence
  };
}
