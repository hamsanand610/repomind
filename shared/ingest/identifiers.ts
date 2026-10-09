/**
 * Words hidden inside code identifiers, so keyword search can match natural
 * language: `parseGitHubRepoUrl` → "parse git hub repo url",
 * `MAX_FILE_BYTES` → "max file bytes". Plain words are already searchable in
 * the text itself and are not repeated. Output is bounded per chunk.
 */
const IDENTIFIER = /[A-Za-z][A-Za-z0-9_]{2,}/g;
const SPLIT = /_+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/;
const MAX_WORDS = 400;

export function identifierWords(text: string): string {
  const words = new Set<string>();
  for (const token of text.match(IDENTIFIER) ?? []) {
    const parts = token.split(SPLIT).filter((part) => part.length >= 2);
    if (parts.length < 2) continue;
    for (const part of parts) {
      words.add(part.toLowerCase());
      if (words.size >= MAX_WORDS) return [...words].join(" ");
    }
  }
  return [...words].join(" ");
}
