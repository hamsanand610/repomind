# Security and privacy

What RepoMind stores, who can see it, and what not to upload. Every statement here describes the code at the time of writing (2026-10-11). Design records with more detail: [ADR 0001](adr/0001-architecture-baseline.md) §5 (security boundaries), [ADR 0003](adr/0003-zip-uploads.md) (ZIP uploads) and [ADR 0005](adr/0005-invitations-and-accounts.md) (accounts).

## What RepoMind stores

| Data | Where | Form | Kept until |
|---|---|---|---|
| Invitation codes (`rmi_…`) | D1 `invitations` | SHA-256 digest only, with expiry, status and an optional administrator label | Kept (no automatic deletion) |
| Personal sign-in keys (`rmk_…`) | D1 `owners` | SHA-256 digest only | Replaced by a recovery code; otherwise kept |
| Accounts | D1 `owners` | Random ID, creation time, last sign-in with a key, disabled flag. No name or email. | Kept; disabling does not delete (there is no account deletion yet) |
| Original invite codes | Worker secret `INVITE_CODES` | Plain text in the secret; the account ID is a hash of the code | Until removed from the secret |
| Sessions | Browser cookie `rm_session` | HMAC-signed (`SESSION_SECRET`), HttpOnly, Secure, SameSite=Strict, 7 days. Nothing is stored server-side except the account's session epoch. | 7 days, or until the account is disabled or its key replaced |
| Indexed repository text | D1 `chunks`, `chunks_fts`, `files` | Text of indexed files, after redaction (below), with paths and line numbers | Until the repository is deleted or re-indexed (the old version is then removed in the background) |
| Semantic vectors | Vectorize | Numbers only (an ID and the embedding), grouped by indexed version; no text | As above |
| Repository metadata | D1 `repos`, `versions` | Owner, GitHub owner/name or ZIP file name, commit or fingerprint, counts, admission report (file paths) | As above |
| Rate-limit counters | D1 `usage_counters` | Per account, plus a SHA-256 hash of the client address for sign-in attempts (not salted, so treat it as pseudonymous) | Deleted after two days |
| Questions and answers | Not stored | Sent to Workers AI to produce the answer; not written to D1 or logs | — |
| Logs | Cloudflare Workers logs | Metadata only: request ID, method, path, error name; for answers, IDs and counts. Never question text, answer text, file content, codes or keys. | Cloudflare's log retention |

Background cleanup also removes the following automatically:
- uploads with no progress for 24 hours;
- indexing attempts that failed or were cancelled;
- the previous version after a re-index.

## Credentials and accounts

- **Codes and keys** are long random values: 128 bits for invitations and 160 bits for keys. They are compared by digest and never logged.
- **Invitations** work once and expire. Two simultaneous redemptions of one code cannot both succeed.
- **A sign-in key is shown once,** when the account is created or recovered. RepoMind cannot show it again; an administrator can issue a recovery code, which replaces it.
- **Disabling an account** or replacing its key ends every session of that account on the next request.
- **Signing out** clears the browser's cookie only. A copied cookie would stay valid for up to 7 days unless the account is disabled or its key replaced.
- **Sign-in and invitation attempts** are limited to 10 per 15 minutes per client address.
- **No admin endpoint.** Administration happens through Wrangler with access to the Cloudflare account ([operations guide](operations.md)); the web app has no admin page.

## Account isolation

- **Ownership on every request.** Every repository endpoint looks the repository up by its owner. Another account's repository answers "not found" for every operation: open, files, search, symbols, Ask, re-index and delete.
- **Search and Ask** use only the chunks of the requested repository's active version.
- **Evidence:** automated tests, plus an isolated Cloudflare deployment for list, open, search and delete ([evaluation results](eval-results.md#multi-user-onboarding-evaluation-2026-10-11)). Isolation between two real signed-in accounts has not been checked by hand in production.
- **An invitation grants access to RepoMind only,** never to another account's repositories.

## What leaves RepoMind

- **Workers AI** (Cloudflare) receives indexed text to compute embeddings, and the question plus the retrieved passages to write an answer.
- **GitHub:**
  - When you add a public repository, your browser asks the GitHub API for the repository's file list.
  - The RepoMind server then downloads the files from GitHub at the pinned commit.
  - RepoMind never fetches any other URL you type.
- **ZIP uploads:**
  - The archive is read in your browser and is never sent whole.
  - Only the supported text files that admission selects are uploaded, and the server checks each against the archive listing.
- **Nothing is executed.** No uploaded or downloaded code is ever run, and nothing is written back to GitHub.

## What not to upload

RepoMind leaves out files that commonly hold credentials:
- `.env` files (templates such as `.env.example` excepted);
- private keys and certificates (`.pem`, `.key`, `.p12`, `.pfx`, `id_rsa` and similar);
- `.npmrc`, `.netrc`, `.git-credentials` and `credentials` files.

It also redacts these formats from indexed text:
- private key blocks;
- AWS access keys, GitHub tokens and Google API keys;
- Slack, npm, Stripe live, OpenAI project and Anthropic keys;
- JWTs.

**Redaction is deliberately narrow.** A password, connection string or token in any other format, such as `password: hunter2` in a config file, is stored, searchable, shown in answers and sent to Workers AI. Before you upload or index:
- **Remove secrets** you have not already rotated: passwords, connection strings, API tokens.
- **Leave out personal data** (customer records, exports, logs with names or emails) and anything you are not allowed to share with Cloudflare's AI processing.
- **For private projects,** upload a ZIP that contains only what you want to ask about.

## Expectations for administrators

- **Never paste secrets into chat, source files or issues.** Set Worker secrets with `npx wrangler secret put` and keep local secrets in git-ignored files (`.dev.vars`, `*.local`).
- **Send each invitation code privately** to one person. The CLI prints it once; clear your terminal scrollback afterwards if others can see it.
- **Keep labels free of personal data:** use a first name or a role, never an email address.
- **Never set a secret with a `VITE_` prefix;** those values ship to the browser.

## Private GitHub integration

It is implemented but disabled. Production has no GitHub App secrets, so `/api/github/status` reports it as not configured and the app labels it "Not enabled". No GitHub tokens exist in production. See [ADR 0004](adr/0004-private-github-repositories.md) before enabling it.

## Reporting a problem

Error messages that end in "(reference …)" include a request ID that the operator can find in the logs. RepoMind has no published security contact yet; report suspected security issues privately to the person who invited you.
