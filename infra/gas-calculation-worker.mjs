import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { createCarbonApi } from '../src/index.mjs';
import { connectPostgres } from './postgres.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const stableCode = /^[A-Z][A-Z0-9_]{0,199}$/;
const workerError = 'CALCULATION_WORKER_ERROR';

export async function runGasCalculationJob(workerDatabase, api, tenantId) {
  const lease = randomUUID();
  const inTenant = command => workerDatabase.transaction(async tx => {
    await tx.query("SELECT set_config('carbon.tenant_id', $1, true)", [tenantId]);
    return command(tx);
  });
  const {rows: [job]} = await inTenant(tx => tx.query(`
    SELECT id, org_id, case_id, submission_revision, created_by,
      to_char(from_period, 'YYYY-MM') AS "from", to_char(to_period, 'YYYY-MM') AS "to"
    FROM carbon.claim_gas_calculation_job($1, $2)`, [tenantId, lease]));
  if (!job) return null;

  let snapshotId = null;
  let errorCode = workerError;
  try {
    const response = await api.dispatch({
      method: 'POST',
      path: `/v1/customer/cases/${job.case_id}/revisions/${job.submission_revision}/gas-combustion/snapshots`,
      body: {orgId: job.org_id, from: job.from, to: job.to}
    }, {tenantId, actorId: job.created_by, requestId: randomUUID()});
    if ((response.status === 200 || response.status === 201) && uuid.test(response.body?.snapshotId)) {
      snapshotId = response.body.snapshotId;
      errorCode = null;
    } else if (typeof response.body?.error?.code === 'string' && stableCode.test(response.body.error.code)) {
      errorCode = response.body.error.code;
    }
  } catch {
    // Store the fixed failure code without including the exception or input data.
  }
  const {rows: [{finished}]} = await inTenant(tx => tx.query(
    'SELECT carbon.finish_gas_calculation_job($1, $2, $3, $4, $5) AS finished',
    [tenantId, job.id, lease, snapshotId, errorCode]));
  return {jobId: job.id, finished};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [tenant, option, ...rest] = process.argv.slice(2);
  if (!uuid.test(tenant) || (option !== undefined && option !== '--once') || rest.length) {
    throw new Error('Usage: node infra/gas-calculation-worker.mjs <tenantId> [--once]');
  }
  const {CALCULATION_WORKER_DATABASE_URL, DATABASE_URL} = process.env;
  if (!CALCULATION_WORKER_DATABASE_URL || !DATABASE_URL) {
    throw new Error('CALCULATION_WORKER_DATABASE_URL and DATABASE_URL are required');
  }
  const tenantId = tenant.toLowerCase();
  const workerDatabase = connectPostgres(CALCULATION_WORKER_DATABASE_URL, {calculationWorker: true, max: 1});
  const appDatabase = connectPostgres(DATABASE_URL, {max: 1});
  const api = createCarbonApi(appDatabase);
  const stop = new AbortController();
  const stopWorker = () => stop.abort();
  process.once('SIGINT', stopWorker);
  process.once('SIGTERM', stopWorker);
  try {
    if (option === '--once') {
      const result = await runGasCalculationJob(workerDatabase, api, tenantId);
      console.log(JSON.stringify(result));
      if (result?.finished === false) process.exitCode = 1;
    } else {
      let idleMs = 500;
      while (!stop.signal.aborted) {
        const result = await runGasCalculationJob(workerDatabase, api, tenantId);
        if (result) {
          idleMs = 500;
        } else {
          await wait(idleMs, undefined, {signal: stop.signal});
          idleMs = Math.min(idleMs * 2, 5000);
        }
      }
    }
  } catch (error) {
    if (error?.name !== 'AbortError' || !stop.signal.aborted) {
      console.error('Calculation worker stopped. Check the configured database connections and worker permissions.');
      process.exitCode = 1;
    }
  } finally {
    process.off('SIGINT', stopWorker);
    process.off('SIGTERM', stopWorker);
    await Promise.all([workerDatabase.close(), appDatabase.close()]);
  }
}
