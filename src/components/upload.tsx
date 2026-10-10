import { useEffect, useRef, useState } from 'react'
import type { RepoSummary } from '../../shared/api.ts'
import { api, errorMessage } from '../lib/api.ts'
import { type PreparedArchive, type UploadProgress, forgetArchive, keepArchive, pendingArchive, uploadArchive, usePrepareArchive } from '../lib/upload.ts'
import { Notice, Progress, Spinner } from './ui.tsx'

/** A keyboard-accessible file button that accepts one .zip file. */
export function ZipPicker({ label, disabled = false, onFile, describedBy }: { label: string; disabled?: boolean; onFile: (file: File) => void; describedBy?: string }) {
  return (
    <label className={disabled ? 'button button--secondary file-button file-button--disabled' : 'button button--secondary file-button'}>
      <input
        type="file"
        accept=".zip,application/zip,application/x-zip-compressed"
        className="visually-hidden"
        disabled={disabled}
        aria-describedby={describedBy}
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) onFile(file)
        }}
      />
      {label}
    </label>
  )
}

/**
 * The upload in progress for a ZIP repository. With the archive chosen in
 * this tab it sends the remaining files; otherwise it asks for the same ZIP
 * again. Progress is the server's own file counter.
 */
export function UploadPanel({ repo, onChange }: { repo: RepoSummary; onChange: (repo: RepoSummary) => void }) {
  const version = repo.latest
  const [archive, setArchive] = useState<PreparedArchive | null>(() => pendingArchive(repo.id))
  const [progress, setProgress] = useState<UploadProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const controller = useRef<AbortController | null>(null)
  // One upload loop at a time, also under React's double-invoked effects.
  const active = useRef(false)
  const { prepare, progress: reading, error: readError } = usePrepareArchive()
  const uploading = version?.status === 'indexing'

  useEffect(() => () => controller.current?.abort(), [])

  useEffect(() => {
    if (!archive || error || !uploading || active.current) return
    active.current = true
    const abort = new AbortController()
    controller.current = abort
    setRunning(true)
    void uploadArchive(repo.id, archive, setProgress, abort.signal)
      .then((updated) => {
        forgetArchive(repo.id)
        setArchive(null)
        onChange(updated)
      })
      .catch((err: unknown) => {
        if (!abort.signal.aborted) setError(errorMessage(err))
      })
      .finally(() => {
        active.current = false
        setRunning(false)
      })
  }, [archive, error, uploading, repo.id, onChange])

  if (!version || !uploading) return null
  const cursor = progress?.cursor ?? version.filesProcessed
  const total = progress?.total ?? version.filesTotal

  async function resume(file: File) {
    const prepared = await prepare(file)
    if (!prepared) return
    keepArchive(repo.id, prepared)
    setError(null)
    setArchive(prepared)
  }

  async function cancel() {
    if (!version) return
    controller.current?.abort()
    setCancelling(true)
    try {
      forgetArchive(repo.id)
      onChange(await api.cancelUpload(repo.id, version.id))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setCancelling(false)
    }
  }

  return (
    <section className="card stack" aria-labelledby="upload-title">
      <h2 id="upload-title" className="card__title">
        Uploading <code>{version.ref}</code>
      </h2>
      <Progress label="Files uploaded and indexed" value={cursor} total={total} />
      {running && <Spinner label="Uploading… keep this page open until the upload finishes. Files are indexed as they arrive." />}
      {!archive && !running && (
        <Notice tone="warning" title="Upload interrupted">
          <p>
            {cursor.toLocaleString()} of {total.toLocaleString()} files arrived before the page was closed or reloaded. Choose the same ZIP file to continue
            where it stopped.
          </p>
        </Notice>
      )}
      {error && <Notice tone="danger">{error}</Notice>}
      {(readError || reading) && (readError ? <Notice tone="danger">{readError}</Notice> : <Spinner label={reading ?? undefined} />)}
      <div className="actions-row">
        {(!archive || error) && !running && <ZipPicker label={archive ? 'Choose the ZIP again' : 'Choose the same ZIP'} onFile={resume} disabled={cancelling} />}
        {archive && error && !running && (
          <button type="button" className="button button--secondary" onClick={() => setError(null)}>
            Retry
          </button>
        )}
        <button type="button" className="button button--danger-outline" onClick={cancel} disabled={cancelling}>
          {cancelling ? 'Cancelling…' : 'Cancel upload'}
        </button>
      </div>
      {version.uploadExpiresAt !== null && (
        <p className="hint">
          An unfinished upload is stopped automatically at {new Date(version.uploadExpiresAt).toLocaleString()}, and its partial data is removed.
        </p>
      )}
    </section>
  )
}
