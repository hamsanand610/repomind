import type { RepoSummary, VersionSummary } from '../../shared/api.ts'

export const shortSha = (sha: string) => sha.slice(0, 7)

export function formatNumber(value: number): string {
  return value.toLocaleString()
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function relativeTime(epochMs: number, now = Date.now()): string {
  const seconds = Math.round((epochMs - now) / 1000)
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  const abs = Math.abs(seconds)
  if (abs < 60) return rtf.format(seconds, 'second')
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), 'minute')
  if (abs < 86400) return rtf.format(Math.round(seconds / 3600), 'hour')
  return rtf.format(Math.round(seconds / 86400), 'day')
}

/**
 * waiting: indexing is paused (rate limit, retry backoff); nothing new is searchable yet.
 * semantic_paused: searchable now; only the semantic index is paused (AI allowance, storage).
 * uploading: a ZIP upload is in progress; its files come from the browser that chose it.
 */
export type RepoState = 'indexing' | 'embedding' | 'ready' | 'failed' | 'waiting' | 'semantic_paused' | 'uploading'

/** One overall state for badges, derived only from real server counters. */
export function repoState(repo: RepoSummary, now = Date.now()): RepoState {
  const latest = repo.latest
  if (latest?.status === 'indexing' && repo.source === 'zip') return 'uploading'
  if (latest?.status === 'indexing') return latest.nextAttemptAt > now ? 'waiting' : 'indexing'
  if (latest?.status === 'failed' && !repo.active) return 'failed'
  const active = repo.active
  if (active && active.chunksEmbedded < active.chunksEmbeddable) return active.nextAttemptAt > now ? 'semantic_paused' : 'embedding'
  return active ? 'ready' : 'failed'
}

export const STATE_LABEL: Record<RepoState, string> = {
  indexing: 'Indexing',
  embedding: 'Building semantic index',
  ready: 'Ready',
  failed: 'Failed',
  waiting: 'Paused',
  semantic_paused: 'Ready · semantic search paused',
  uploading: 'Uploading',
}

/** "owner/name" for GitHub repositories, the name alone for uploads. */
export function repoTitle(repo: RepoSummary): string {
  return repo.source === 'zip' ? repo.name : `${repo.owner}/${repo.name}`
}

/** True when the searchable index leaves supported files out (budget, limits, errors). */
export function isPartial(repo: RepoSummary): boolean {
  return repo.active?.coverage === 'partial'
}

/** Files that are actually searchable in a ready version. */
export function filesIndexed(version: VersionSummary): number {
  return version.filesTotal - Object.values(version.indexSkips ?? {}).reduce((sum, n) => sum + n, 0)
}

export function isPaused(state: RepoState): boolean {
  return state === 'waiting' || state === 'semantic_paused'
}

export function needsWork(repo: RepoSummary): boolean {
  const state = repoState(repo)
  return state === 'indexing' || state === 'embedding'
}

export function hasSearchableIndex(version: VersionSummary | null): boolean {
  return version?.status === 'ready'
}

export const SKIP_REASON_LABEL: Record<string, string> = {
  ignored_directory: 'In an ignored folder (dependencies, build output, caches)',
  unsupported_type: 'Unsupported file type',
  lockfile: 'Lockfile',
  sensitive_file: 'May contain credentials (never indexed)',
  generated_file: 'Minified or generated',
  generated_content: 'Minified or generated content',
  too_large: 'Larger than the 400 KB file limit',
  binary: 'Binary file',
  invalid_utf8: 'Not valid UTF-8 text',
  exceeds_repository_share: 'Would use more than 10% of the repository budget',
  over_repository_budget: 'Outside the repository chunk budget',
  not_found: 'Not found at the indexed commit',
  processing_limit: 'Could not be processed within free-tier limits',
  download_failed: 'GitHub could not deliver it (retried for about 35 minutes)',
  processing_error: 'Could not be processed (retried, then skipped)',
  duplicate_path: 'Duplicate path',
  unsafe_character: 'Unsafe characters in the path',
  dot_dot_segment: 'Unsafe path',
  absolute: 'Unsafe path',
  empty_segment: 'Unsafe path',
  git_metadata: 'Git metadata',
  too_long: 'Path too long',
  too_deep: 'Path too deep',
  segment_too_long: 'Path too long',
  empty: 'Empty path',
  symlink: 'Symbolic link (never followed)',
  special_file: 'Device or special file',
  os_metadata: 'macOS archive metadata (__MACOSX)',
  unsupported_compression: 'Compressed with a method other than deflate',
  suspicious_compression: 'Compresses suspiciously well (possible ZIP bomb)',
  unsupported_name_encoding: 'File name is not valid UTF-8',
}
