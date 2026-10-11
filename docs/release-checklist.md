# Release checklist

The verification status of every capability, the open risks, and the checks to run before announcing a release. It replaces the "Release smoke test" section that used to be in the README.

**Audit of 2026-10-11 (08:10 UTC)**
- **Code:** commit `935400f` on `master`, the same as `origin/main`; working tree clean.
- **Production:** Worker version `73060418-c32e-4c3a-805f-453d3312c23e`, at 100% since 07:52 UTC. Health is `ok` and all six migrations are applied. Its front-end files are byte-identical to a build of `935400f`.

## Status labels

- **Automated:** covered by automated tests (unit and integration) and, where stated, by scripted runs on the isolated Cloudflare evaluation deployment. Not checked by hand in production.
- **Production (manual):** checked by hand against the live deployment.
- **Partial:** some production evidence (live checks, or data showing the feature was used successfully), but important paths are unchecked.
- **Not verified:** no evidence.

Automation never signs in to production, so nothing that needs a signed-in session has been checked by hand there.

## 1. Verification status

| Capability | Status | Evidence |
|---|---|---|
| Invitation sign-up and personal sign-in keys | **Partial** | 13 unit tests; isolated Cloudflare run 16/16 (CLI-issued invitations, concurrent double redemption, used/unknown/withdrawn codes, key sign-in, disable, recovery); local browser pass. **Production:** one invitation created at 08:00:00 UTC and redeemed at 08:00:46 (database records; not done by this audit). There is no later key sign-in on record and the account has no repositories. |
| Original `INVITE_CODES` accounts | **Partial** | Unit tests, including with `INVITE_CODES` empty. **Production:** the original account and its 4 repositories are intact after migration 0006. Signing in with the code after the new deployment was not exercised. |
| Account isolation and ownership | **Partial** | Unit tests (list, open, files, search, symbols, Ask, re-index, delete → 404); isolated Cloudflare run (list, open, search, delete). **Production (manual):** signed-out requests to repository endpoints return 401. Two real signed-in accounts have not been compared in production. |
| Five repositories per account | **Automated** | Unit tests, including concurrent adds and uploads racing for the last slot; isolated Cloudflare run on real D1 (201, 409, 409; total 5). Not exercised in production; the busiest account holds 4. |
| Public GitHub indexing | **Partial** | Unit, recovery and integration tests; Cloudflare evaluations of 2026-10-10 and 2026-10-11. **Production data:** 3 GitHub repositories ready and fully embedded (1,189 chunks; 1,325 vectors in total, equal to the embedded chunks). Not re-tested by hand in this audit. |
| ZIP uploads and archive validation | **Partial** | 34 tests (`zip`, `upload-flow`) on traversal, bombs, CRC, forged listings and resume; isolated Cloudflare runs. **Production data:** 1 ZIP repository ready and embedded (136 chunks). Rejection paths have not been exercised in production. |
| File browsing and line numbers | **Automated** | Unit render tests and API tests for exact content and line ranges; local browser pass at desktop and 375 px. |
| Keyword and symbol search | **Automated** | Unit tests; `npm run eval:code` (this audit: 49/49 definitions at the exact line, 100% on every measure, held-out samples 88/88 and 43/43). |
| Ask with evidence and citations | **Partial** | Unit tests (fake model): citations limited to retrieved evidence, abstention, retries, active version only, prompt injection. With the real model on Cloudflare (2026-10-10): 14/18 strict and 17/18 correct on review, with every citation's lines matching the source. **Production data:** 18 questions in the last two days; answer quality in production not reviewed. |
| Architecture, symbols, imports, navigation | **Automated** | `npm run eval:code` on 7 pinned repositories (this audit, no failures); unit tests; local browser pass. |
| Re-indexing and deletion | **Automated** | Unit and recovery tests, including deletion racing indexing and embedding; isolated Cloudflare runs that left 0 rows after deleting. Not exercised in production. |
| Authentication, authorization, rate limits, failure handling | **Partial** | **Production (manual), this audit:** signed-out `/api/repos`, `/api/github/status` and `/api/repos/x/files` return 401; the session endpoint reports signed out. **At the 2026-10-11 deployment:** cross-origin POSTs returned 403, and unknown invitations and keys were refused without a cookie. Rate limiting returned 429 on the 11th attempt in the isolated Cloudflare run. Signed-in authorization has not been checked in production. |
| Cloudflare Free-plan constraints | **Partial** | Only Free-plan products are used: Workers, D1, Vectorize, Workers AI and cron. The AI budget stops at 8,500 Neurons. Quotas measured in this audit (see [operations](operations.md#watching-quotas)). The account's plan and billing settings were not inspected (no dashboard access). |
| Private GitHub integration disabled | **Production (manual)** | Production secrets are only `INVITE_CODES` and `SESSION_SECRET`; 0 GitHub connections; the status endpoint requires sign-in. A render test and the local browser pass show the "Not enabled" label. |

**Test run in this audit:**
- 488/488 unit tests;
- 12/12 integration tests on a fresh production build, with type-check;
- lint: 7 warnings, the same as before;
- code-intelligence evaluation: no failures.

## Risks

Nothing was fixed during this audit. Severity reflects impact on an invite-only release.

| ID | Risk | Severity | Evidence | Impact | Recommended action |
|---|---|---|---|---|---|
| R1 | **One account can use up the shared D1 write quota** | **High** | Limits are per account only (`start:<account>`, 20 a day). Indexing plus embedding writes about 8 rows per chunk (measured 2026-10-10), so a 1,500-chunk repository is about 12,000 rows. 20 re-indexes is about 240,000, against 100,000 a day for the whole Cloudflare account, shared with the evaluation database (61,132 rows in the last 24 h). | All writes fail until 00:00 UTC: sign-in, Ask, indexing. Users see a generic error. | Before inviting people you don't know personally, add a global daily indexing budget (a code change, not part of this audit). Until then, invite a small trusted group, check `npx wrangler d1 info repomind-db` daily, run no evaluations on the account during the release, and disable an account that indexes abusively. **Status (2026-10-11):** a daily write budget is implemented and tested locally ([ADR 0006](adr/0006-d1-write-budget.md)), not yet deployed. |
| R2 | **The invited-user journey is not verified end to end in production** | **High** (process) | Production holds one redemption only; no key sign-in, repository, search, Ask, isolation, disable or recovery by an invited account. | A production-only defect (configuration, migration, cookies) would reach the first invitees. | Run [§3](#3-production-smoke-test) before announcing. |
| R3 | The shared AI budget can be used by one account | Medium | 8,500 Neurons a day for everyone; 100 questions a day per account at roughly 46–283 Neurons each (estimate in [free-tier](free-tier.md)). | Others get passages without AI answers, and semantic indexing pauses, until 00:00 UTC. | Monitor the Neuron ledger; consider a per-account share later. |
| R4 | The vector storage cap is shared | Medium | Embedding pauses at 7,812 vectors; one full account (5 × 1,500 chunks) needs 7,500. Now 1,325. | New repositories stay keyword-only ("semantic index paused"). | Monitor `vectorize info`; ask people to delete unused repositories. |
| R5 | Quota exhaustion shows a generic error | Medium | `worker/app.ts` maps unexpected errors, including D1 limit errors, to "Something went wrong on our side…". | People can't tell a temporary daily limit from a fault. | Map D1 limit errors to a clear "daily limit reached, resets at 00:00 UTC" message (code change). |
| R6 | Account recovery depends on one administrator | Medium | Recovery codes are issued only through Wrangler by someone with Cloudflare access. | A person who loses their key waits for the administrator. | Documented in the [user guide](user-guide.md) and [operations](operations.md). Consider a second administrator. |
| R7 | No account deletion or data export; indefinite retention | Medium | No delete-account command or endpoint. Disabled accounts, invitations (digests) and account rows are kept. | People can delete their repositories but not their account record. | Documented in [security and privacy](security-and-privacy.md). Add account deletion before a wider release. |
| R8 | Secret redaction is narrow | Medium | 10 credential formats are redacted; other passwords and connection strings are stored and sent to Workers AI. | A secret in an indexed file could appear in search and answers. | Documented ("What not to upload"). Consider a warning in the upload and add flows. |
| R9 | Answers can be wrong despite valid citations | Medium | Citations are validated against retrieved evidence, not sentence by sentence; 14/18 strict on the real model. | Misleading answers. | Documented; the UI tells people to read cited lines. |
| R10 | Signing out does not revoke the session on the server | Low | The cookie is cleared; the signed token stays valid up to 7 days unless the account is disabled or its key replaced. | Only matters if a cookie was copied. | Documented. |
| R11 | Sign-in limit per network address | Low | 10 attempts per 15 minutes per address, shared by sign-in and invitations. | People behind one office address can block each other briefly. | Documented. |
| R12 | Hashed client address kept for 2 days | Low | SHA-256 without a salt in `usage_counters`, pruned after two days. | Pseudonymous, not anonymous. | Documented. |
| R13 | No monitoring or alerting | Low | Checks are manual (`wrangler tail`, `d1 info`, dashboard). | Problems are noticed late. | Daily check during the first weeks ([operations](operations.md)). |
| R14 | The documented 10 ms CPU limit is not enforced in practice | Low | Steps up to 123 ms measured with no failures; crash guards exist. | If Cloudflare starts enforcing it, steps are retried and then skipped. | Watch `exceededCpu` in `wrangler tail`. |
| R15 | No published security contact | Low | — | Reporters don't know where to go. | Add a contact before a public announcement. |
| R16 | 7 lint warnings | Low | React `set-state-in-effect` and `purity`, unchanged across releases. | None observed. | Clean up later. |

**Release blockers:**
- **R2** (verification) must be closed.
- **R1** needs an explicit decision: limit the release to a small trusted group with daily monitoring, or implement a global budget first.

## 2. Before announcing

- [ ] Review and commit the documentation from this audit, and push it to `main`.
- [ ] Confirm production still runs the reviewed commit: `npx wrangler deployments status`, plus the asset comparison in [operations](operations.md#deploying).
- [ ] Record a D1 bookmark: `npx wrangler d1 time-travel info repomind-db`.
- [ ] Check quotas ([operations](operations.md#watching-quotas)). Run no evaluations on this Cloudflare account during the release window.
- [ ] Decide on R1 and record the decision.
- [ ] Run the production smoke test below; record the results and the date.
- [ ] Disable the smoke-test account afterwards and delete its repositories.
- [ ] Issue invitations one person at a time ([operations](operations.md#invitations)) and send each privately, with a link to the [user guide](user-guide.md).
- [ ] Watch `npx wrangler tail repomind` and `d1 info` daily for the first week.

## 3. Production smoke test

Run by the administrator in a normal browser. Automation never signs in to production. It uses one invitation, a few indexing jobs and a few dozen AI Neurons.

1. **Signed out.**
   - `GET /api/health` returns `{"status":"ok","service":"repomind"}`.
   - `GET /api/repos` returns 401.
   - A cross-origin `POST /api/repos` returns 403.
2. **Sign-up.**
   - Issue an invitation with `npm run admin -- invite --remote --days 1 --label smoke-test`, and redeem it in a private window.
   - The key appears once; Continue stays disabled until "I have saved…" is ticked.
   - The account shows "Welcome to RepoMind" and "0 of 5 repositories used"; private GitHub shows "Not enabled".
3. **Sign-in.**
   - Sign out, then sign in with the key. `npm run admin -- accounts --remote` now shows a last sign-in later than the creation time.
   - Entering the invitation again says it has already been used.
4. **Public GitHub.**
   - In the test account, add `https://github.com/expressjs/cors`. File counts are real, and the badge moves through Indexing → Search ready → Ready.
   - The dashboard says "1 of 5 repositories used".
5. **Explore.**
   - Open a file: line numbers show, and at phone width the code scrolls inside its box.
   - Search for a word and for an identifier: a definition opens at its line.
   - The architecture summary loads, and its statements link to lines.
6. **Ask.**
   - A question the code answers gives a cited answer whose citations open the right lines.
   - A question about something absent says the evidence isn't there.
   - A question telling RepoMind to ignore its instructions is not obeyed.
7. **ZIP.**
   - Upload GitHub's "Download ZIP" of a small project: Uploading, then ready, with the wrapper folder removed from paths.
   - A renamed non-ZIP file is refused with a reason.
8. **Isolation.**
   - In the normal window (your own account), the test account's repositories are not listed.
   - Opening a test-repository URL there says "not found", and the reverse holds too.
9. **Re-index and delete.**
   - Re-index keeps the old index usable.
   - Delete asks for the repository's name, then removes it, and the allowance drops.
10. **Disable and recovery.**
    - `npm run admin -- recover <test-account-id> --remote`, then redeem the code: a new key; the old session returns to the sign-in screen.
    - Then `disable` the account: its session ends, and its key is refused.
11. **Quotas and background work.**
    - `npx wrangler tail repomind --format json` shows `cron` events with outcome `ok`.
    - `d1 info` and the Neuron ledger stay within limits.

Private GitHub is out of scope while it is on hold. The steps for it are in [ADR 0004](adr/0004-private-github-repositories.md) and the README.
