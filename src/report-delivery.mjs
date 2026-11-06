const escapes = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'};
const escape = value => String(value).replace(/[&<>"']/g, character => escapes[character]);

export function renderDeliveryDocument(draft, deliveryId, {recipient, purpose, includeMonthly, includeFactor}) {
  const {scope, summary, items, factorDecision} = draft.report;
  const unit = summary.outputUnit === 'kgCO2' ? 'kg CO₂' : 'kg CO₂e';
  const monthly = includeMonthly ? `
    <h2>月度汇总</h2>
    <table><thead><tr><th>月份</th><th>购电量</th><th>排放量</th></tr></thead><tbody>
    ${items.map(item => `<tr><td>${escape(item.period)}</td><td>${escape(item.quantity)} kWh</td>
      <td>${escape(item.emissionsKg)} ${unit}</td></tr>`).join('')}
    </tbody></table>` : '';
  const factor = factorDecision.factor;
  const source = includeFactor ? `
    <h2>公开因子来源</h2>
    <p>${escape(factor.dataYear)} 年 · ${escape(factor.regionCode)} · 第 ${escape(factor.version)} 版 ·
      ${escape(factor.value)} ${unit}/kWh</p>
    <p><a href="${escape(factor.sourceUrl)}" rel="noopener noreferrer">${escape(factor.sourceTitle)}</a>
      · ${escape(factor.sourceLocator)}</p>` : '';
  return `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>外购电力内部管理报告｜采购方交付件</title>
<style>
body{font:16px/1.65 system-ui,sans-serif;max-width:48rem;margin:2rem auto;padding:0 1rem;color:#16272c}
h1{line-height:1.2}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:.5rem;border-bottom:1px solid #d8e7df}
dt{font-weight:600}dd{margin:0 0 .6rem}a{color:#086b54}p,dd{overflow-wrap:anywhere}
</style>
<main>
  <h1>外购电力内部管理报告</h1>
  <p>采购方交付件 · 适用于下列收件方和用途</p>
  <dl>
    <dt>收件方</dt><dd>${escape(recipient)}</dd>
    <dt>交付用途</dt><dd>${escape(purpose)}</dd>
    ${scope.declaredScope ? `<dt>报告对象</dt><dd>${escape(scope.declaredScope.subjectName)}</dd>` : ''}
    <dt>报告期间</dt><dd>${escape(scope.from)} 至 ${escape(scope.to)}</dd>
    <dt>报告版本</dt><dd>${escape(draft.draftId)} · 提交第 ${escape(scope.submissionRevision)} 版</dd>
    <dt>交付件编号</dt><dd>${escape(deliveryId)}</dd>
  </dl>
  <h2>外购电力排放量</h2>
  <p><strong>${escape(summary.totalKg)} ${unit}</strong> · ${escape(summary.coverage.availableSlots)} 个月</p>
  ${monthly}
  ${source}
  <h2>使用范围</h2>
  <p>仅覆盖所列期间的外购电力，其他排放源不计入。本报告用于内部管理及采购方沟通，无正式核查结论。</p>
</main>
</html>
`;
}
