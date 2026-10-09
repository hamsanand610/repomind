-- RepoMind initial schema. All timestamps are Unix milliseconds.

CREATE TABLE owners (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE repos (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  gh_owner TEXT NOT NULL,
  gh_repo TEXT NOT NULL,
  -- '' means "the default branch"; NULLs would defeat the UNIQUE constraint.
  requested_ref TEXT NOT NULL DEFAULT '',
  default_branch TEXT,
  active_version_id TEXT,
  latest_version_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (owner_id, gh_owner, gh_repo, requested_ref)
);
CREATE INDEX repos_owner ON repos (owner_id);

-- One indexing attempt of a repository at a pinned commit.
CREATE TABLE versions (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  ref TEXT NOT NULL,
  -- indexing | embedding | ready | failed | superseded
  status TEXT NOT NULL,
  -- JSON admission report: estimate, budget, decision, skip counts, exclusions.
  admission TEXT NOT NULL,
  files_total INTEGER NOT NULL DEFAULT 0,
  files_cursor INTEGER NOT NULL DEFAULT 0,
  chunks_total INTEGER NOT NULL DEFAULT 0,
  chunks_embeddable INTEGER NOT NULL DEFAULT 0,
  chunks_embedded INTEGER NOT NULL DEFAULT 0,
  embedding_model TEXT,
  embedding_dims INTEGER,
  -- Why semantic search is off for this version, if it is (e.g. quota).
  embedding_note TEXT,
  error_code TEXT,
  error_message TEXT,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  -- Crash guard: a step that keeps dying at the same cursor (e.g. CPU limit)
  -- is retried with one file, then that file is skipped with a reason.
  step_cursor INTEGER NOT NULL DEFAULT -1,
  step_attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX versions_repo ON versions (repo_id);
CREATE INDEX versions_active_work ON versions (status, next_attempt_at);

-- The admitted file list, stored once per version (one row keeps the
-- per-invocation D1 query count low).
CREATE TABLE version_plans (
  version_id TEXT PRIMARY KEY,
  plan TEXT NOT NULL
);

CREATE TABLE files (
  version_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  path TEXT NOT NULL,
  language TEXT NOT NULL,
  size INTEGER NOT NULL,
  -- indexed | skipped
  status TEXT NOT NULL,
  skip_reason TEXT,
  line_count INTEGER NOT NULL DEFAULT 0,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  secrets_redacted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (version_id, ordinal)
);
CREATE INDEX files_path ON files (version_id, path);

CREATE TABLE chunks (
  id TEXT NOT NULL UNIQUE,
  version_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  text TEXT NOT NULL,
  embeddable INTEGER NOT NULL,
  embedded INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX chunks_file ON chunks (version_id, ordinal, seq);
CREATE INDEX chunks_pending_embedding ON chunks (version_id, embedded, embeddable);

-- Keyword index. A regular (not external-content) FTS5 table keyed by the
-- chunk's rowid, so deleting a version is a plain DELETE without triggers.
CREATE VIRTUAL TABLE chunks_fts USING fts5 (text, tokenize = 'unicode61');

-- Fixed-window counters for rate limits and quota ledgers.
CREATE TABLE usage_counters (
  scope TEXT NOT NULL,
  bucket TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (scope, bucket)
);
