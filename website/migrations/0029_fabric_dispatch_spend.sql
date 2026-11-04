-- Fabric dispatch accounting: cumulative per-grant spend counters.
--
-- Restricted demo policy (see FEDERATION-INTEGRATION-RESULT.md): a fabric
-- grant's spend is cumulative for its STABLE grant id, carries across
-- revisions (no replenish on revise/resume), and new holds fail closed
-- when live ceilings are below held+spent. The task's ordering
-- instruction explicitly forbids claiming a pre-existing period the PRD
-- never specified: no window semantics are added here, only counters.
-- Additive and lossless: existing rows default to zero spent.
ALTER TABLE fabric_grants ADD COLUMN used_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE fabric_grants ADD COLUMN used_jobs INTEGER NOT NULL DEFAULT 0;
