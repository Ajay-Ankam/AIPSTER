-- Built with Meta Muse.
-- Migration 0028: aggregate DGM Muse spend accounting and durable unknown-
-- outcome marking.
--
-- dgm_muse_spend is the atomic, deployment-wide reservation ledger for live
-- DGM Muse proposals. It exists because a per-request cap is not a bound:
-- every live admission adds its worst-case cost to reserved_micros with ONE
-- conditional UPDATE (increment only while the aggregate stays within the
-- operator cap), so concurrent and sequential admissions serialize in
-- SQLite/D1 and the total can never exceed the cap. Integer micro-USD keeps
-- the arithmetic exact.
--
-- The scope='global' window_key='all-time' row is created lazily by the
-- first live admission (INSERT OR IGNORE in the same batch as the atomic
-- increment), so this migration seeds no data and a copied/synthetic
-- database cannot conflict with it. An absent row means no live reservation
-- has ever been admitted in this deployment.
--
-- Scope/window are explicit and fixed in this code path: scope='global'
-- (all tenants), window_key='all-time' (never resets automatically). A
-- cancellation, TTL cleanup of dgm_muse_ops, missing usage from the
-- provider, or a brand-new op key cannot release or reset a reservation;
-- only an operator database action outside this API could, and that is not
-- an API affordance. used_micros records reported actual usage for delivered
-- calls and never reduces reserved_micros.
--
-- dgm_muse_ops.unknown_outcome marks an op whose provider outcome is
-- unknown (the call may have been sent). Cancellation preserves the mark, so
-- a local cancel alone cannot re-open automatic admission; an explicit
-- operator reconciliation action closes it. spend_micros keeps the durable
-- per-op reservation even if the receipt JSON is unreadable.
--
-- The column default is 0, which is wrong for rows the previous code already
-- left undecided. The backfill below derives the conservative value from the
-- state and from retained receipt evidence: an uncertain op, a live fetch, or
-- a cancellation recorded while fetching (or after contact) may have reached
-- the provider and must stay quarantined. A cancellation recorded before
-- contact stays 0 and remains usable. Fixture mode has no provider transport,
-- so its fetching phase and the cancelledFrom literal are not contact
-- evidence; NULL/unknown mode stays conservative. Actual contact fields are
-- mode-independent, so fabricated sent evidence still quarantines a fixture
-- row. Runtime code applies the same rule on every cancel/read, so the
-- invariant does not depend on this backfill alone or on a future writer
-- remembering the column.
-- Additive only; applies once via the D1 migration journal.
CREATE TABLE IF NOT EXISTS dgm_muse_spend (
  scope TEXT NOT NULL,
  window_key TEXT NOT NULL,
  reserved_micros INTEGER NOT NULL DEFAULT 0,
  used_micros INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, window_key)
);
ALTER TABLE dgm_muse_ops ADD COLUMN unknown_outcome INTEGER NOT NULL DEFAULT 0;
ALTER TABLE dgm_muse_ops ADD COLUMN spend_micros INTEGER NOT NULL DEFAULT 0;
UPDATE dgm_muse_ops SET unknown_outcome = 1 WHERE state = 'uncertain';
UPDATE dgm_muse_ops SET unknown_outcome = 1
  WHERE state = 'fetching' AND (mode IS NULL OR mode <> 'fixture');
UPDATE dgm_muse_ops SET unknown_outcome = 1
  WHERE state = 'cancelled' AND (
    receipt_json LIKE '%"providerContact":"sent"%'
    OR receipt_json LIKE '%"providerContact":"unknown"%'
    OR receipt_json LIKE '%"acceptance":"accepted"%'
    OR receipt_json LIKE '%"acceptance":"unknown"%'
    OR receipt_json LIKE '%"billing":"possibly-chargeable"%'
    OR receipt_json LIKE '%"accepted":true%'
    OR receipt_json LIKE '%"accepted": true%'
    OR (receipt_json LIKE '%"cancelledFrom":"fetching"%'
      AND (mode IS NULL OR mode <> 'fixture'))
  );
CREATE INDEX IF NOT EXISTS idx_dgm_muse_ops_unknown ON dgm_muse_ops(tenant_id, unknown_outcome);
