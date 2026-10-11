-- Individual accounts from single-use invitations (multi-user onboarding).
--
-- Invitation codes and personal sign-in keys are never stored, only their
-- SHA-256 digests. Accounts created from the INVITE_CODES secret keep working
-- unchanged (their key_hash stays NULL).

-- An invited account signs in with its own key. Bumping session_epoch ends
-- every session of the account; disabled_at blocks it.
ALTER TABLE owners ADD COLUMN key_hash TEXT;
ALTER TABLE owners ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE owners ADD COLUMN disabled_at INTEGER;
ALTER TABLE owners ADD COLUMN last_sign_in_at INTEGER;
CREATE UNIQUE INDEX owners_key_hash ON owners (key_hash) WHERE key_hash IS NOT NULL;

-- Issued by an administrator with scripts/admin.ts. 'account' creates a new
-- account; 'recovery' replaces the sign-in key of an existing one (owner_id).
-- claim_id is a random value written by the one request that redeems it.
CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  purpose TEXT NOT NULL DEFAULT 'account' CHECK (purpose IN ('account', 'recovery')),
  owner_id TEXT,
  label TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  redeemed_at INTEGER,
  revoked_at INTEGER,
  claim_id TEXT
);
