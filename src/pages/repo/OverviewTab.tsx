import { useState } from 'react'
import type { AdmissionReport, RepoSummary, VersionSummary } from '../../../shared/api.ts'
import { ConfirmDialog, Notice, Progress, Spinner } from '../../components/ui.tsx'
import { ZipPicker } from '../../components/upload.tsx'
import { api, errorMessage } from '../../lib/api.ts'
import { discoverRepository } from '../../lib/discovery.ts'
import { SKIP_REASON_LABEL, filesIndexed, formatBytes, relativeTime, repoState, repoTitle, shortSha } from '../../lib/format.ts'
import { keepArchive, usePrepareArchive } from '../../lib/upload.ts'
import { navigate } from '../../lib/router.ts'
import { ArchitecturePanel } from './ArchitecturePanel.tsx'

export function OverviewTab({ repo, onChange }: { repo: RepoSummary; onChange: (repo: RepoSummary) => void }) {
  const state = repoState(repo)
  const latest = repo.latest
  const active = repo.active
  const indexing = latest?.status === 'indexing'

  return (
    <div className="overview">
      <section className="card stack" aria-labelledby="status-title">
        <h2 id="status-title" className="card__title">
          Index status
        </h2>
        {indexing && latest && repo.source !== 'zip' && <IndexingProgress version={latest} />}
        {indexing && repo.source === 'zip' && <p className="muted">A ZIP upload is in progress; see above.</p>}
        {latest?.status === 'failed' && (
          <Notice tone="danger" title={repo.source === 'zip' ? 'The latest upload did not finish' : 'The latest indexing attempt failed'}>
            <p>{latest.errorMessage ?? 'Indexing could not be completed.'}</p>
            {active && (
              <p>
                Searches and answers keep using the previous index ({repo.source === 'zip' ? 'fingerprint' : 'commit'} <code>{shortSha(active.commitSha)}</code>).
              </p>
            )}
          </Notice>
        )}
        {active ? <ActiveIndex version={active} uploaded={repo.source === 'zip'} /> : !indexing && latest?.status !== 'failed' && <p className="muted">No completed index yet.</p>}
        {state === 'ready' && <Notice tone="success">Ready. Explore the files, search, or ask a question.</Notice>}
      </section>

      {active?.status === 'ready' && <ArchitecturePanel repo={repo} />}
      {(latest?.admission ?? active?.admission) && <AdmissionCard version={(indexing ? latest : (active ?? latest)) as VersionSummary} />}
      <Actions repo={repo} onChange={onChange} />
    </div>
  )
}

function IndexingProgress({ version }: { version: VersionSummary }) {
  const paused = version.nextAttemptAt > Date.now()
  return (
    <div className="stack">
      <Progress label="Files downloaded and indexed" value={version.filesProcessed} total={version.filesTotal} />
      <p className="muted">
        {version.chunksTotal.toLocaleString()} searchable chunks so far · commit <code>{shortSha(version.commitSha)}</code>
      </p>
      {paused ? (
        <Notice tone="warning" title="Paused">
          {version.errorMessage ?? 'Waiting to retry.'} Resumes {relativeTime(version.nextAttemptAt)}.
        </Notice>
      ) : (
        <Spinner label="Indexing… you can leave this page; indexing continues in the background, more slowly." />
      )}
    </div>
  )
}

function ActiveIndex({ version, uploaded }: { version: VersionSummary; uploaded: boolean }) {
  const semanticDone = version.chunksEmbedded >= version.chunksEmbeddable
  const indexed = filesIndexed(version)
  const skips = Object.entries(version.indexSkips ?? {}).sort((a, b) => b[1] - a[1])
  return (
    <div className="stack">
      <dl className="facts">
        <div>
          <dt>{uploaded ? 'Indexed archive' : 'Indexed commit'}</dt>
          <dd>
            {uploaded ? (
              <>
                <code>{version.ref}</code> <span className="muted">(fingerprint {shortSha(version.commitSha)})</span>
              </>
            ) : (
              <>
                <code>{shortSha(version.commitSha)}</code> on {version.ref}
              </>
            )}
          </dd>
        </div>
        <div>
          <dt>Files indexed</dt>
          <dd>
            {indexed.toLocaleString()}
            {indexed < version.filesTotal && <span className="muted"> of {version.filesTotal.toLocaleString()} selected</span>}
          </dd>
        </div>
        <div>
          <dt>Searchable chunks</dt>
          <dd>{version.chunksTotal.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Finished</dt>
          <dd>{version.finishedAt ? relativeTime(version.finishedAt) : '—'}</dd>
        </div>
      </dl>
      {version.coverage === 'partial' && (
        <Notice tone="warning" title="Partial index">
          <p>
            Some supported files are not searchable. The free plan allows {version.admission?.budget.toLocaleString() ?? '1,500'} chunks per repository
            (roughly 1.5 MB of text) and files up to 400 KB. Answers never cite files that are not indexed; the Files tab shows each file's reason.
          </p>
          {skips.length > 0 && (
            <ul className="reason-list">
              {skips.map(([reason, count]) => (
                <li key={reason}>
                  <span>{SKIP_REASON_LABEL[reason] ?? reason}</span>
                  <span className="muted">{count.toLocaleString()}</span>
                </li>
              ))}
            </ul>
          )}
        </Notice>
      )}
      {!semanticDone && <Progress label="Semantic index (for questions)" value={version.chunksEmbedded} total={version.chunksEmbeddable} />}
      {version.embeddingNote && <Notice tone="warning">{version.embeddingNote}</Notice>}
      {semanticDone && version.chunksEmbeddable > 0 && <p className="muted">Keyword and semantic search are both available.</p>}
    </div>
  )
}

function AdmissionCard({ version }: { version: VersionSummary }) {
  const report = version.admission
  if (!report) return null
  const skipped = Object.entries(report.skippedByReason).sort((a, b) => b[1] - a[1])
  return (
    <section className="card stack" aria-labelledby="admission-title">
      <h2 id="admission-title" className="card__title">
        What was indexed
      </h2>
      <Notice tone={report.decision === 'full' ? 'info' : report.decision === 'partial' ? 'warning' : 'danger'}>{report.message}</Notice>
      <dl className="facts">
        <div>
          <dt>Supported files</dt>
          <dd>{report.candidateFiles.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Selected for indexing</dt>
          <dd>{report.admittedFiles.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Estimated chunks</dt>
          <dd>
            {report.estimate.optimistic.toLocaleString()}–{report.estimate.conservative.toLocaleString()} <span className="muted">(limit {report.budget.toLocaleString()})</span>
          </dd>
        </div>
      </dl>
      {skipped.length > 0 && (
        <details className="details">
          <summary>
            {report.excludedCount.toLocaleString()} file{report.excludedCount === 1 ? '' : 's'} not indexed at planning time
          </summary>
          <ul className="reason-list">
            {skipped.map(([reason, count]) => (
              <li key={reason}>
                <span>{SKIP_REASON_LABEL[reason] ?? reason}</span>
                <span className="muted">{count.toLocaleString()}</span>
              </li>
            ))}
          </ul>
          {report.excluded.length > 0 && (
            <ul className="path-list">
              {report.excluded.slice(0, 50).map((item) => (
                <li key={`${item.path}:${item.reason}`}>
                  <code>{item.path}</code> <span className="muted">— {SKIP_REASON_LABEL[item.reason] ?? item.reason}</span>
                </li>
              ))}
            </ul>
          )}
        </details>
      )}
      {report.archive && <ArchiveFacts archive={report.archive} />}
      <p className="hint">Folders such as dependencies and build output, lockfiles, binaries and files that may hold credentials are never indexed.</p>
    </section>
  )
}

function ArchiveFacts({ archive }: { archive: NonNullable<AdmissionReport['archive']> }) {
  const skipped = Object.entries(archive.skipped).sort((a, b) => b[1] - a[1])
  const total = skipped.reduce((sum, [, n]) => sum + n, 0)
  return (
    <div className="stack">
      <p className="muted">
        From <code>{archive.fileName}</code> ({formatBytes(archive.bytes)}, {archive.entries.toLocaleString()} entries).
        {archive.rootFolder && (
          <>
            {' '}Every file was inside the folder <code>{archive.rootFolder}/</code>, so paths are shown relative to it.
          </>
        )}
      </p>
      {total > 0 && (
        <details className="details">
          <summary>
            {total.toLocaleString()} entr{total === 1 ? 'y' : 'ies'} left out while your browser read the archive
          </summary>
          <ul className="reason-list">
            {skipped.map(([reason, count]) => (
              <li key={reason}>
                <span>{SKIP_REASON_LABEL[reason] ?? reason}</span>
                <span className="muted">{count.toLocaleString()}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

function Actions({ repo, onChange }: { repo: RepoSummary; onChange: (repo: RepoSummary) => void }) {
  const [progress, setProgress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const { prepare, progress: reading, error: readError } = usePrepareArchive()
  const indexing = repo.latest?.status === 'indexing'

  async function reindex() {
    setError(null)
    try {
      const discovery = await discoverRepository(repo.owner, repo.name, repo.ref, setProgress)
      setProgress('Starting a new index…')
      onChange(await api.reindex(repo.id, discovery))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setProgress(null)
    }
  }

  async function remove() {
    setDeleting(true)
    setError(null)
    try {
      await api.deleteRepo(repo.id)
      navigate('/', { replace: true })
    } catch (err) {
      setError(errorMessage(err))
      setDeleting(false)
      setConfirming(false)
    }
  }

  async function uploadNewVersion(file: File) {
    const archive = await prepare(file)
    if (!archive) return
    setError(null)
    try {
      const updated = await api.newUploadVersion(repo.id, archive.manifest)
      keepArchive(repo.id, archive)
      onChange(updated)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const uploaded = repo.source === 'zip'
  const name = repoTitle(repo)
  return (
    <section className="card stack" aria-labelledby="actions-title">
      <h2 id="actions-title" className="card__title">
        Manage
      </h2>
      <div className="actions">
        {uploaded ? (
          <div>
            <ZipPicker label="Upload a new version" onFile={uploadNewVersion} disabled={indexing || reading !== null} describedBy="new-version-help" />
            <p id="new-version-help" className="hint">
              Indexes a newer ZIP of this project. The current index stays usable until the new one is ready.
            </p>
          </div>
        ) : (
          <div>
            <button type="button" className="button button--secondary" onClick={reindex} disabled={indexing || progress !== null}>
              Re-index latest commit
            </button>
            <p className="hint">Pins the newest commit and builds a fresh index. The current one stays usable until the new one is ready.</p>
          </div>
        )}
        <div>
          <button type="button" className="button button--danger-outline" onClick={() => setConfirming(true)} disabled={deleting}>
            Delete index
          </button>
          <p className="hint">
            {uploaded
              ? "Removes RepoMind's stored files, search index and vectors for this upload. Your ZIP file is not touched."
              : "Removes RepoMind's stored copy, search index and vectors. Your GitHub repository is not touched."}
          </p>
        </div>
      </div>
      {(progress ?? reading) && <Spinner label={(progress ?? reading) as string} />}
      {(error ?? readError) && <Notice tone="danger">{error ?? readError}</Notice>}
      {confirming && (
        <ConfirmDialog
          title="Delete this index?"
          description={
            <p>
              This permanently removes RepoMind's stored files, chunks and vectors for {name}.{' '}
              {uploaded ? 'It does not change your ZIP file.' : 'It does not change anything on GitHub.'}
            </p>
          }
          confirmText={name}
          actionLabel="Delete index"
          busy={deleting}
          onConfirm={remove}
          onCancel={() => setConfirming(false)}
        />
      )}
    </section>
  )
}
