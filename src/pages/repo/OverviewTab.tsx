import { useState } from 'react'
import type { RepoSummary, VersionSummary } from '../../../shared/api.ts'
import { ConfirmDialog, Notice, Progress, Spinner } from '../../components/ui.tsx'
import { api, errorMessage } from '../../lib/api.ts'
import { discoverRepository } from '../../lib/discovery.ts'
import { SKIP_REASON_LABEL, filesIndexed, relativeTime, repoState, shortSha } from '../../lib/format.ts'
import { navigate } from '../../lib/router.ts'

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
        {indexing && latest && <IndexingProgress version={latest} />}
        {latest?.status === 'failed' && (
          <Notice tone="danger" title="The latest indexing attempt failed">
            <p>{latest.errorMessage ?? 'Indexing could not be completed.'}</p>
            {active && <p>Searches and answers keep using the previous index (commit <code>{shortSha(active.commitSha)}</code>).</p>}
          </Notice>
        )}
        {active ? <ActiveIndex version={active} /> : !indexing && latest?.status !== 'failed' && <p className="muted">No completed index yet.</p>}
        {state === 'ready' && <Notice tone="success">Ready. Explore the files, search, or ask a question.</Notice>}
      </section>

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

function ActiveIndex({ version }: { version: VersionSummary }) {
  const semanticDone = version.chunksEmbedded >= version.chunksEmbeddable
  const indexed = filesIndexed(version)
  const skips = Object.entries(version.indexSkips ?? {}).sort((a, b) => b[1] - a[1])
  return (
    <div className="stack">
      <dl className="facts">
        <div>
          <dt>Indexed commit</dt>
          <dd>
            <code>{shortSha(version.commitSha)}</code> on {version.ref}
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
      <p className="hint">Folders such as dependencies and build output, lockfiles, binaries and files that may hold credentials are never indexed.</p>
    </section>
  )
}

function Actions({ repo, onChange }: { repo: RepoSummary; onChange: (repo: RepoSummary) => void }) {
  const [progress, setProgress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
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

  const name = `${repo.owner}/${repo.name}`
  return (
    <section className="card stack" aria-labelledby="actions-title">
      <h2 id="actions-title" className="card__title">
        Manage
      </h2>
      <div className="actions">
        <div>
          <button type="button" className="button button--secondary" onClick={reindex} disabled={indexing || progress !== null}>
            Re-index latest commit
          </button>
          <p className="hint">Pins the newest commit and builds a fresh index. The current one stays usable until the new one is ready.</p>
        </div>
        <div>
          <button type="button" className="button button--danger-outline" onClick={() => setConfirming(true)} disabled={deleting}>
            Delete index
          </button>
          <p className="hint">Removes RepoMind's stored copy, search index and vectors. Your GitHub repository is not touched.</p>
        </div>
      </div>
      {progress && <Spinner label={progress} />}
      {error && <Notice tone="danger">{error}</Notice>}
      {confirming && (
        <ConfirmDialog
          title="Delete this index?"
          description={<p>This permanently removes RepoMind's stored files, chunks and vectors for {name}. It does not change anything on GitHub.</p>}
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
