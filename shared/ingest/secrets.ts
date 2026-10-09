/**
 * Redacts high-confidence credential formats before content is stored,
 * embedded or shown. Findings report the kind and line only, never the value.
 * Redaction preserves line numbers, so citations stay exact.
 *
 * Deliberately narrow: generic "password = ..." heuristics are excluded
 * because their false positives would corrupt ordinary code and examples.
 */

export type SecretKind =
  | "private_key"
  | "aws_access_key"
  | "github_token"
  | "slack_token"
  | "stripe_live_key"
  | "google_api_key"
  | "anthropic_key"
  | "openai_project_key"
  | "npm_token"
  | "jwt";

export interface SecretFinding {
  kind: SecretKind;
  line: number;
}

export interface RedactionResult {
  text: string;
  findings: SecretFinding[];
}

// Every quantifier is bounded, so matching stays linear on adversarial input.
const SECRET_PATTERN = new RegExp(
  [
    String.raw`(?<private_key>-----BEGIN (?:[A-Z0-9]+ ){0,4}PRIVATE KEY-----[\s\S]{0,12000}?-----END (?:[A-Z0-9]+ ){0,4}PRIVATE KEY-----)`,
    String.raw`(?<aws_access_key>\b(?:AKIA|ASIA)[0-9A-Z]{16}\b)`,
    String.raw`(?<github_token>\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b)`,
    String.raw`(?<slack_token>\bxox[abposr]-[A-Za-z0-9-]{10,250})`,
    String.raw`(?<stripe_live_key>\b[rs]k_live_[A-Za-z0-9]{20,250})`,
    String.raw`(?<google_api_key>\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-]))`,
    String.raw`(?<anthropic_key>\bsk-ant-[A-Za-z0-9_-]{20,250})`,
    String.raw`(?<openai_project_key>\bsk-proj-[A-Za-z0-9_-]{20,250})`,
    String.raw`(?<npm_token>\bnpm_[A-Za-z0-9]{36}\b)`,
    String.raw`(?<jwt>\beyJ[A-Za-z0-9_-]{8,2000}\.eyJ[A-Za-z0-9_-]{8,4000}\.[A-Za-z0-9_-]{8,2000})`,
  ].join("|"),
  "g",
);

export function redactSecrets(text: string): RedactionResult {
  SECRET_PATTERN.lastIndex = 0;
  if (!SECRET_PATTERN.test(text)) return { text, findings: [] };

  const findings: SecretFinding[] = [];
  let line = 1;
  let scannedTo = 0;
  const redacted = text.replace(SECRET_PATTERN, (match: string, ...rest: unknown[]) => {
    const groups = rest[rest.length - 1] as Record<string, string | undefined>;
    const offset = rest[rest.length - 3] as number;
    const kind = Object.keys(groups).find((name) => groups[name] !== undefined) as SecretKind;

    line += countNewlines(text, scannedTo, offset);
    scannedTo = offset;
    findings.push({ kind, line });
    // Keep the newlines a multi-line match (a PEM block) spanned.
    return `[REDACTED:${kind}]` + "\n".repeat(countNewlines(match, 0, match.length));
  });
  return { text: redacted, findings };
}

function countNewlines(text: string, from: number, to: number): number {
  let count = 0;
  for (let i = text.indexOf("\n", from); i !== -1 && i < to; i = text.indexOf("\n", i + 1)) count++;
  return count;
}
