import { useState } from 'react'
import type { RepoSummary, UploadStatusResponse } from '../../shared/api.ts'
import { DEFAULT_ADMISSION_LIMITS, admitRepository } from '../../shared/ingest/admission.ts'
import { UPLOAD_LIMITS } from '../../shared/zip/limits.ts'
import { type UploadManifest, buildUploadManifest, manifestFingerprint } from '../../shared/zip/manifest.ts'
import { type ZipEntry, ZipError, readZipEntry, readZipListing } from '../../shared/zip/reader.ts'
import { ApiError, api, errorMessage } from './api.ts'
import { formatBytes } from './format.ts'

/**
 * ZIP uploads in the browser (ADR 0003). The archive is checked and listed
 * here; only admitted files are decompressed, one batch at a time, and sent
 * to the server, which checks every file again. Nothing in the archive is
 * run, and nothing is written to disk.
 */

export interface PreparedArchive {
  file: File
  manifest: UploadManifest
  entries: Map<string, ZipEntry>
  fingerprint: string
}

/** Types browsers report for .zip files; anything else is refused. The signature check decides. */
const ZIP_TYPES = new Set(['', 'application/zip', 'application/x-zip-compressed', 'application/x-zip', 'multipart/x-zip', 'application/octet-stream'])

export async function prepareArchive(file: File, onProgress: (message: string) => void = () => {}): Promise<PreparedArchive> {
  if (!/\.zip$/i.test(file.name)) throw new ZipError('not_zip', 'Choose a .zip file.')
  if (!ZIP_TYPES.has(file.type)) throw new ZipError('not_zip', `This file is reported as ${file.type}, not as a ZIP archive.`)
  onProgress('Reading the archive…')
  const listing = await readZipListing(file)
  const { manifest, entries } = buildUploadManifest(listing, file.name)
  // The same admission the server runs, so an archive that cannot be indexed is refused before anything is created.
  const { report } = admitRepository(manifest.files.map(([path, size]) => ({ path, size })), manifest.archive.entries, DEFAULT_ADMISSION_LIMITS)
  if (report.decision === 'rejected') throw new ZipError('too_many_files', report.message)
  onProgress(`Found ${manifest.files.length.toLocaleString()} supported files.`)
  return { file, manifest, entries, fingerprint: await manifestFingerprint(manifest.files) }
}

export const UPLOAD_HINT =
  `ZIP files up to ${formatBytes(UPLOAD_LIMITS.maxArchiveBytes)} with up to ${UPLOAD_LIMITS.maxEntries.toLocaleString()} entries and ` +
  `${UPLOAD_LIMITS.maxCandidateFiles.toLocaleString()} supported files. The archive is checked in your browser; only source and ` +
  'documentation files are sent, and nothing in it is ever run.'

/** Reads and checks a ZIP for a component; exposes real progress and the reason for any rejection. */
export function usePrepareArchive() {
  const [progress, setProgress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  async function prepare(file: File): Promise<PreparedArchive | null> {
    setError(null)
    try {
      return await prepareArchive(file, setProgress)
    } catch (err) {
      setError(errorMessage(err))
      return null
    } finally {
      setProgress(null)
    }
  }
  return { prepare, progress, error, setError }
}

// Archives chosen in this tab, by repository. Lost on reload: the upload then
// resumes when the same ZIP is chosen again.
const pending = new Map<string, PreparedArchive>()
export const pendingArchive = (repoId: string) => pending.get(repoId) ?? null
export const keepArchive = (repoId: string, archive: PreparedArchive) => void pending.set(repoId, archive)
export const forgetArchive = (repoId: string) => void pending.delete(repoId)

export interface UploadProgress {
  cursor: number
  total: number
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new DOMException('Upload stopped.', 'AbortError'))
    }, { once: true })
  })

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

/**
 * Sends the admitted files that the server has not processed yet, in plan
 * order. Safe to call again after an interruption: the server says where to
 * continue, and repeated batches change nothing.
 */
export async function uploadArchive(
  repoId: string,
  archive: PreparedArchive,
  onProgress: (progress: UploadProgress) => void,
  signal: AbortSignal,
): Promise<RepoSummary> {
  let status: UploadStatusResponse = await api.uploadStatus(repoId)
  if (status.fingerprint !== archive.fingerprint) {
    throw new ZipError('corrupt', 'This ZIP is not the one this upload started with. Choose the same file, or cancel the upload and start again.')
  }
  let cursor = status.cursor
  let repo: RepoSummary | null = null
  let failures = 0
  onProgress({ cursor, total: status.files.length })
  while (cursor < status.files.length) {
    if (signal.aborted) throw new DOMException('Upload stopped.', 'AbortError')
    const batch: string[] = []
    let bytes = 0
    for (let i = cursor; i < status.files.length && batch.length < UPLOAD_LIMITS.maxBatchFiles; i++) {
      const [path, size] = status.files[i]
      if (batch.length > 0 && bytes + size > UPLOAD_LIMITS.maxBatchBytes) break
      batch.push(path)
      bytes += size
    }
    const files: Array<{ path: string; data: string }> = []
    for (const path of batch) {
      const entry = archive.entries.get(path)
      if (!entry) throw new ZipError('corrupt', `${path} is missing from this ZIP. Choose the same file the upload started with.`)
      files.push({ path, data: toBase64(await readZipEntry(archive.file, entry)) })
    }
    try {
      const result = await api.uploadFiles(repoId, { versionId: status.versionId, start: cursor, files }, signal)
      cursor = result.cursor
      repo = result.repo
      failures = 0
      onProgress({ cursor, total: status.files.length })
    } catch (error) {
      if (signal.aborted) throw error
      const retryable = error instanceof ApiError && (error.status === 0 || error.status === 429 || error.status === 503)
      if (error instanceof ApiError && error.status === 409 && /out of order/.test(error.message)) {
        status = await api.uploadStatus(repoId)
        cursor = status.cursor
        continue
      }
      if (!retryable || ++failures > 3) throw error
      await sleep(error.status === 429 ? 15_000 : 2_000 * failures, signal)
    }
  }
  return repo ?? api.getRepo(repoId)
}
