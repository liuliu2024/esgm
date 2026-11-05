import { PGlite } from '@electric-sql/pglite';

// Test-only adapter. One in-process PostgreSQL connection, no network listener.
export async function createEmbeddedDatabase() {
  const engine = await PGlite.create();
  const transaction = (callback, runtime) => engine.transaction(async client => {
    if (runtime) await client.exec('SET LOCAL ROLE carbon_app');
    return callback({
      query: (sql, parameters) => client.query(sql, parameters),
      exec: sql => client.exec(sql)
    });
  });
  return {
    admin: { transaction: callback => transaction(callback, false) },
    runtime: { transaction: callback => transaction(callback, true) },
    close: () => engine.close()
  };
}
