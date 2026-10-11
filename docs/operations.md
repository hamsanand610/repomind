# Operating RepoMind

For the person who runs the deployment. Commands run from the `repomind` folder. Design background: [ADR 0005](adr/0005-invitations-and-accounts.md) (accounts) and [docs/free-tier.md](free-tier.md) (limits).

## Who is an administrator

An administrator is anyone who can run Wrangler against the Cloudflare account that hosts RepoMind. RepoMind has no admin page and no admin password.

You need:
- Node.js 22 or newer;
- `npm ci`, run once in this folder;
- `npx wrangler login`, signed in to the right Cloudflare account.

Every `npm run admin` command needs an explicit target:
- `--remote` for the deployed database;
- `--local` for a local development database.

So the CLI never touches production by accident.

## Invitations

Issue one invitation:

```bash
npm run admin -- invite --remote --label "Sam"
```

- **What it does.** It prints the code once, an expiry date (7 days by default; `--days 1` to `30`), and the steps to send with it. Only a SHA-256 digest is stored. Nobody, including you, can display the code again.
- **Sending.** Send each code privately to one person, for example in a direct message. Anyone who has an unused code can create an account with it.
- **Labels.** Use a first name or a role; never an email address or other personal data.
- **Several at once.** `--count N` issues N codes (at most 20).
- **Afterwards.** Clear your terminal scrollback if other people can see your screen.

Check and withdraw:

```bash
npm run admin -- invitations --remote
npm run admin -- revoke <invitation-id> --remote
```

- **Statuses:** `open`, `used`, `expired` or `revoked`.
- **Revoking** works only on unused invitations. To stop an account that a used invitation created, disable that account (below).

## Accounts

```bash
npm run admin -- accounts --remote
```

- **Columns:** account ID, kind (`invited`, or `invite code` for an account from the `INVITE_CODES` secret), label, status, repository count, creation time and last sign-in with a key.
- **Disable:** `npm run admin -- disable <account-id> --remote` signs the account out everywhere and refuses its key. Its repositories are kept and keep counting toward quotas.
- **Enable:** `npm run admin -- enable <account-id> --remote` lets it sign in again.
- **Invite-code accounts** cannot be disabled this way. Remove their code from the secret instead (below).

**Not available:** deleting an account or exporting its data. A person can delete their own repositories in the app. Removing an account's rows would need manual SQL, which these guides do not cover.

### Lost sign-in key

```bash
npm run admin -- recover <account-id> --remote
```

- **The recovery code** is single-use and expires after 2 days by default.
- **Sending it.** Send it privately to the account's owner. They enter it in the normal sign-in field; RepoMind shows them a new key, signs out their other sessions and keeps their repositories.
- **When it is refused.** Recovery codes only work for invited accounts that are not disabled.
- **Confirm identity first.** Anyone who receives a recovery code can take over that account.

### The original `INVITE_CODES` accounts

Each code in the `INVITE_CODES` Worker secret is one shared account. `npx wrangler secret put INVITE_CODES` replaces the **whole list**:
- Removing a code signs that account out and blocks it.
- Its repositories stay in the database.

New people should always get invitations instead of codes in this secret.

## Deploying

Run the checks first:

```bash
npm test
npm run lint
npm run test:integration
```

`npm run test:integration` builds the app and checks routing in the local Workers runtime. The current baseline is 7 pre-existing lint warnings, all in React components.

Then deploy:

1. **Bookmark the database**, so you can restore it if a migration goes wrong: `npx wrangler d1 time-travel info repomind-db`. Note the bookmark.
2. **Apply new migrations first**, while the old code still runs: `npx wrangler d1 migrations list repomind-db --remote`, then `npx wrangler d1 migrations apply repomind-db --remote` if any are listed.
3. **Build:** `npm run build`. Then delete `dist/repomind/.dev.vars` if it exists; the build copies the local file there. Wrangler is not expected to upload it, but the established procedure removes it.
4. **Deploy:** `npx wrangler deploy`. Note the version ID it prints.
5. **Verify.** All of these are signed out and read-only:
   - `curl https://repomind.repomind.workers.dev/api/health` returns `{"status":"ok","service":"repomind"}`.
   - `/api/repos`, `/api/github/status` and `/api/repos/x/files` return 401.
   - A `POST` with `Origin: https://example.com` returns 403.
   - The page's `/assets/*` files match `dist/client/assets/*` byte for byte.
   - `npx wrangler deployments status` shows the new version at 100%.
   - `npx wrangler tail repomind --format json` shows `cron` events with outcome `ok` once a minute.
6. **Push** the deployed commit to GitHub: `git push origin master:main`.

### Rolling back

- **Code:** `npx wrangler rollback <previous-version-id>`. Find previous versions with `npx wrangler deployments list`. Migrations so far only add columns and tables, so older code keeps working with a newer schema.
- **Data:** `npx wrangler d1 time-travel restore repomind-db --bookmark=<bookmark>` restores the whole database to the bookmark. **Everything written since is lost**, including new accounts and repositories, so use it only for a damaging migration or data loss.

## Watching quotas

Everything runs on the Cloudflare Free plan; nothing is billed. When a daily limit is reached, the affected requests fail until 00:00 UTC.

```bash
npx wrangler d1 info repomind-db
npx wrangler vectorize info repomind-chunks
npx wrangler d1 execute repomind-db --remote --command "SELECT bucket, count FROM usage_counters WHERE scope = 'neurons' ORDER BY bucket DESC LIMIT 3"
```

| Resource | Free limit | RepoMind's guard | Measured (2026-10-11) |
|---|---|---|---|
| D1 rows written | 100,000 a day, for the whole Cloudflare account | **None across accounts** (20 indexing starts per account a day) | 24,475 (rolling 24 h; the evaluation database on the same account added 61,132) |
| D1 storage | 500 MB per database | 1,500 chunks per repository, 5 repositories per account | 5.9 MB |
| Workers AI | 10,000 Neurons a day | Stops at 8,500, shared by all accounts | 0 today; 1,686 on 2026-10-10 |
| Vectorize | 5 M stored dimensions (about 9,765 vectors at 512 dimensions) | Embedding pauses at 7,812 vectors | 1,325 vectors |

`rows_read_24h` and `rows_written_24h` are rolling 24-hour totals and lag by a few minutes.

**One account can use up shared quotas:**
- Re-indexing a large repository writes roughly 8 D1 rows per chunk, about 12,000 for a 1,500-chunk repository.
- 20 such starts in a day would exceed the account-wide 100,000-row limit. After that, every write fails until 00:00 UTC, including sign-in and Ask, and users see "Something went wrong on our side".
- If that happens, disable the account responsible (`npm run admin -- accounts --remote` shows repository counts) and wait for the reset.
- See the [release checklist](release-checklist.md#risks).

## Troubleshooting

| Symptom | Likely cause | What to do |
|---|---|---|
| `npm run admin` says "choose exactly one of --remote … or --local" | No target given | Add `--remote` |
| `npm run admin` says Wrangler could not run the query | Not logged in, wrong account, or migration 0006 missing | `npx wrangler login`; `npx wrangler d1 migrations list repomind-db --remote` |
| Nobody can sign in; errors say "Something went wrong on our side" | A daily D1 limit is used up, or a database outage | `npx wrangler d1 info repomind-db`; wait until 00:00 UTC; look for an account indexing heavily |
| "Sign-in is not configured on this server yet" | `SESSION_SECRET` is missing | `npx wrangler secret list`; set it with `npx wrangler secret put SESSION_SECRET` (a long random value). Changing it signs everyone out. |
| Repositories stay in "Indexing" while nobody has the page open | The cron trigger is not running | `npx wrangler tail repomind --format json` should show a `cron` event each minute; `npx wrangler triggers deploy` re-registers it |
| Ask shows passages but no AI answer | Today's AI budget is used up | Wait until 00:00 UTC |
| Badge "Search ready · semantic index paused" on new repositories for days | Vector storage is at its cap (7,812) | `npx wrangler vectorize info repomind-chunks`; ask people to delete repositories they no longer need |
| A person reports an error with "(reference …)" | A server error | Search the Workers logs (or `wrangler tail`) for that request ID. Logs hold metadata only. |
