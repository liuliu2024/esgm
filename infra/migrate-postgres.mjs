import { connectPostgres } from './postgres.mjs';
import { migrate } from './migrations.mjs';

const database = connectPostgres(process.env.MIGRATION_DATABASE_URL, { migration: true, max: 1 });
try {
  const applied = await migrate(database);
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'No pending migrations.');
} finally {
  await database.close();
}
