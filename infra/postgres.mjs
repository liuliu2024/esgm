import pg from 'pg';

export function connectPostgres(connectionString, { migration = false, scanner = false, calculationWorker = false, max = 4 } = {}) {
  if (!connectionString) throw new Error('Database connection string is required');
  const expectedRole = calculationWorker ? 'carbon_calculation_worker' : scanner ? 'carbon_scanner' : 'carbon_app';
  const otherRoles = ['carbon_app', 'carbon_scanner', 'carbon_calculation_worker'].filter(role => role !== expectedRole);
  const pool = new pg.Pool({ connectionString, max, connectionTimeoutMillis: 5000 });
  return {
    async transaction(callback) {
      const client = await pool.connect();
      let discard = false;
      try {
        await client.query('BEGIN');
        if (!migration) {
          const { rows } = await client.query(`SELECT
            NOT role.rolsuper AND NOT role.rolbypassrls
            AND NOT role.rolcreaterole AND NOT role.rolcreatedb AND NOT role.rolreplication
            AND NOT pg_has_role(current_user, schema.nspowner, 'MEMBER')
            AND pg_has_role(current_user, $1::name, 'USAGE')
            AND NOT EXISTS (
              SELECT 1 FROM pg_roles AS other
              WHERE other.rolname::text = ANY($2::text[])
                AND pg_has_role(current_user, other.oid, 'MEMBER')
            ) AS runtime_ok
            FROM pg_roles role CROSS JOIN pg_namespace schema
            WHERE role.rolname = current_user AND schema.nspname = 'carbon'`, [expectedRole, otherRoles]);
          if (!rows[0]?.runtime_ok) throw new Error('Refusing an overprivileged or unconfigured runtime database role');
          await client.query("SET LOCAL statement_timeout = '10s'");
        }
        const result = await callback({
          query: (sql, parameters) => client.query(sql, parameters),
          exec: sql => client.query(sql)
        });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          discard = true;
        }
        throw error;
      } finally {
        client.release(discard);
      }
    },
    close: () => pool.end()
  };
}
