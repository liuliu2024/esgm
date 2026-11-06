import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

const defaultDirectory = new URL('../migrations/', import.meta.url);

export async function migrate(database, directory = defaultDirectory) {
  const filenames = (await readdir(directory)).filter(name => /^\d{3}_[a-z_]+\.sql$/.test(name)).sort();
  if (filenames.length === 0) throw new Error('No migrations were found');
  const versions = filenames.map(name => name.slice(0, 3));
  if (new Set(versions).size !== versions.length) throw new Error('Migration numbers must be unique');
  const migrations = await Promise.all(filenames.map(async name => {
    const sql = await readFile(new URL(name, directory), 'utf8');
    return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  }));

  return database.transaction(async client => {
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL statement_timeout = '60s'");
    await client.query('SELECT pg_advisory_xact_lock(917204, 1)');
    await client.query('CREATE SCHEMA IF NOT EXISTS carbon_migrations');
    await client.query('REVOKE ALL ON SCHEMA carbon_migrations FROM PUBLIC');
    await client.query(`CREATE TABLE IF NOT EXISTS carbon_migrations.applied (
      name text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query('SELECT name, checksum FROM carbon_migrations.applied ORDER BY name');
    for (const [index, applied] of rows.entries()) {
      const current = migrations[index];
      if (current?.name !== applied.name || current.checksum !== applied.checksum) {
        throw new Error(`Migration history differs at ${applied.name}`);
      }
    }
    const applied = [];
    for (const migration of migrations.slice(rows.length)) {
      await client.exec(migration.sql);
      await client.query('INSERT INTO carbon_migrations.applied (name, checksum) VALUES ($1, $2)',
        [migration.name, migration.checksum]);
      applied.push(migration.name);
    }
    return applied;
  });
}
