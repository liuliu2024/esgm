import { createHash } from 'node:crypto';

export function createEvidenceScanner({ database, quarantine, scanner }) {
  function inTenant(tenantId, command) {
    return database.transaction(async tx => {
      await tx.query("SELECT set_config('carbon.tenant_id', $1, true)", [tenantId]);
      return command(tx);
    });
  }

  return async function scanReceipt(tenantId, receiptId) {
    const receipt = await inTenant(tenantId, async tx => {
      const { rows } = await tx.query(`
        SELECT receipt.org_id, receipt.case_id, receipt.evidence_id, receipt.byte_size,
          receipt.sha256, scan.verdict
        FROM carbon.evidence_receipt AS receipt
        LEFT JOIN carbon.evidence_scan AS scan ON scan.receipt_id = receipt.id
        WHERE receipt.tenant_id = $1 AND receipt.id = $2
      `, [tenantId, receiptId]);
      return rows[0];
    });
    if (!receipt) throw new Error('No receipt is available in this workspace');
    if (receipt.verdict) return { receiptId, verdict: receipt.verdict };

    const bytes = await quarantine.read(receiptId);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (bytes.length !== receipt.byte_size || sha256 !== receipt.sha256) {
      throw new Error('Quarantined bytes do not match the receipt');
    }

    const { verdict, engine, signatureVersion } = await scanner(bytes);
    await inTenant(tenantId, tx => tx.query(`
      INSERT INTO carbon.evidence_scan
        (tenant_id, org_id, case_id, evidence_id, receipt_id, sha256, verdict, engine, signature_version)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [tenantId, receipt.org_id, receipt.case_id, receipt.evidence_id, receiptId, sha256,
      verdict, engine, signatureVersion]));
    return { receiptId, verdict };
  };
}
