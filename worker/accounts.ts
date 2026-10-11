import { isInvitationCode, isSignInKey, newSignInKey, tokenDigest } from "../shared/accounts.ts";
import { HttpError } from "./http.ts";
import { type Database, randomId } from "./platform.ts";

/**
 * Individual accounts created from single-use invitations (migration 0006).
 *
 * - An administrator issues invitations with scripts/admin.ts, which stores
 *   only the code's SHA-256 digest. There is no admin endpoint in the Worker.
 * - Redeeming an invitation creates an account with a random ID and a new
 *   personal sign-in key, shown once. A recovery invitation replaces the key
 *   of an existing account instead, and ends its other sessions.
 * - One conditional UPDATE claims the invitation, writing a random claim ID,
 *   so two requests redeeming the same code cannot both succeed.
 */

export interface AccountSession {
  ownerId: string;
  epoch: number;
}

export interface Redemption extends AccountSession {
  purpose: "account" | "recovery";
  signInKey: string;
}

export async function redeemInvitation(db: Database, code: string, now: number): Promise<Redemption> {
  if (!isInvitationCode(code)) throw new HttpError(401, "invalid_invitation", "That invitation code is not valid. Check that you copied all of it.");
  const codeHash = await tokenDigest(code);
  const signInKey = newSignInKey();
  const keyHash = await tokenDigest(signInKey);
  const claimId = randomId("c");
  const newOwnerId = randomId("o");

  await db.batch([
    // The claim: only one request can see redeemed_at IS NULL. A recovery code
    // only works while its account exists, is invited and is not disabled.
    db
      .prepare(
        `UPDATE invitations SET redeemed_at = ?, claim_id = ?, owner_id = COALESCE(owner_id, ?)
         WHERE code_hash = ? AND redeemed_at IS NULL AND revoked_at IS NULL AND expires_at > ?
           AND (purpose = 'account' OR owner_id IN (SELECT id FROM owners WHERE key_hash IS NOT NULL AND disabled_at IS NULL))`,
      )
      .bind(now, claimId, newOwnerId, codeHash, now),
    db
      .prepare(
        `INSERT INTO owners (id, created_at, key_hash, session_epoch, last_sign_in_at)
         SELECT ?, ?, ?, 0, ? WHERE EXISTS (SELECT 1 FROM invitations WHERE code_hash = ? AND claim_id = ? AND purpose = 'account')`,
      )
      .bind(newOwnerId, now, keyHash, now, codeHash, claimId),
    db
      .prepare(
        `UPDATE owners SET key_hash = ?, session_epoch = session_epoch + 1, last_sign_in_at = ?
         WHERE id = (SELECT owner_id FROM invitations WHERE code_hash = ? AND claim_id = ? AND purpose = 'recovery')`,
      )
      .bind(keyHash, now, codeHash, claimId),
  ]);

  const claimed = await db
    .prepare(
      `SELECT i.purpose AS purpose, o.id AS owner_id, o.session_epoch AS epoch
       FROM invitations i JOIN owners o ON o.id = i.owner_id
       WHERE i.code_hash = ? AND i.claim_id = ?`,
    )
    .bind(codeHash, claimId)
    .first<{ purpose: "account" | "recovery"; owner_id: string; epoch: number }>();
  if (claimed) return { ownerId: claimed.owner_id, epoch: claimed.epoch, purpose: claimed.purpose, signInKey };
  throw await whyNotRedeemed(db, codeHash, now);
}

/** A specific, safe reason for someone who holds the code. */
async function whyNotRedeemed(db: Database, codeHash: string, now: number): Promise<HttpError> {
  const row = await db
    .prepare("SELECT purpose, redeemed_at, revoked_at, expires_at FROM invitations WHERE code_hash = ?")
    .bind(codeHash)
    .first<{ purpose: string; redeemed_at: number | null; revoked_at: number | null; expires_at: number }>();
  if (!row) return new HttpError(401, "invalid_invitation", "That invitation code is not valid. Check that you copied all of it.");
  if (row.revoked_at) return new HttpError(410, "invitation_revoked", "This invitation was withdrawn. Ask the person who sent it for a new one.");
  if (row.redeemed_at) {
    return new HttpError(409, "invitation_used", "This invitation has already been used. If it created your account, sign in with your sign-in key instead.");
  }
  if (row.expires_at <= now) return new HttpError(410, "invitation_expired", "This invitation has expired. Ask the person who sent it for a new one.");
  return new HttpError(403, "account_unavailable", "This recovery code is for an account that is no longer active.");
}

/** Signs in an invited account with its personal key. */
export async function signInWithKey(db: Database, key: string, now: number): Promise<AccountSession> {
  if (!isSignInKey(key)) throw new HttpError(401, "unauthorized", "That sign-in key is not valid.");
  const row = await db
    .prepare("SELECT id, session_epoch, disabled_at FROM owners WHERE key_hash = ?")
    .bind(await tokenDigest(key))
    .first<{ id: string; session_epoch: number; disabled_at: number | null }>();
  if (!row) throw new HttpError(401, "unauthorized", "That sign-in key is not valid.");
  if (row.disabled_at) throw new HttpError(403, "account_disabled", "This account has been disabled. Contact the person who runs RepoMind.");
  await db.prepare("UPDATE owners SET last_sign_in_at = ? WHERE id = ?").bind(now, row.id).run();
  return { ownerId: row.id, epoch: row.session_epoch };
}

/** True while an invited account's session is current: not disabled, key not replaced since. */
export async function accountSessionIsCurrent(db: Database, session: AccountSession): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS ok FROM owners WHERE id = ? AND key_hash IS NOT NULL AND disabled_at IS NULL AND session_epoch = ?")
    .bind(session.ownerId, session.epoch)
    .first<{ ok: number }>();
  return row !== null;
}
