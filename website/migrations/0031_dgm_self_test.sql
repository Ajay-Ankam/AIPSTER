-- Built with Meta Muse.
-- Migration 0031: durable store for the Worker-cron DGM self-test.
--
-- dgm_self_tests keeps one row per scheduled run (cron or manual): the
-- frozen snapshot JSON on success, or the refusal code on failure. The
-- snapshot is synthetic-only evaluation output; no prompts, payloads, keys,
-- or provider material ever land here. Retention (newest 400) is enforced
-- by runtime code, not by trigger, so the table stays append-only here.
-- Additive only; applies once via the D1 migration journal.
-- scheduled_at: the cron controller's scheduledTime (null for manual runs);
-- ran_at is execution time. routing_json: the sanitized aggregate of real
-- routing decisions in the 24 h before the run, stored beside the
-- deterministic snapshot so a telemetry failure never masks an evaluation.
CREATE TABLE IF NOT EXISTS dgm_self_tests (
  id TEXT PRIMARY KEY,
  ran_at TEXT NOT NULL,
  scheduled_at TEXT,
  trigger_kind TEXT NOT NULL,
  state TEXT NOT NULL,
  code TEXT,
  cron TEXT,
  duration_ms INTEGER,
  snapshot_json TEXT,
  routing_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dgm_self_tests_ran ON dgm_self_tests(ran_at DESC);
