/**
 * Independent checks of the ingestion invariants. Line splitting is
 * re-implemented here (plain String.split) rather than reusing the chunker's
 * offset logic, so a bug in one is unlikely to hide in the other.
 * Each check returns human-readable violations; an empty array means pass.
 */
import type { ChunkOptions, TextChunk } from "../shared/ingest/chunker.ts";
import type { RedactionResult } from "../shared/ingest/secrets.ts";

/** Lines as GitHub numbers them: split on "\n"; a final newline ends the last line. */
export function githubLines(text: string): string[] {
  if (text.length === 0) return [];
  return (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
}

export function chunkViolations(text: string, chunks: readonly TextChunk[], options: Readonly<ChunkOptions>): string[] {
  const lines = githubLines(text);
  const problems: string[] = [];
  if (lines.length === 0) return chunks.length === 0 ? [] : ["chunks produced for an empty file"];
  if (chunks.length === 0) return ["no chunks for a non-empty file"];
  if (chunks[0].startLine !== 1) problems.push(`first chunk starts at line ${chunks[0].startLine}`);
  const last = chunks[chunks.length - 1];
  if (last.endLine !== lines.length) problems.push(`last chunk ends at ${last.endLine}, file has ${lines.length} lines`);

  chunks.forEach((chunk, i) => {
    const where = `chunk ${i} (lines ${chunk.startLine}-${chunk.endLine})`;
    if (chunk.seq !== i) problems.push(`${where}: seq ${chunk.seq}`);
    if (i > 0 && chunk.startLine !== chunks[i - 1].endLine + 1) problems.push(`${where}: gap or overlap`);
    const expected = lines.slice(chunk.startLine - 1, chunk.endLine).join("\n");
    if (chunk.text !== expected) problems.push(`${where}: text differs from the file's lines`);
    if (chunk.charCount !== chunk.text.length) problems.push(`${where}: charCount mismatch`);
    if (chunk.endLine - chunk.startLine + 1 > options.maxLines) problems.push(`${where}: exceeds maxLines`);
    const singleLine = chunk.startLine === chunk.endLine;
    if (chunk.charCount > options.maxChars && !(singleLine && chunk.oversized)) problems.push(`${where}: exceeds maxChars`);
    if (chunk.oversized !== chunk.charCount > options.maxChars) problems.push(`${where}: oversized flag wrong`);
    if (chunk.embeddable !== /\S/.test(chunk.text)) problems.push(`${where}: embeddable flag wrong`);
  });

  const rebuilt = chunks.map((chunk) => chunk.text).join("\n");
  if (rebuilt !== lines.join("\n")) problems.push("joined chunks do not reconstruct the file");
  return problems;
}

/**
 * Redaction must keep the line count, change only lines that hold a finding
 * (or sit inside a redacted private-key block), and mark every redaction.
 */
export function redactionViolations(original: string, result: RedactionResult): string[] {
  const before = githubLines(original);
  const after = githubLines(result.text);
  const problems: string[] = [];
  if (before.length !== after.length) {
    return [`line count changed from ${before.length} to ${after.length}`];
  }

  const allowed = new Set<number>();
  for (const finding of result.findings) {
    allowed.add(finding.line);
    if (finding.kind === "private_key") {
      for (let line = finding.line; line <= before.length; line++) {
        allowed.add(line);
        if (/-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/.test(before[line - 1])) break;
      }
    }
  }
  before.forEach((line, i) => {
    if (line !== after[i] && !allowed.has(i + 1)) problems.push(`line ${i + 1} changed without a finding`);
  });

  const markers = result.text.match(/\[REDACTED:[a-z_]+\]/g)?.length ?? 0;
  const preexisting = original.match(/\[REDACTED:[a-z_]+\]/g)?.length ?? 0;
  if (markers - preexisting !== result.findings.length) {
    problems.push(`${result.findings.length} findings but ${markers - preexisting} redaction markers`);
  }
  if (result.findings.length === 0 && result.text !== original) problems.push("text changed without findings");
  return problems;
}
