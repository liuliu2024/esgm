import { mkdtemp, open, readdir, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function createLocalQuarantine() {
  const directory = await mkdtemp(join(tmpdir(), 'carbon-quarantine-'));
  return {
    async write(id, bytes) {
      const path = join(directory, id);
      const handle = await open(path, 'wx', 0o600);
      try {
        await handle.writeFile(bytes).finally(() => handle.close());
      } catch (error) {
        await unlink(path).catch(() => {});
        throw error;
      }
    },
    async close() {
      for (const name of await readdir(directory)) await unlink(join(directory, name));
      await rmdir(directory);
    }
  };
}
