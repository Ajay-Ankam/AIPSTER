-- Built with Meta Muse.
-- Migration 0027: record the immutable claim-time mode on DGM Muse proposal ops.
-- The op's own mode (live/fixture) must survive cancellation and environment
-- changes: cancel receipts and replays derive mode/evaluation from this
-- column, never from the current DGM_MUSE_LIVE flag or key presence.
-- Applies once via the D1 journal; additive column only.
ALTER TABLE dgm_muse_ops ADD COLUMN mode TEXT;
