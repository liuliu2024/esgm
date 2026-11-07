import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { startDemo } from './demo-data.mjs';
import { createLocalQuarantine } from './local-quarantine.mjs';
import { createDeliveryPdfRenderer } from './delivery-pdf.mjs';
import { MAX_EVIDENCE_FILE_BYTES } from '../src/index.mjs';

const pages = {
  '/': 'home.html',
  '/home.css': 'home.css',
  '/home.mjs': 'home.mjs',
  '/modules': 'modules.html',
  '/modules.css': 'modules.css',
  '/reports/internal-draft': 'internal-report.html',
  '/internal-report.css': 'internal-report.css',
  '/internal-report.mjs': 'internal-report.mjs',
  '/customer': 'customer.html',
  '/professional': 'professional.html',
  '/admin': 'admin.html',
  '/shared.css': 'shared.css',
  '/shared.mjs': 'shared.mjs',
  '/customer.mjs': 'customer.mjs',
  '/professional.mjs': 'professional.mjs',
  '/factor-decision.mjs': 'factor-decision.mjs',
  '/rule-assessment.mjs': 'rule-assessment.mjs',
  '/combustion.mjs': 'combustion.mjs',
  '/product-electricity.mjs': 'product-electricity.mjs',
  '/gas-restatement.mjs': 'gas-restatement.mjs',
  '/review-issues.mjs': 'review-issues.mjs',
  '/case-reopen.mjs': 'case-reopen.mjs',
  '/admin.mjs': 'admin.mjs'
};
const mediaTypes = { html: 'text/html', css: 'text/css', mjs: 'text/javascript' };

async function seedReportSample(demo) {
  const { orgId, scenarioReleaseId } = demo;
  const post = async (path, fields) => {
    const result = await demo.dispatch('customer', 'POST', `/v1/customer/cases${path}`, { orgId, ...fields });
    if (result.status !== 201 && result.status !== 200) {
      throw new Error(`Demo setup failed at ${path || '/cases'}: ${result.body.error?.code ?? result.status}`);
    }
    return result.body;
  };
  const task = await post('', {
    scenarioReleaseId, purpose: '合成样本｜采购方碳报告',
    scope: { subjectType: 'product', subjectName: '合成设备 A', jurisdiction: '上海市',
      reportingYear: '2026', recipient: '样例采购方' }
  });
  const path = `/${task.id}`;
  const batch = await post(`${path}/imports`, {
    csv: 'period,source,quantity,unit\n2026-01,electricity,1,MWh\n2026-01,natural_gas,200,m3'
  });
  await post(`${path}/imports/${batch.batchId}/commit`, { previewRevision: batch.previewRevision });
  const snapshot = await post(`${path}/calculation-snapshots`, { from: '2026-01', to: '2026-01' });
  const draft = await post(`${path}/internal-report-drafts`, { snapshotId: snapshot.snapshotId });
  await post(`${path}/submit`, { revision: task.revision });
  await post(`${path}/internal-report-drafts/${draft.draftId}/submit-review`, {});
}

async function seedElectricitySample(demo) {
  const {orgId, scenarioReleaseId} = demo;
  async function post(role, path, fields) {
    const result = await demo.dispatch(role, 'POST', `/v1/${role === 'reviewer' ? 'professional' : 'customer'}/cases${path}`,
      {orgId, ...fields});
    if (result.status !== 201 && result.status !== 200) {
      throw new Error(`Electricity sample failed at ${path || '/cases'}: ${result.body.error?.code ?? result.status}`);
    }
    return result.body;
  }
  const task = await post('customer', '', {
    scenarioReleaseId, purpose: '合成样本｜外购电力受控试算',
    scope: {subjectType: 'product', subjectName: '合成设备 B', jurisdiction: '上海市',
      reportingYear: '2024', recipient: '样例采购方'}
  });
  const path = `/${task.id}`;
  const batch = await post('customer', `${path}/imports`, {
    csv: 'period,source,quantity,unit\n2024-01,electricity,1,MWh\n2024-02,electricity,0,kWh\n2024-01,natural_gas,200,m3'
  });
  await post('customer', `${path}/imports/${batch.batchId}/commit`, {previewRevision: batch.previewRevision});
  const submitted = await post('customer', `${path}/submit`, {revision: task.revision});
  await post('reviewer', `${path}/revisions/${submitted.revision}/factor-decision`, {
    factorId: 'cn-electricity-product-average', factorVersion: 1, accountingBasis: 'product_footprint',
    regionCode: 'CN', dataYear: 2024, methodReference: '样本试算｜2024 年全国电力碳足迹因子表 1',
    rationale: '用合成用电数据验证 2024 年全国电力碳足迹因子的计算和证据引用。'
  });
  const draft = await post('customer', `${path}/revisions/${submitted.revision}/internal-report-drafts`, {
    from: '2024-01', to: '2024-02'
  });
  const draftPath = `${path}/internal-report-drafts/${draft.draftId}`;
  await post('customer', `${draftPath}/submit-review`, {});
  await post('reviewer', `${draftPath}/review`, {decision: 'reviewed'});

  for (const [factorId, label] of [
    ['demo-summary-only', '因子仅可披露合计'], ['demo-internal-only', '因子仅供内部使用']
  ]) {
    const restricted = await post('customer', '', {
      scenarioReleaseId, purpose: `合成样本｜${label}`,
      scope: {...task.scope, subjectName: '样例生产单元'}
    });
    const restrictedPath = `/${restricted.id}`;
    const batch = await post('customer', `${restrictedPath}/imports`, {
      csv: 'period,source,quantity,unit\n2024-01,electricity,1000,kWh'
    });
    await post('customer', `${restrictedPath}/imports/${batch.batchId}/commit`, {previewRevision: batch.previewRevision});
    const submitted = await post('customer', `${restrictedPath}/submit`, {revision: restricted.revision});
    const revision = `${restrictedPath}/revisions/${submitted.revision}`;
    await post('reviewer', `${revision}/factor-decision`, {
      factorId, factorVersion: 1, accountingBasis: 'product_footprint', regionCode: 'CN', dataYear: 2024,
      methodReference: '合成因子权限样例', rationale: '验证交付披露控制，不用于正式核算。'
    });
    const report = await post('customer', `${revision}/internal-report-drafts`, {from: '2024-01', to: '2024-01'});
    const reportPath = `${restrictedPath}/internal-report-drafts/${report.draftId}`;
    await post('customer', `${reportPath}/submit-review`, {});
    await post('reviewer', `${reportPath}/review`, {decision: 'reviewed'});
    if (factorId === 'demo-internal-only') {
      await post('reviewer', `${restrictedPath}/review-issues`, {
        submissionRevision: submitted.revision, title: '合成样本｜核对关键数据',
        description: '供正式发布条件核对，等待企业补充。', severity: 'critical', dueDate: '2026-11-10'
      });
      await post('reviewer', `${restrictedPath}/review`, {revision: submitted.revision, decision: 'approved'});
    }
  }

  const regionalTask = await post('customer', '', {
    scenarioReleaseId, purpose: '合成样本｜上海组织购电',
    scope: {subjectType: 'organization', subjectName: '样例组织 C', jurisdiction: '上海市',
      reportingYear: '2023', recipient: '样例采购方'}
  });
  const regionalPath = `/${regionalTask.id}`;
  const regionalBatch = await post('customer', `${regionalPath}/imports`, {
    csv: 'period,source,quantity,unit\n2023-01,electricity,1000,kWh'
  });
  await post('customer', `${regionalPath}/imports/${regionalBatch.batchId}/commit`,
    {previewRevision: regionalBatch.previewRevision});
  await post('customer', `${regionalPath}/submit`, {revision: regionalTask.revision});

  const {body: {items}} = await demo.dispatch('customer', 'GET', `/v1/customer/scenarios?orgId=${orgId}`);
  const productScenario = items.find(item => item.code === 'product-footprint-prep');
  const productTask = await post('customer', '', {
    scenarioReleaseId: productScenario.id, purpose: '合成样本｜产品生产用电分配',
    scope: {subjectType: 'product', subjectName: '样例零件 E', jurisdiction: '上海市',
      reportingYear: '2024', recipient: '内部产品团队'}
  });
  const productPath = `/${productTask.id}`;
  const productBatch = await post('customer', `${productPath}/imports`, {
    csv: 'period,source,quantity,unit\n2024-01,electricity,1000,kWh'
  });
  await post('customer', `${productPath}/imports/${productBatch.batchId}/commit`,
    {previewRevision: productBatch.previewRevision});
  const productSubmission = await post('customer', `${productPath}/submit`, {revision: productTask.revision});
  const productRevision = `${productPath}/revisions/${productSubmission.revision}`;
  const productFactor = {
    factorId: 'cn-electricity-product-average', factorVersion: 1, accountingBasis: 'product_footprint',
    regionCode: 'CN', dataYear: 2024, methodReference: '样本试算｜2024 年全国电力碳足迹因子表 1',
    rationale: '合成场景采用全国平均电力碳足迹因子。'
  };
  const productProfile = {
    from: '2024-01', to: '2024-01', boundaryNote: '合成样本：生产工序共用电表 A 的外购用电。',
    functionalUnit: '1 件样例零件 E', outputQuantity: '100', allocationMethod: 'mass',
    productMassKg: '25', batchMassKg: '100', allocationBasis: '合成样本：同期目标产品与全部产品质量。'
  };
  await post('reviewer', `${productRevision}/factor-decision`, productFactor);
  await post('reviewer', `${productRevision}/product-electricity`, productProfile);
  const productReturned = await post('reviewer', `${productPath}/review`, {
    revision: productSubmission.revision, decision: 'returned', reason: '合成演练：更正生产电表读数。'
  });
  const correctedBatch = await post('customer', `${productPath}/imports`, {
    csv: 'period,source,quantity,unit\n2024-01,electricity,1200,kWh'
  });
  await post('customer', `${productPath}/imports/${correctedBatch.batchId}/commit`,
    {previewRevision: correctedBatch.previewRevision});
  const productCorrected = await post('customer', `${productPath}/resubmit`, {
    revision: productReturned.revision, correctionNote: '合成演练：重新确认生产电表读数。'
  });
  const correctedProductRevision = `${productPath}/revisions/${productCorrected.revision}`;
  await post('reviewer', `${correctedProductRevision}/factor-decision`, productFactor);
  await post('reviewer', `${correctedProductRevision}/product-electricity`, productProfile);
  const ruleTask = await post('customer', '', {
    scenarioReleaseId: productScenario.id, purpose: '合成样本｜产品规则判断',
    scope: {subjectType: 'product', subjectName: '样例设备 D', jurisdiction: '上海市',
      reportingYear: '2025', recipient: '样例采购方'}
  });
  await post('customer', `/${ruleTask.id}/submit`, {revision: ruleTask.revision});

  const gasScenario = items.find(item => item.code === 'power-generation-combustion');
  const gasTask = await post('customer', '', {
    scenarioReleaseId: gasScenario.id, purpose: '合成样本｜发电设施天然气燃烧',
    scope: {subjectType: 'facility', subjectName: '样例燃气发电设施', jurisdiction: '上海市',
      reportingYear: '2026', recipient: '设施内部管理团队'}
  });
  await post('customer', `/${gasTask.id}/submit`, {revision: gasTask.revision});

  const restatementTask = await post('customer', '', {
    scenarioReleaseId: gasScenario.id, purpose: '合成样本｜天然气报告重述',
    scope: {subjectType: 'facility', subjectName: '样例发电设施 F', jurisdiction: '上海市',
      reportingYear: '2026', recipient: '内部管理团队'}
  });
  const restatementPath = `/${restatementTask.id}`;
  const activityEvidenceId = await demo.seedFixtureEvidence(restatementTask.id, '合成凭证｜月度天然气活动量');
  const parameterEvidenceId = await demo.seedFixtureEvidence(restatementTask.id, '合成凭证｜元素碳参数');
  const evidenceIds = [activityEvidenceId, parameterEvidenceId];
  async function freezeSubmission(revision, standardVolumeNm3) {
    const revisionPath = `${restatementPath}/revisions/${revision}`;
    await post('reviewer', `${revisionPath}/rule-assessment`, {
      status: 'confirmed', referenceCode: 'cets-power-2026', rationale: '本机合成发电设施样例。'
    });
    await post('reviewer', `${revisionPath}/gas-combustion`, {
      period: '2026-01', standardVolumeNm3, methodBranch: 'measured_carbon',
      elementalCarbonTcPer10kNm3: '5', oxidationFraction: '0.99',
      activityEvidenceId, parameterEvidenceId, parameterBasis: '本机合成参数，参比条件为 20℃、101.325 kPa。'
    });
    return post('customer', `${revisionPath}/gas-combustion/snapshots`, {from: '2026-01', to: '2026-01'});
  }
  const original = await post('customer', `${restatementPath}/submit`, {revision: restatementTask.revision, evidenceIds});
  const baseline = await freezeSubmission(original.revision, '10000');
  const baselineDraft = await post('customer',
    `${restatementPath}/revisions/${original.revision}/gas-combustion/snapshots/${baseline.snapshotId}/internal-report-draft`, {});
  await post('customer', `${restatementPath}/internal-report-drafts/${baselineDraft.draftId}/submit-review`, {});
  const returned = await post('reviewer', `${restatementPath}/review`, {
    revision: original.revision, decision: 'returned', reason: '合成演练：更正月度用气量。'
  });
  const corrected = await post('customer', `${restatementPath}/resubmit`, {
    revision: returned.revision, correctionNote: '合成演练：补录已核对的用气量。', evidenceIds
  });
  const target = await freezeSubmission(corrected.revision, '11000');
  await post('customer', `${restatementPath}/gas-combustion/restatements`, {
    baselineSnapshotId: baseline.snapshotId, targetSnapshotId: target.snapshotId,
    reason: '合成演练：将 1 月用气量从 10,000 更正为 11,000 Nm³。'
  });

  const issueTask = await post('customer', '', {
    scenarioReleaseId, purpose: '合成样本｜复核问题整改',
    scope: {subjectType: 'organization', subjectName: '样例组织 G', jurisdiction: '上海市',
      reportingYear: '2026', recipient: '内部管理团队'}
  });
  const issueTaskPath = `/${issueTask.id}`;
  const issueEvidence = await demo.seedFixtureEvidence(issueTask.id, '合成凭证｜月度用电对账单');
  const issueSubmission = await post('customer', `${issueTaskPath}/submit`, {
    revision: issueTask.revision, evidenceIds: [issueEvidence]
  });
  await post('reviewer', `${issueTaskPath}/review-issues`, {
    submissionRevision: issueSubmission.revision, evidenceId: issueEvidence,
    title: '核对电表归属', description: '请说明对账单中的电表是否同时覆盖生产区和办公区。',
    severity: 'normal', dueDate: '2026-11-10'
  });

  const lockTask = await post('customer', '', {
    scenarioReleaseId, purpose: '合成样本｜已批准期间重开',
    scope: {subjectType: 'organization', subjectName: '样例组织 H', jurisdiction: '上海市',
      reportingYear: '2026', recipient: '内部管理团队'}
  });
  const lockPath = `/${lockTask.id}`;
  const lockBatch = await post('customer', `${lockPath}/imports`, {
    csv: 'period,source,quantity,unit\n2026-01,electricity,1000,kWh'
  });
  await post('customer', `${lockPath}/imports/${lockBatch.batchId}/commit`, {previewRevision: lockBatch.previewRevision});
  const lockSubmitted = await post('customer', `${lockPath}/submit`, {revision: lockTask.revision});
  const locked = await post('reviewer', `${lockPath}/review`, {revision: lockSubmitted.revision, decision: 'approved'});
  await post('customer', `${lockPath}/reopen-requests`, {
    approvedRevision: locked.revision, reason: '合成演练：需补录此前遗漏的用电记录。'
  });
}

export async function startPreview(port = 0, { sample = false, renderDeliveryPdf } = {}) {
  const quarantine = await createLocalQuarantine();
  const demo = await startDemo({ quarantine, renderDeliveryPdf, sample }).catch(async error => {
    await quarantine.close();
    throw error;
  });
  const server = createServer(async (request, response) => {
    const reply = (status, body) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(body));
    };
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      const file = Object.hasOwn(pages, url.pathname) ? pages[url.pathname] : undefined;
      if (request.method === 'GET' && file) {
        const html = await readFile(new URL(`../web/${file}`, import.meta.url));
        response.writeHead(200, { 'Content-Type': `${mediaTypes[file.split('.').at(-1)]}; charset=utf-8` });
        response.end(html);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/demo/context') {
        reply(200, { orgId: demo.orgId, scenarioReleaseId: demo.scenarioReleaseId });
        return;
      }
      if (url.pathname === '/v1/session/workspace') {
        const view = url.searchParams.get('view');
        const role = view === 'professional' ? 'reviewer' : view === 'admin' ? 'admin' : 'customer';
        const result = await demo.dispatch(role, request.method, url.pathname + url.search);
        reply(result.status, result.body);
        return;
      }
      const role = /^\/v1\/(customer|professional|admin)\//.exec(url.pathname)?.[1];
      if (!role) {
        reply(404, { error: { code: 'NOT_FOUND', message: '未找到该页面。' } });
        return;
      }
      let body;
      const contentType = request.headers['content-type']?.split(';')[0];
      if (request.method === 'POST') {
        const isUpload = /^\/v1\/customer\/cases\/[^/]+\/evidence\/[^/]+\/file$/.test(url.pathname);
        if (!isUpload && contentType !== 'application/json') {
          reply(415, { error: { code: 'JSON_REQUIRED', message: '请提交 JSON 请求。' } });
          return;
        }
        const limit = isUpload ? MAX_EVIDENCE_FILE_BYTES : 8192;
        const chunks = [];
        let size = 0;
        for await (const chunk of request.iterator({ destroyOnReturn: false })) {
          size += chunk.length;
          if (size > limit) {
            request.resume();
            reply(413, { error: { code: 'BODY_TOO_LARGE', message: '请求内容过长。' } });
            return;
          }
          chunks.push(chunk);
        }
        const bytes = Buffer.concat(chunks, size);
        if (isUpload) {
          body = bytes;
        } else {
          try {
            body = JSON.parse(bytes.toString('utf8'));
          } catch {
            reply(400, { error: { code: 'INVALID_JSON', message: '请求格式无效。' } });
            return;
          }
        }
      }
      // Only this loopback preview maps routes to synthetic users. Real auth supplies context separately.
      const result = await demo.dispatch(role === 'professional' ? 'reviewer' : role,
        request.method, url.pathname + url.search, body, contentType);
      if (Buffer.isBuffer(result.body)) {
        response.writeHead(result.status, result.headers);
        response.end(result.body);
        return;
      }
      reply(result.status, result.body);
    } catch {
      reply(500, { error: { code: 'PREVIEW_ERROR', message: '本地演示暂时不可用。' } });
    }
  });
  try {
    if (sample) {
      await seedReportSample(demo);
      await seedElectricitySample(demo);
    }
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
  } catch (error) {
    await Promise.all([demo.close(), quarantine.close()]);
    throw error;
  }
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    async close() {
      await new Promise(resolve => server.close(resolve));
      await Promise.all([demo.close(), quarantine.close()]);
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const executablePath = process.env.CARBON_PDF_CHROMIUM_PATH;
  const preview = await startPreview(Number(process.env.CARBON_PREVIEW_PORT ?? 4173), {
    sample: process.argv.includes('--sample'),
    renderDeliveryPdf: executablePath ? createDeliveryPdfRenderer({executablePath}) : undefined
  });
  console.log(`客户首页 ${preview.origin}/\n专业作业台 ${preview.origin}/professional\n七项业务 ${preview.origin}/modules\n企业工作台 ${preview.origin}/customer\n组织审计 ${preview.origin}/admin`);
  process.once('SIGINT', () => preview.close());
}
