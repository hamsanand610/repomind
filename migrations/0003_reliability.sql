-- Consecutive handled errors (GitHub, network, Vectorize) for a version's
-- current unit of work. Kept apart from step_attempts, which counts steps
-- that may have been killed by the CPU limit, so a reported transient error
-- is retried with backoff instead of being mistaken for a crash.
ALTER TABLE versions ADD COLUMN error_attempts INTEGER NOT NULL DEFAULT 0;
