import { createConnection } from 'node:net';

export function createClamdScanner({ host = '127.0.0.1', port = 3310, timeoutMs = 10000 } = {}) {
  async function exchange(command, chunks = []) {
    const socket = createConnection({ host, port });
    const timeout = setTimeout(() => socket.destroy(new Error('ClamD request timed out')), timeoutMs);
    try {
      socket.write(`z${command}\0`);
      for (const chunk of chunks) socket.write(chunk);

      let reply = '';
      socket.setEncoding('utf8');
      for await (const chunk of socket) reply += chunk;
      if (!reply.endsWith('\0') || reply.indexOf('\0') !== reply.length - 1) {
        throw new Error('Invalid ClamD reply framing');
      }
      return reply.slice(0, -1);
    } finally {
      clearTimeout(timeout);
      socket.destroy();
    }
  }

  return async (bytes) => {
    const version = await exchange('VERSION');
    const signatureVersion = /^ClamAV [^/\s]+\/([1-9]\d{0,9})\/[^\r\n]+$/.exec(version)?.[1];
    if (!signatureVersion) throw new Error('Missing ClamD signature version');

    // Receipt bytes are already bounded by the intake limit, so one chunk is enough.
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    const reply = await exchange('INSTREAM', [length, bytes, Buffer.alloc(4)]);
    if (reply === 'stream: OK') return { verdict: 'pass', engine: 'ClamAV', signatureVersion };
    if (/^stream: [^\r\n]+ FOUND$/.test(reply)) {
      return { verdict: 'rejected', engine: 'ClamAV', signatureVersion };
    }
    throw new Error('ClamD scan did not return a verdict');
  };
}
