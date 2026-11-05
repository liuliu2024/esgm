import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { startDemo } from './demo-data.mjs';
import { createLocalQuarantine } from './local-quarantine.mjs';
import { MAX_EVIDENCE_FILE_BYTES } from '../src/index.mjs';

const pages = {
  '/': 'customer.html',
  '/customer': 'customer.html',
  '/professional': 'professional.html',
  '/admin': 'admin.html',
  '/shared.css': 'shared.css',
  '/shared.mjs': 'shared.mjs',
  '/customer.mjs': 'customer.mjs',
  '/professional.mjs': 'professional.mjs',
  '/admin.mjs': 'admin.mjs'
};
const mediaTypes = { html: 'text/html', css: 'text/css', mjs: 'text/javascript' };

export async function startPreview(port = 0) {
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
  const preview = await startPreview(4173);
  console.log(`企业前台 ${preview.origin}/customer\n专业作业台 ${preview.origin}/professional\n管理审计 ${preview.origin}/admin`);
  process.once('SIGINT', () => preview.close());
}
