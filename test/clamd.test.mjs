import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import test from 'node:test';
import { createClamdScanner } from '../infra/clamd.mjs';

const bytes = Buffer.alloc(260, 0xff);
const versionReply = 'ClamAV 1.5.2/27831/Fri Nov  6 00:00:00 2026\0';
const length = Buffer.alloc(4);
length.writeUInt32BE(bytes.length);
const scanRequest = Buffer.concat([Buffer.from('zINSTREAM\0'), length, bytes, Buffer.alloc(4)]);

async function startFixture(t, { version = versionReply, scan = 'stream: OK\0' } = {}) {
  const commands = [];
  const server = createServer((socket) => {
    let request = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      request = Buffer.concat([request, chunk]);
      if (request.equals(Buffer.from('zVERSION\0'))) {
        commands.push('VERSION');
        socket.end(version);
      } else if (request.length >= scanRequest.length) {
        assert.deepEqual(request, scanRequest);
        commands.push('INSTREAM');
        if (scan !== null) {
          socket.write(scan.slice(0, 4));
          setImmediate(() => socket.end(scan.slice(4)));
        }
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { commands, scanBytes: createClamdScanner({ port: server.address().port, timeoutMs: 500 }) };
}

test('ClamD protocol writes the exact byte frame and parses a clean verdict with version', async (t) => {
  const { commands, scanBytes } = await startFixture(t);
  assert.deepEqual(await scanBytes(bytes), { verdict: 'pass', engine: 'ClamAV', signatureVersion: '27831' });
  assert.deepEqual(commands, ['VERSION', 'INSTREAM']);
});

test('ClamD protocol rejects detections, including configured limit alerts', async (t) => {
  const { scanBytes } = await startFixture(t, { scan: 'stream: Heuristics.Limits.Exceeded FOUND\0' });
  assert.deepEqual(await scanBytes(bytes), { verdict: 'rejected', engine: 'ClamAV', signatureVersion: '27831' });
});

test('ClamD protocol leaves errors, incomplete frames and timeouts without a verdict', async (t) => {
  for (const [scan, message] of [
    ['INSTREAM size limit exceeded. ERROR\0', /did not return a verdict/],
    ['stream: OK', /Invalid ClamD reply framing/],
    [null, /timed out/],
  ]) {
    const { scanBytes } = await startFixture(t, { scan });
    await assert.rejects(scanBytes(bytes), message);
  }
});

test('ClamD protocol never streams a receipt when the signature version is unavailable', async (t) => {
  const { commands, scanBytes } = await startFixture(t, { version: 'ClamAV 1.5.2\0' });
  await assert.rejects(scanBytes(bytes), /Missing ClamD signature version/);
  assert.deepEqual(commands, ['VERSION']);
});
