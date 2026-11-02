-- Built with Meta Muse.
-- Migration 0026: DGM Muse proposal operations ledger.
-- dgm_muse_ops: per-tenant idempotency + uncertain-outcome state for POST
-- /api/admin/v1/dgm/preview/muse/proposals. The op key binds one canonical
-- input digest; retries with the same key and digest reuse the operation,
-- changed prompts are rejected, and a lost provider response leaves
-- state='uncertain' (never a silent duplicate chargeable call). States:
-- reserved|fetching|delivered|failed|uncertain|cancelled. Only sanitized
-- receipts persist here — never raw prompts, proposal text, or provider
-- bodies. Applies once via the D1 journal.
CREATE TABLE IF NOT EXISTS dgm_muse_ops (
  tenant_id TEXT NOT NULL REFERENCES "user"(id),
  op_key TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  state TEXT NOT NULL,
  receipt_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, op_key)
);
CREATE INDEX IF NOT EXISTS idx_dgm_muse_ops_state ON dgm_muse_ops(tenant_id, state);
