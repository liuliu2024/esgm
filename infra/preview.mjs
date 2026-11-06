import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { startDemo } from './demo-data.mjs';
import { createLocalQuarantine } from './local-quarantine.mjs';
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
}

export async function startPreview(port = 0, { sample = false } = {}) {
  const quarantine = await createLocalQuarantine();
  const demo = await startDemo({ quarantine }).catch(async error => {
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
  const preview = await startPreview(Number(process.env.CARBON_PREVIEW_PORT ?? 4173), {
    sample: process.argv.includes('--sample')
  });
  console.log(`客户首页 ${preview.origin}/\n专业作业台 ${preview.origin}/professional\n七项业务 ${preview.origin}/modules\n企业工作台 ${preview.origin}/customer\n组织审计 ${preview.origin}/admin`);
  process.once('SIGINT', () => preview.close());
}
