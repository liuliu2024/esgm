import { randomUUID } from 'node:crypto';
import { MAX_EVIDENCE_FILE_BYTES } from '../src/index.mjs';

const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const evidenceUpload = /^\/v1\/customer\/cases\/[^/]+\/evidence\/[^/]+\/file$/;
const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);

// The resolver verifies credentials and maps identities to platform UUIDs.
// Configure the canonical public origin for browser writes; headerless API
// clients may use a resolver-backed credential without an origin.
export function createAuthenticatedHandler({api, authenticate, publicOrigin}) {
  if (typeof api?.dispatch !== 'function' || typeof authenticate !== 'function') {
    throw new TypeError('An API and a trusted session resolver are required');
  }
  if (publicOrigin !== undefined) {
    const origin = typeof publicOrigin === 'string' ? URL.parse(publicOrigin) : null;
    if (!origin || !['http:', 'https:'].includes(origin.protocol) || origin.origin !== publicOrigin) {
      throw new TypeError('publicOrigin must be a canonical HTTP or HTTPS origin');
    }
  }

  return async function authenticatedHandler(request, response) {
    function reply(status, payload) {
      const body = JSON.stringify(payload);
      response.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
      response.end(body);
    }
    function reject(status, code, message) {
      reply(status, {error: {code, message}});
    }

    try {
      const {method, url: path, headers} = request;
      if (!path?.startsWith('/v1/')) {
        reject(404, 'ROUTE_NOT_FOUND', '未找到该操作。');
        return;
      }
      const session = await authenticate(request);
      const {actorId, tenantId, orgId} = session ?? {};
      if (typeof actorId !== 'string' || !uuid.test(actorId) || typeof tenantId !== 'string' || !uuid.test(tenantId)
        || (orgId !== undefined && (typeof orgId !== 'string' || !uuid.test(orgId)))) {
        reject(401, 'AUTHENTICATION_REQUIRED', '需要有效的工作空间会话。');
        return;
      }

      const origin = headers.origin;
      const site = headers['sec-fetch-site'];
      if (!safeMethods.has(method) && (site === 'cross-site' || site === 'same-site'
        || (origin !== undefined && origin !== publicOrigin) || (site !== undefined && publicOrigin === undefined))) {
        reject(403, 'CROSS_ORIGIN_REQUEST', '该操作仅接受同源请求。');
        return;
      }

      let body;
      const contentType = headers['content-type']?.split(';')[0].trim().toLowerCase();
      if (method === 'POST') {
        const upload = evidenceUpload.test(path.split('?')[0]);
        const accepted = upload ? contentType === 'application/pdf' || contentType === 'image/png' : contentType === 'application/json';
        if (!accepted) {
          if (upload) reject(415, 'EVIDENCE_TYPE_REQUIRED', '请提供 PDF 或 PNG 文件。');
          else reject(415, 'JSON_REQUIRED', '请提交 JSON 请求。');
          return;
        }
        const limit = upload ? MAX_EVIDENCE_FILE_BYTES : 8192;
        const chunks = [];
        let size = 0;
        for await (const chunk of request.iterator({destroyOnReturn: false})) {
          size += chunk.length;
          if (size > limit) {
            request.resume();
            reject(413, 'BODY_TOO_LARGE', '请求内容过长。');
            return;
          }
          chunks.push(chunk);
        }
        const bytes = Buffer.concat(chunks, size);
        if (upload) {
          body = bytes;
        } else {
          try {
            body = JSON.parse(bytes.toString('utf8'));
          } catch {
            reject(400, 'INVALID_JSON', '请求格式无效。');
            return;
          }
        }
      }

      const context = {actorId, tenantId, requestId: randomUUID(), ...(orgId !== undefined && {orgId})};
      const result = await api.dispatch({method, path, body, contentType}, context);
      reply(result.status, result.body);
    } catch {
      reject(500, 'AUTHENTICATED_HTTP_ERROR', '暂时无法处理请求。');
    }
  };
}
