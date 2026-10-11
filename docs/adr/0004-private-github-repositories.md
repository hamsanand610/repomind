# ADR 0004: Private GitHub repositories

**Status:** Implemented (2026-10-11), behind configuration. The feature stays off until the owner registers the GitHub App and sets its secrets (see "Manual setup").

**Validation:**
- **Local:** 22 HTTP tests against a GitHub fake, plus token-sealing and UI tests.
- **Isolated Cloudflare deployment:** run with placeholder app settings, which checks everything that does not need GitHub to accept the app.
- **Production:** health and route protection only.
- **Not yet done:** a real connection to GitHub. That needs the owner's app and a GitHub sign-in in a browser.

## Context

Today RepoMind reads only public repositories. The browser lists files with no credentials, and the Worker downloads file contents from `raw.githubusercontent.com` with no token. Users also want to index private repositories they can read, without:
- giving RepoMind write access;
- trusting a URL as proof of access;
- leaking a private repository to another RepoMind user;
- adding paid infrastructure.

**GitHub facts relied on** (GitHub Docs, checked 2026-10-11):
- **What a token can reach.** A GitHub App *user access token* "only has permissions that both the user and the app have" and "can only access resources that both the user and app can access".
- **Listing that set.** `GET /user/installations` and `GET /user/installations/{id}/repositories` list exactly the installations and repositories that the user and the app can both reach.
- **Web flow.** It supports `state` and PKCE (`code_challenge`, S256 only). `redirect_uri` must match a registered callback URL.
- **Token lifetimes.** User access tokens (`ghu_`) expire after 8 hours. Refresh tokens (`ghr_`) last 6 months and are single-use: "Once you use a refresh token, that refresh token and the old user access token will no longer work."
- **Required permissions.** `GET /repos/{owner}/{repo}/contents/{path}`, `…/git/trees/{sha}` and `…/commits/{ref}` need **Contents: read**. `GET /repos/{owner}/{repo}` needs **Metadata: read**.
- **Untrusted redirects.** The `installation_id` passed to a setup URL can be spoofed and must not be trusted. GitHub advises checking installations with the user's own token.
- **Revoking.** An app authorization can be revoked through `DELETE /applications/{client_id}/grant`.

## Options compared

| Option | Permissions | Verdict |
|---|---|---|
| **GitHub App + user access tokens (chosen)** | Repository **Contents: read-only** and **Metadata: read-only**; nothing else | Least privilege. Access is the overlap of the user's access and the repositories the user installed the app on. It expires by default, and either party can revoke it. No private key or webhook is needed |
| GitHub App + installation tokens | Same | An installation token acts as the app. An org-wide installation would let any RepoMind user who links it read repositories they personally cannot see, unless every read is re-checked with a user token anyway. It also needs the app's private key in the Worker |
| OAuth App | `repo` scope | Rejected: `repo` grants **write** access to all private repositories; OAuth Apps have no read-only private scope |
| Fine-grained personal access token pasted by the user | Contents: read | Rejected: users would paste long-lived secrets into a web form and manage expiry themselves |

## Decision

1. **The GitHub App** is registered by the owner (manual step below). It has these permissions:
   - Repository permissions: **Contents: Read-only** and **Metadata: Read-only**.
   - No account or organisation permissions, no webhook and no events.
   - Expiring user tokens on (GitHub's default). "Request user authorization during installation" off, because that flow has no `state` RepoMind could verify.
2. **Connecting** uses the web flow, bound to the RepoMind session:
   - `POST /api/github/connect` (signed in, same-origin) creates a random `state` and a PKCE verifier. They go in an `HttpOnly; Secure; SameSite=Strict` cookie on `/api/github`, signed with HMAC-SHA-256 using `SESSION_SECRET`, holding the owner ID and a 10-minute expiry. Nothing is stored in D1.
   - GitHub redirects to the SPA route `/github/callback`, which removes `code` and `state` from the address bar. It then posts them to `POST /api/github/complete`.
   - That endpoint accepts them only when all of these hold:
     - the session's owner equals the cookie's owner;
     - the cookie is valid and unexpired;
     - `state` matches it in constant time.
   - The code is exchanged with the verifier and the exact `redirect_uri` (`<origin>/github/callback`). The cookie is cleared whatever the outcome.
3. **Credentials:**
   - **Storage.** The access and refresh tokens are encrypted with AES-256-GCM before they reach D1 (`github_connections.access_token_enc`, `refresh_token_enc`). The key comes from the Worker secret `GITHUB_TOKEN_KEY`. Each value has a random 96-bit nonce, and the additional authenticated data is the owner ID plus the field name, so a ciphertext cannot be moved to another row or field.
   - **Use.** Tokens are decrypted only inside the Worker, only to call `api.github.com` or `github.com/login/oauth`. They never appear in responses, logs, error messages or source control.
   - **Plain columns.** The client secret is a Worker secret. D1 stores only the GitHub user ID and login, the expiry times, a status and a generation counter.
4. **Choosing repositories:**
   - RepoMind lists only what the user's token can reach (`/user/installations` and their repositories, at most 300).
   - To add one, the browser sends the repository's numeric ID and full name. The server fetches `GET /repos/{owner}/{name}` with the user's token and requires the returned `id` to equal the claimed one. The listing in the browser is never trusted, and a public URL is never proof of access.
   - The repository record stores `source = 'github_app'` and the immutable `gh_repo_id`.
5. **Indexing:**
   - It uses the existing pinned-commit pipeline, but all GitHub reads go through the API with the owner's token: the repository, the commit and the tree, then file contents through `GET /repos/{owner}/{repo}/contents/{path}?ref={sha}` with the raw media type.
   - Admission, chunking, embedding, citations and line numbers are unchanged. Citations link to the commit on GitHub, which only people with access can open.
6. **Authorization on every operation:**
   - **Ownership.** Every repository endpoint is scoped by RepoMind owner, as today, and every GitHub call uses that owner's token, so GitHub enforces access.
   - **Re-checking access on reads.** Status, file list, file, Search, Ask, symbols, importers, architecture, re-index and cancel require a live connection for `github_app` repositories. They also require a successful access check (`GET /repos/{owner}/{name}` returning the same `id`) within the last 10 minutes; otherwise the check runs before answering.
   - **Definitive denial.** No connection, a revoked or expired authorization, or a 404, 401 or non-rate-limit 403 (for example organisation SSO enforcement) for the repository is denied (403, a fixed message, no GitHub detail) and recorded as access lost.
   - **Transient errors.** GitHub 5xx, network failures and rate limits are allowed only if the last successful check is less than 1 hour old; otherwise 503.
   - **Deletion** needs only ownership, so data can always be removed.
7. **Expiry, revocation and cleanup:**
   - **Refresh.** An access token within 5 minutes of expiry is refreshed with the refresh token. The new pair is stored with a compare-and-swap on the generation counter. A refresh that fails because another request already rotated the pair uses the stored new pair.
   - **Revocation.** A definitive refresh failure, or a 401 after refreshing, marks the connection revoked and deletes both tokens. All of the owner's `github_app` repositories are marked access-lost and blocked, and indexing in progress fails with `github_access_revoked`.
   - **Disconnect (user action).** RepoMind revokes the grant at GitHub (best effort). Then one D1 batch deletes the tokens and the connection, retires the versions of every `github_app` repository of that owner and deletes those repositories, so they disappear at once. Their files, chunks and vectors are removed by the existing cleanup (`/step` and the cron trigger) within minutes. Doing the cleanup inline could exceed the 50-queries-per-invocation limit for an owner with several private repositories.
   - **Automatic deletion.** A repository whose access stays lost for 7 days is deleted by the cron trigger. If access returns before then, the block lifts.
   - **Deleting a repository** uses the existing cleanup. It does not touch the GitHub authorization.
8. **Isolation:**
   - Two RepoMind users who connect the same GitHub account or repository each get their own token and their own index; nothing is shared.
   - Another user's repository ID answers 404, as today.
   - Private metadata (names, paths, chunks, citations, answers) is only ever returned to the owner who indexed it, and only while access holds.

## Cloudflare Free plan

- **No new resources.** It uses one D1 table and three columns (migration 0005), WebCrypto (AES-GCM, HMAC, SHA-256) and the existing cron trigger.
- **Subrequests per request** stay well under 50: completing the connection takes 2 calls to GitHub, adding a repository 3–4, and an indexing step at most 8 file reads plus a possible refresh.
- **Rate limits.** User tokens get 5,000 GitHub API requests an hour per user. Rate limits wait, as for public repositories.
- **Cost.** GitHub Apps are free, and no Cloudflare billing is involved.

## Manual setup (owner action; RepoMind cannot do this)

1. **Create the app.** Go to GitHub → Settings → Developer settings → GitHub Apps → **New GitHub App**:
   - **Homepage URL:** `https://repomind.repomind.workers.dev`
   - **Callback URL:** `https://repomind.repomind.workers.dev/github/callback`
   - **Expire user authorization tokens:** on. **Request user authorization (OAuth) during installation:** off. **Enable Device Flow:** off.
   - **Webhook → Active:** off.
   - **Repository permissions:** Contents → Read-only, Metadata → Read-only. Nothing else.
   - **Where can this GitHub App be installed:** "Only on this account", unless other GitHub accounts should use it.
2. **Get the client credentials.** After creating the app, copy the **Client ID** and the app's **slug** (from its public URL, `github.com/apps/<slug>`), and **generate a client secret**. No private key is needed.
3. **Set the Worker configuration** in `D:\REPO_MIND\repomind`. Never paste these into chat or source files:
   - `npx wrangler secret put GITHUB_APP_CLIENT_ID`
   - `npx wrangler secret put GITHUB_APP_SLUG`
   - `npx wrangler secret put GITHUB_APP_CLIENT_SECRET`
   - `npx wrangler secret put GITHUB_TOKEN_KEY`, with a new random 32-byte key in base64, for example from `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
4. **Install the app** on the repositories to index (`https://github.com/apps/<slug>/installations/new`), then use **Connect GitHub** in RepoMind.

Until all four values are set, `/api/github/status` reports `configured: false` and the UI does not offer private repositories.

## Implementation notes

- **Code:**
  - `worker/github-app.ts`: state and PKCE, code exchange, sealed tokens, refresh, the token-adding fetch, listing, verification and revocation.
  - `worker/private-repos.ts`: adding a repository, access checks, disconnect and the 7-day purge.
  - `worker/secrets.ts`: AES-GCM.
  - Migration `0005_github_app.sql`.
  - UI: `src/components/github.tsx` and `src/pages/GitHubCallbackPage.tsx`.
- **What counts as revocation.** Only `bad_refresh_token` and `invalid_grant` from a refresh. A wrong client secret (`incorrect_client_credentials`) is treated as an outage, so an operator mistake cannot delete users' connections. A regression test covers this.
- **A missing app configuration** (secrets removed after repositories were added) makes the access check answer "unknown", never "lost": reads answer 503 and nothing starts the 7-day deletion. A regression test covers this.
- **Public repositories never use the server's token for privacy decisions.** Adding a public repository always asks GitHub whether it is public, even when `GITHUB_TOKEN` is set, so that token cannot be used to index a private repository it happens to reach.
- **Concurrent refreshes.** When two requests refresh at once, the loser waits briefly for the winner's stored pair. Revocation is itself a compare-and-swap on the generation counter. A regression test reproduces the race.
- **Cleanup through the step endpoint.** A version that fails because access was lost, or that is cancelled, is purged through the existing cleanup (`/step` and the cron trigger).
- **Summaries without access.** For a repository whose access is lost or revoked, the summary keeps the name and state so the owner can recognise and delete it. The admission report and skip lists (which contain file paths) are withheld.
- **Cancelling.** `POST /api/repos/:id/cancel` cancels any GitHub indexing job, public or private, with its partial data removed.

## Consequences

- Private repositories reuse the whole pipeline, and public repositories and ZIP uploads are untouched.
- **Read latency.** A read can include one GitHub access check every 10 minutes per repository (about 100–300 ms).
- **Revocation is detected lazily** (no webhook): at the next token use, the next access check, or the next refresh. Reads are blocked within 10 minutes of losing access.
- **Rotating `GITHUB_TOKEN_KEY`** makes stored tokens unreadable. Users then reconnect; their indexes stay.
- **Validation.** It is validated locally (unit tests against a GitHub fake), in workerd (routes), and in production for health and route protection. A real end-to-end connection needs the owner's GitHub App and a browser sign-in to GitHub, which only the owner can do.
