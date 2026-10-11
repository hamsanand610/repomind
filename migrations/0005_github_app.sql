-- Private GitHub repositories through a GitHub App (ADR 0004).

-- One GitHub authorization per RepoMind owner. Tokens are AES-256-GCM
-- ciphertexts (worker/secrets.ts), never plaintext; the key is a Worker secret.
CREATE TABLE github_connections (
  owner_id TEXT PRIMARY KEY,
  github_user_id INTEGER NOT NULL,
  github_login TEXT NOT NULL,
  access_token_enc TEXT,
  access_expires_at INTEGER NOT NULL DEFAULT 0,
  refresh_token_enc TEXT,
  refresh_expires_at INTEGER NOT NULL DEFAULT 0,
  -- active | revoked
  status TEXT NOT NULL,
  -- Incremented on every token rotation, for compare-and-swap refreshes.
  generation INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Repositories added through the app (source 'github_app') keep GitHub's
-- immutable repository id, so a rename or a substituted name is detected.
ALTER TABLE repos ADD COLUMN gh_repo_id INTEGER;
-- Last successful access check with the owner's token, and when access was
-- first found lost (0 = not lost). Lost access blocks reads at once; the
-- repository is deleted after 7 days unless access returns.
ALTER TABLE repos ADD COLUMN access_checked_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE repos ADD COLUMN access_lost_at INTEGER NOT NULL DEFAULT 0;
