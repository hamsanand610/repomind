# ADR 0005: Invitations and individual accounts

**Status:** accepted (2026-10-11). Supersedes the account part of ADR 0001 §7.

## Context

Until now, an account was a code in the `INVITE_CODES` Worker secret. Each code was one account (its owner ID is a hash of the code), with these consequences:
- **Shared and permanent.** Everyone who held a code shared one account. Codes never expired and could be used any number of times.
- **Adding a person meant editing the secret.** That replaced the whole list.
- **No way to block one person** without removing the code, and no way for a person to replace a leaked code.

The goal is for more than ten people to use RepoMind, each with their own account, while staying invite-only and on the Cloudflare Free plan, with no email service.

## Options compared

| Option | Verdict |
|---|---|
| More codes in `INVITE_CODES` | Still shared, permanent and reusable; every change replaces the secret. Rejected. |
| Email sign-in links | Needs an email service (a new dependency and personal data). Rejected. |
| Passkeys (WebAuthn) | Strong, but a large amount of new code to verify attestation without libraries, and a lost device needs a recovery path anyway. Deferred. |
| GitHub sign-in | Ties accounts to GitHub and to the private-repository work that is on hold. Rejected for now. |
| **Single-use invitations, then a personal sign-in key** | Small, no personal data, no new service. **Chosen.** |

## Decision

1. **Invitations** are issued by an administrator with `scripts/admin.ts`:
   - A code is `rmi_` + 26 base32 characters (128 random bits), generated on the administrator's machine.
   - Only its SHA-256 digest is stored, in the `invitations` table, with an expiry (1–30 days; default 7) and an optional short label.
   - The code is printed once for the administrator to send privately.
2. **Who is an administrator:** whoever can run `wrangler d1 execute` against the production database, that is, someone logged in to the Cloudflare account. The Worker has **no admin endpoint**, so there is nothing to protect with a separate admin password and nothing an ordinary user could reach.
3. **Redeeming** (`POST /api/auth/redeem`) happens in one D1 batch, which is one transaction:
   - **Claim.** A conditional `UPDATE` claims the invitation only while it is unused, unrevoked and unexpired. It writes a random claim ID.
   - **Create.** An `INSERT … WHERE EXISTS (claim)` creates the account: a random owner ID, plus the digest of a new personal sign-in key.
   - **Concurrent requests.** Only the request whose claim ID was written succeeds; the others are told the invitation was used.
   - **Recovery invitations** (`purpose = 'recovery'`) replace the sign-in key of an existing invited account instead. They also increase its session epoch, which ends its other sessions.
4. **The personal sign-in key** is `rmk_` + 32 base32 characters (160 random bits):
   - It is returned once, in the response that creates the account. That response, like every API response, is `no-store`.
   - Only its digest is stored, so a lost key can be replaced only by a recovery invitation.
5. **Sessions** stay HMAC-signed cookies (HttpOnly, Secure, SameSite=Strict, 7 days):
   - An invited account's session carries the account's session epoch, and every request checks it against D1. Disabling the account (`disabled_at`) or replacing its key ends every session at once.
   - Sessions of `INVITE_CODES` accounts are unchanged and still need their code in the secret.
   - A token of one kind cannot pass as the other.
6. **Rate limits:** sign-in and redemption share one budget of 10 attempts per 15 minutes per client address (hashed). With 128- and 160-bit secrets, guessing is not feasible anyway.
7. **Errors** say exactly what is wrong for someone who holds a real code: not valid, already used, expired, withdrawn, or account disabled. A random guess only ever learns "not valid".
8. **Ownership is unchanged:** every repository endpoint looks the repository up by owner ID first (another account's repository answers 404), and search and answers only use the chunks of that repository's active version. An invited account is as isolated as any other. An invitation grants access to RepoMind, never to another account's repositories.
9. **The repository limit** (5 per account, `MAX_REPOS_PER_OWNER`) is now checked inside each `INSERT INTO repos … SELECT … WHERE (count) < limit`. Previously it was a separate count followed by an insert, which concurrent adds could exceed (reproduced: 7 repositories). An early count still refuses before any GitHub call.

## Schema (migration 0006)

- **`owners`:** `key_hash` (unique when set), `session_epoch`, `disabled_at`, `last_sign_in_at`.
- **`invitations`:** `id`, `code_hash` (unique), `purpose`, `owner_id`, `label`, `created_at`, `expires_at`, `redeemed_at`, `revoked_at`, `claim_id`.

No personal data is collected: no name, no email. The optional label is written by the administrator.

## Administrator workflow

```
npm run admin -- invite --remote [--days 7] [--count 1] [--label "for Sam"]
npm run admin -- invitations --remote          # status of each (never the codes)
npm run admin -- revoke <invitation-id> --remote
npm run admin -- accounts --remote             # accounts, repository counts, last sign-in
npm run admin -- disable <account-id> --remote # signs it out everywhere; repositories kept
npm run admin -- enable <account-id> --remote
npm run admin -- recover <account-id> --remote # a recovery code for a lost key
```

`--local` (with `--config` and `--persist-to`) targets a local development database instead. A target is always required, so the CLI never touches production by accident.

## Consequences

- **More than ten people,** each with a private account. No redeploy per person; no shared code.
- **One extra D1 read** per request from an invited account (the session check).
- **Losing the sign-in key locks the person out** until an administrator issues a recovery code. The UI says this before the key is dismissed and offers copy and download.
- **Signing out clears the cookie only.** A copied session cookie stays valid for up to 7 days unless the account is disabled or its key replaced. That is the same as before.
- **No self-service account deletion yet.** People can delete their repositories; an administrator can disable an account.
- **`INVITE_CODES` accounts keep working.** The owner's existing account and its repositories are untouched. New people should get invitations instead.
