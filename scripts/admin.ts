/**
 * Administrator CLI for invitations and accounts (migration 0006).
 *
 * It talks to D1 through Wrangler, so only someone logged in to the Cloudflare
 * account that runs RepoMind can use it; the Worker has no admin endpoint.
 * Invitation codes are generated here, printed once, and stored only as
 * SHA-256 digests. Nothing secret is passed to Wrangler or written to disk.
 *
 *   npm run admin -- invite --remote [--days 7] [--count 1] [--label "for Sam"]
 *   npm run admin -- recover <account-id> --remote [--days 2]
 *   npm run admin -- invitations --remote
 *   npm run admin -- revoke <invitation-id> --remote
 *   npm run admin -- accounts --remote
 *   npm run admin -- disable <account-id> --remote      (ends its sessions)
 *   npm run admin -- enable <account-id> --remote
 *
 * Target: --remote (the deployed database in the Wrangler config) or --local
 * (a local development database). Optional: --config <wrangler config>,
 * --persist-to <dir> for --local, --url <site> for the message to send.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { newInvitationCode, tokenDigest } from "../shared/accounts.ts";

const PRODUCTION_URL = "https://repomind.repomind.workers.dev";
const DAY_MS = 24 * 60 * 60 * 1000;
const WRANGLER = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const ACCOUNT_ID = /^o_[A-Za-z0-9_-]{8,40}$/;
const INVITATION_ID = /^i_[A-Za-z0-9_-]{8,40}$/;
const LABEL = /^[A-Za-z0-9 _.,'()-]{1,40}$/;

type Row = Record<string, string | number | null>;

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const options = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (["remote", "local", "yes"].includes(name)) options.set(name, true);
    else if (i + 1 < argv.length) options.set(name, argv[++i]);
    else fail(`--${name} needs a value`);
  }
  return { command: positional[0] ?? "help", args: positional.slice(1), options };
}

const { command, args, options } = parseArgs(process.argv.slice(2));
const option = (name: string) => {
  const value = options.get(name);
  return typeof value === "string" ? value : undefined;
};

function target(): string[] {
  const remote = options.has("remote");
  const local = options.has("local");
  if (remote === local) fail("choose exactly one of --remote (the deployed database) or --local");
  const out = [remote ? "--remote" : "--local"];
  const config = option("config");
  if (config) out.push("--config", config);
  const persist = option("persist-to");
  if (persist) {
    if (remote) fail("--persist-to only applies to --local");
    out.push("--persist-to", persist);
  }
  return out;
}

/** Runs SQL against D1 through Wrangler (no shell). Values are generated or validated before they are quoted. */
function d1(sql: string): Row[] {
  let out: string;
  try {
    out = execFileSync(process.execPath, [WRANGLER, "d1", "execute", "DB", "--json", "--command", sql, ...target()], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const { stdout, stderr } = error as { stdout?: string; stderr?: string };
    const detail = `${stderr ?? ""}${stdout ?? ""}`.trim();
    fail(`Wrangler could not run the query. Are you logged in (npx wrangler login) and is migration 0006 applied?\n${detail.slice(0, 600)}`);
  }
  const parsed = JSON.parse(out) as Array<{ results?: Row[] }>;
  return parsed.flatMap((result) => result.results ?? []);
}

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const when = (ms: number | string | null) => (ms === null ? "—" : new Date(Number(ms)).toISOString().slice(0, 16).replace("T", " ") + " UTC");

function newId(prefix: string): string {
  return `${prefix}_${Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString("base64url")}`;
}

function days(fallback: number): number {
  const value = Number(option("days") ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 30) fail("--days must be a whole number from 1 to 30");
  return value;
}

function siteUrl(): string | null {
  return option("url") ?? (options.has("remote") && !option("config") ? PRODUCTION_URL : null);
}

function table(rows: Row[], columns: string[]): void {
  if (rows.length === 0) {
    console.log("(none)");
    return;
  }
  const cells = rows.map((row) => columns.map((column) => String(row[column] ?? "—")));
  const widths = columns.map((column, i) => Math.max(column.length, ...cells.map((line) => line[i].length)));
  console.log(columns.map((column, i) => column.padEnd(widths[i])).join("  "));
  for (const line of cells) console.log(line.map((cell, i) => cell.padEnd(widths[i])).join("  "));
}

async function invite(): Promise<void> {
  const count = Number(option("count") ?? 1);
  if (!Number.isInteger(count) || count < 1 || count > 20) fail("--count must be from 1 to 20");
  const label = option("label");
  if (label !== undefined && !LABEL.test(label)) fail("--label: up to 40 letters, digits, spaces and . , ' ( ) - _ (no email addresses needed)");
  const now = Date.now();
  const expires = now + days(7) * DAY_MS;
  const issued: Array<{ id: string; code: string }> = [];
  const values: string[] = [];
  for (let i = 0; i < count; i++) {
    const code = newInvitationCode();
    const id = newId("i");
    issued.push({ id, code });
    values.push(`(${quote(id)}, ${quote(await tokenDigest(code))}, 'account', NULL, ${label ? quote(label) : "NULL"}, ${now}, ${expires})`);
  }
  d1(`INSERT INTO invitations (id, code_hash, purpose, owner_id, label, created_at, expires_at) VALUES ${values.join(", ")}`);
  const url = siteUrl();
  for (const { id, code } of issued) {
    console.log(`\nInvitation ${id}${label ? ` (${label})` : ""}: single use, expires ${when(expires)}`);
    console.log(`  ${code}`);
  }
  console.log(`\nSend each code privately to one person, with these steps:`);
  console.log(`  1. Open ${url ?? "RepoMind"} and choose "Join with an invitation".`);
  console.log(`  2. Paste the code. It creates your own account; it works once.`);
  console.log(`  3. Save the sign-in key RepoMind then shows. It is the only way to sign in again.`);
  console.log(`An invitation gives access to RepoMind only, not to anyone else's repositories.`);
  console.log(`\nThese codes are shown only now. RepoMind stores only their SHA-256 digests. Withdraw one with: npm run admin -- revoke <id> ${target().join(" ")}`);
}

async function recover(accountId: string | undefined): Promise<void> {
  if (!accountId || !ACCOUNT_ID.test(accountId)) fail("give the account ID from `accounts`, e.g. o_AbC123…");
  const [account] = d1(`SELECT id, key_hash IS NOT NULL AS invited, disabled_at FROM owners WHERE id = ${quote(accountId)}`);
  if (!account) fail("no such account");
  if (!account.invited) fail("this account signs in with a code from the INVITE_CODES secret; recovery codes are for invited accounts");
  if (account.disabled_at) fail("this account is disabled; enable it first");
  const code = newInvitationCode();
  const id = newId("i");
  const now = Date.now();
  const expires = now + days(2) * DAY_MS;
  d1(`INSERT INTO invitations (id, code_hash, purpose, owner_id, label, created_at, expires_at)
      VALUES (${quote(id)}, ${quote(await tokenDigest(code))}, 'recovery', ${quote(accountId)}, NULL, ${now}, ${expires})`);
  console.log(`\nRecovery code ${id} for ${accountId}: single use, expires ${when(expires)}`);
  console.log(`  ${code}`);
  console.log(`\nSend it privately to the account's owner. Entering it under "Join with an invitation" replaces their`);
  console.log(`sign-in key, signs out their other sessions, and keeps their repositories. It is shown only now.`);
}

function invitations(): void {
  const now = Date.now();
  const rows = d1(`SELECT id, purpose, label, owner_id, created_at, expires_at, redeemed_at, revoked_at FROM invitations ORDER BY created_at DESC LIMIT 200`);
  table(
    rows.map((row) => ({
      id: row.id,
      purpose: row.purpose,
      label: row.label,
      status: row.revoked_at ? "revoked" : row.redeemed_at ? "used" : Number(row.expires_at) <= now ? "expired" : "open",
      account: row.owner_id,
      created: when(row.created_at),
      expires: when(row.expires_at),
    })),
    ["id", "purpose", "label", "status", "account", "created", "expires"],
  );
}

function revoke(invitationId: string | undefined): void {
  if (!invitationId || !INVITATION_ID.test(invitationId)) fail("give the invitation ID from `invitations`, e.g. i_AbC123…");
  d1(`UPDATE invitations SET revoked_at = ${Date.now()} WHERE id = ${quote(invitationId)} AND redeemed_at IS NULL AND revoked_at IS NULL`);
  const [row] = d1(`SELECT redeemed_at, revoked_at FROM invitations WHERE id = ${quote(invitationId)}`);
  if (!row) fail("no such invitation");
  if (row.redeemed_at) fail("already used; disable the account it created instead (`accounts`, then `disable`)");
  console.log(`Invitation ${invitationId} is withdrawn; it can no longer be used.`);
}

function accounts(): void {
  const rows = d1(`SELECT o.id, o.created_at, o.last_sign_in_at, o.disabled_at, o.key_hash IS NOT NULL AS invited,
      (SELECT COUNT(*) FROM repos r WHERE r.owner_id = o.id) AS repos,
      (SELECT i.label FROM invitations i WHERE i.owner_id = o.id AND i.purpose = 'account') AS label
    FROM owners o ORDER BY o.created_at`);
  table(
    rows.map((row) => ({
      id: row.id,
      kind: row.invited ? "invited" : "invite code",
      label: row.label,
      status: row.disabled_at ? "disabled" : "active",
      repos: row.repos,
      created: when(row.created_at),
      "last sign-in": when(row.last_sign_in_at),
    })),
    ["id", "kind", "label", "status", "repos", "created", "last sign-in"],
  );
}

function setDisabled(accountId: string | undefined, disabled: boolean): void {
  if (!accountId || !ACCOUNT_ID.test(accountId)) fail("give the account ID from `accounts`");
  d1(
    disabled
      ? `UPDATE owners SET disabled_at = ${Date.now()}, session_epoch = session_epoch + 1 WHERE id = ${quote(accountId)} AND key_hash IS NOT NULL`
      : `UPDATE owners SET disabled_at = NULL WHERE id = ${quote(accountId)} AND key_hash IS NOT NULL`,
  );
  const [row] = d1(`SELECT key_hash IS NOT NULL AS invited, disabled_at FROM owners WHERE id = ${quote(accountId)}`);
  if (!row) fail("no such account");
  if (!row.invited) fail("this account signs in with an INVITE_CODES code; remove the code from that secret to block it");
  console.log(disabled ? `${accountId} is disabled and signed out everywhere. Its repositories are kept.` : `${accountId} can sign in again.`);
}

switch (command) {
  case "invite":
    await invite();
    break;
  case "recover":
    await recover(args[0]);
    break;
  case "invitations":
    invitations();
    break;
  case "revoke":
    revoke(args[0]);
    break;
  case "accounts":
    accounts();
    break;
  case "disable":
    setDisabled(args[0], true);
    break;
  case "enable":
    setDisabled(args[0], false);
    break;
  default:
    console.log(`Usage: npm run admin -- <invite|recover|invitations|revoke|accounts|disable|enable> [id] (--remote | --local) [options]
See the comment at the top of scripts/admin.ts.`);
}
