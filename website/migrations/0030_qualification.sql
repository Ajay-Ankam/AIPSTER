-- Built with Meta Muse. Meta-qualification lane (meta-qual).
-- Migration 0030: hardware qualification + benchmark records. Additive only:
-- new tables, no alters to existing tables. Spend counters reuse the shared
-- write_budget table with qual/ prefixes (no new counter table); aggregate
-- USD spend is tracked exactly in qualification_spend (integer micro-USD).
--
-- qualification_recommendations: per-request ops ledger. The op key binds one
-- canonical input digest; retries with the same key and digest reuse the
-- operation, changed payloads are rejected, and any live-path outcome that
-- is not a validated delivery leaves state='uncertain' (never a silent
-- duplicate chargeable call, never an auto-retry). States:
-- reserved|fetching|delivered|failed|uncertain. Fixture-only failures use
-- failed; live errors always use uncertain. Only sanitized receipts persist
-- here alongside the validated advice (replayed to later same-profile keys).
-- Delivered/failed ops older than 7 days may be pruned; the stable cache in
-- qualification_cache is never pruned by age.
--
-- qualification_cache: stable recommendation cache, one row per
-- (owner, node, profile digest, catalog, prompt, mode). Fixture rows never
-- satisfy live lookups and vice versa. Uncertain outcomes are NOT cached:
-- they stay on the ops ledger and block new keys for the same identity
-- until reconciled, so an unknown outcome can never be bypassed with a
-- fresh key. No timestamps or volatile facts enter the digest.
--
-- qualification_runs: benchmark runs. The execution deadline is set when the
-- worker lease is claimed (not at enqueue); results are accepted only from
-- leased runs inside deadline+grace with full lease/node/owner/profile/
-- catalog/runtime binding. Late or changed-profile results become uncertain
-- (retained, never auto-rerun), never silently accepted as current.
CREATE TABLE IF NOT EXISTS qualification_recommendations (
  owner_id TEXT NOT NULL REFERENCES "user"(id),
  node_id TEXT NOT NULL REFERENCES resources(id),
  profile_digest TEXT NOT NULL,
  catalog_version TEXT NOT NULL DEFAULT 'qual-catalog-v1',
  prompt_version TEXT NOT NULL DEFAULT 'qual-prompt-v1',
  mode TEXT NOT NULL DEFAULT 'fixture',
  op_key TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  state TEXT NOT NULL,
  advice_json TEXT,
  receipt_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, op_key)
);
CREATE INDEX IF NOT EXISTS idx_qual_recs_node ON qualification_recommendations(owner_id, node_id);
CREATE INDEX IF NOT EXISTS idx_qual_recs_state ON qualification_recommendations(owner_id, state);
CREATE INDEX IF NOT EXISTS idx_qual_recs_cache ON qualification_recommendations(owner_id, node_id, profile_digest, catalog_version, prompt_version, mode, state);

CREATE TABLE IF NOT EXISTS qualification_cache (
  owner_id TEXT NOT NULL REFERENCES "user"(id),
  node_id TEXT NOT NULL REFERENCES resources(id),
  profile_digest TEXT NOT NULL,
  catalog_version TEXT NOT NULL DEFAULT 'qual-catalog-v1',
  prompt_version TEXT NOT NULL DEFAULT 'qual-prompt-v1',
  mode TEXT NOT NULL DEFAULT 'fixture',
  advice_json TEXT NOT NULL,
  receipt_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, node_id, profile_digest, catalog_version, prompt_version, mode)
);

CREATE TABLE IF NOT EXISTS qualification_spend (
  owner_id TEXT NOT NULL PRIMARY KEY,
  usd_micro INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS qualification_runs (
  run_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES "user"(id),
  node_id TEXT NOT NULL REFERENCES resources(id),
  profile_digest TEXT NOT NULL,
  catalog_version TEXT NOT NULL DEFAULT 'qual-catalog-v1',
  catalog_id TEXT NOT NULL DEFAULT 'completion-smoke-v1',
  lease_id TEXT NOT NULL,
  state TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'fixture',
  claim_by TEXT NOT NULL,
  execution_deadline TEXT,
  assignment_json TEXT,
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (owner_id, lease_id)
);
CREATE INDEX IF NOT EXISTS idx_qual_runs_node ON qualification_runs(owner_id, node_id, state);
