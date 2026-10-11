import { type FormEvent, useCallback, useEffect, useState } from 'react'
import type { RepoSummary } from '../../shared/api.ts'
import { describeGitHubUrlError, parseGitHubRepoUrl } from '../../shared/github-url.ts'
import { ErrorNotice, Notice, Progress, Spinner, StatusBadge } from '../components/ui.tsx'
import { ApiError, api, errorMessage } from '../lib/api.ts'
import { ZipPicker } from '../components/upload.tsx'
import { discoverRepository } from '../lib/discovery.ts'
import { UPLOAD_HINT, keepArchive, usePrepareArchive } from '../lib/upload.ts'
import { DEFAULT_ADMISSION_LIMITS, admitRepository } from '../../shared/ingest/admission.ts'
import { PrivateRepositories } from '../components/github.tsx'
import { ACCESS_MESSAGE, wasCancelled } from '../lib/format.ts'
import { isPartial, relativeTime, repoState, shortSha } from '../lib/format.ts'
import { linkHandler, navigate } from '../lib/router.ts'

export function ReposPage() {
  const [repos, setRepos] = useState<RepoSummary[] | null>(null)
  const [limit, setLimit] = useState(5)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const result = await api.listRepos()
      setRepos(result.repos)
      setLimit(result.limit)
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const full = repos !== null && repos.length >= limit
  const list = (
    <section aria-labelledby="repos-title" className="stack">
      <h2 id="repos-title" className="section-title">
        Your repositories
      </h2>
      {repos && <Allowance used={repos.length} limit={limit} />}
      {error && <ErrorNotice error={error} onRetry={load} />}
      {!repos && !error && <Spinner label="Loading repositories…" />}
      {repos && repos.length > 0 && (
        <ul className="repo-list">
          {repos.map((repo) => (
            <RepoCard key={repo.id} repo={repo} />
          ))}
        </ul>
      )}
    </section>
  )
  return (
    <main className="page">
      <header className="page__header">
        <h1>Repositories</h1>
        <p className="lead">Add a codebase, wait until it is searchable, then explore its files and architecture, search it, and ask questions with cited answers.</p>
      </header>
      {/* Returning users see their repositories first; a new, empty account sees how to start. */}
      {repos !== null && repos.length === 0 ? <GettingStarted limit={limit} /> : list}
      <h2 className="section-title">Add a repository</h2>
      {full && (
        <Notice tone="info" title="All repository slots are used">
          Your account holds up to {limit} repositories. Delete one you no longer need (open it, then Delete repository) to add another.
        </Notice>
      )}
      <AddRepository disabled={full} />
      <UploadRepository disabled={full} />
      <PrivateRepositories disabled={full} onChanged={load} />
    </main>
  )
}

/** "3 of 5 repositories used", with a bar over the real counts. */
export function Allowance({ used, limit }: { used: number; limit: number }) {
  const label = `${used} of ${limit} repositories used`
  return (
    <div className="allowance">
      <span className="allowance__label">{label}</span>
      <div className="progress__track" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={limit} aria-valuenow={used}>
        <div className="progress__fill" style={{ width: `${Math.min(1, used / Math.max(1, limit)) * 100}%` }} />
      </div>
    </div>
  )
}

/** For a new account: what RepoMind does, the steps, and the limits that apply. */
export function GettingStarted({ limit }: { limit: number }) {
  return (
    <section className="card stack" aria-labelledby="start-title">
      <h2 id="start-title" className="card__title">
        Welcome to RepoMind
      </h2>
      <p>
        Your account is private: only you can see the repositories you add. Here is how to get started.
      </p>
      <ol className="steps">
        <li>
          <strong>Add a project</strong> with a <em>public GitHub link</em> or a <em>ZIP file</em> of your code. A ZIP is read in your browser and
          nothing in it is ever run.
        </li>
        <li>
          <strong>Wait a minute or two while it is indexed.</strong> You can browse files and search as soon as the files are in. Very large projects
          are indexed partially, and RepoMind tells you what was left out.
        </li>
        <li>
          <strong>Explore and ask.</strong> Read the architecture summary, search for a function, or ask a question such as “Where is the login
          handled?”. Answers cite the exact files and lines, or say the evidence isn’t there.
        </li>
      </ol>
      <p className="hint">
        Each account holds up to {limit} repositories and can start 20 indexing jobs and ask 100 questions a day (6 a minute).
      </p>
      <Allowance used={0} limit={limit} />
    </section>
  )
}

export function RepoCard({ repo }: { repo: RepoSummary }) {
  const state = repoState(repo)
  const version = repo.latest?.status === 'indexing' ? repo.latest : (repo.active ?? repo.latest)
  const href = `/repos/${encodeURIComponent(repo.id)}`
  return (
    <li className="repo-card">
      <a href={href} onClick={linkHandler(href)} className="repo-card__link">
        <span className="repo-card__name">
          {repo.source === 'zip' ? (
            <>
              <strong>{repo.name}</strong> <span className="tag">ZIP</span>
            </>
          ) : (
            <>
              {repo.owner}/<strong>{repo.name}</strong> {repo.source === 'github_app' && <span className="tag" title="Read with your GitHub authorization">GitHub access</span>}
            </>
          )}
        </span>
        <StatusBadge state={state} partial={isPartial(repo)} />
      </a>
      {repo.access && repo.access !== 'ok' && <p className="repo-card__error">{ACCESS_MESSAGE[repo.access]}</p>}
      <p className="repo-card__meta">
        {version ? (
          <>
            {version.ref} {repo.source === 'zip' ? '· fingerprint' : '@'} <code>{shortSha(version.commitSha)}</code> · updated {relativeTime(repo.updatedAt)}
          </>
        ) : (
          'No index yet'
        )}
      </p>
      {state === 'indexing' && version && <Progress label="Files indexed" value={version.filesProcessed} total={version.filesTotal} />}
      {state === 'uploading' && version && <Progress label="Files uploaded and indexed" value={version.filesProcessed} total={version.filesTotal} />}
      {state === 'failed' && repo.latest?.errorMessage && <p className="repo-card__error">{repo.latest.errorMessage}</p>}
      {state !== 'failed' && repo.active && repo.latest?.status === 'failed' && (
        <p className={wasCancelled(repo.latest) ? 'repo-card__meta' : 'repo-card__error'}>
          {wasCancelled(repo.latest) ? 'The last ' : 'Last '}
          {repo.source === 'zip' ? 'upload' : 're-index'} {wasCancelled(repo.latest) ? 'was cancelled' : `failed: ${(repo.latest.errorMessage ?? 'unknown error').replace(/\.$/, '')}`}. Still
          serving the previous index.
        </p>
      )}
    </li>
  )
}

function AddRepository({ disabled }: { disabled: boolean }) {
  const [url, setUrl] = useState('')
  const [touched, setTouched] = useState(false)
  const [progress, setProgress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const parsed = parseGitHubRepoUrl(url)
  const invalid = touched && url.trim() !== '' && !parsed.ok ? describeGitHubUrlError(parsed.ok ? 'empty' : parsed.reason) : null

  async function submit(event: FormEvent) {
    event.preventDefault()
    setTouched(true)
    if (!parsed.ok) return
    setError(null)
    try {
      const discovery = await discoverRepository(parsed.value.owner, parsed.value.repo, parsed.value.ref, setProgress)
      // The server's own admission check, run first: a repository that cannot be indexed is refused
      // here instead of becoming a failed entry that uses a repository slot and a daily start.
      const { report } = admitRepository(discovery.files.map(([path, size]) => ({ path, size })), discovery.treeEntries, DEFAULT_ADMISSION_LIMITS)
      if (discovery.truncated) throw new Error("GitHub truncated this repository's file list because it is too large to index.")
      if (report.decision === 'rejected') throw new Error(report.message)
      setProgress(`Found ${discovery.files.length.toLocaleString()} supported files. Starting the index…`)
      const repo = await api.addRepo(parsed.value.canonicalUrl, discovery)
      navigate(`/repos/${encodeURIComponent(repo.id)}`)
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : errorMessage(err))
      setProgress(null)
    }
  }

  const busy = progress !== null && error === null
  return (
    <section className="card" aria-labelledby="add-title">
      <h2 id="add-title" className="card__title">
        Public GitHub repository
      </h2>
      <form className="add-form" onSubmit={submit}>
        <label className="visually-hidden" htmlFor="repo-url">
          Public GitHub repository URL
        </label>
        <input
          id="repo-url"
          className="input"
          placeholder="https://github.com/owner/repository"
          value={url}
          onChange={(event) => {
            setUrl(event.target.value)
            setError(null)
          }}
          onBlur={() => setTouched(true)}
          disabled={busy || disabled}
          aria-invalid={invalid !== null}
          aria-describedby="repo-url-help"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
        />
        <button type="submit" className="button button--primary" disabled={busy || disabled || url.trim() === ''}>
          {busy ? 'Adding…' : 'Index repository'}
        </button>
      </form>
      <p id="repo-url-help" className="hint">
        Public repositories only, e.g. <code>github.com/expressjs/cors</code> or a <code>/tree/branch</code> URL.
      </p>
      <p className="hint">
        Free-plan limits: repositories with more than 2,000 supported files are refused. Up to 1,500 searchable chunks (about 1.5 MB of
        text) are indexed; a larger repository is indexed partially (README, manifests and source first), or refused if it needs more
        than four times that. Files over 400 KB are skipped.
      </p>
      {invalid && <Notice tone="warning">{invalid}</Notice>}
      {busy && <Spinner label={progress ?? undefined} />}
      {error && <Notice tone="danger">{error}</Notice>}
    </section>
  )
}

function UploadRepository({ disabled }: { disabled: boolean }) {
  const { prepare, progress, error, setError } = usePrepareArchive()
  const [creating, setCreating] = useState(false)

  async function choose(file: File) {
    const archive = await prepare(file)
    if (!archive) return
    setCreating(true)
    try {
      const repo = await api.createUpload(archive.manifest)
      keepArchive(repo.id, archive)
      navigate(`/repos/${encodeURIComponent(repo.id)}`)
    } catch (err) {
      setError(errorMessage(err))
      setCreating(false)
    }
  }

  const busy = progress !== null || creating
  return (
    <section className="card" aria-labelledby="upload-zip-title">
      <h2 id="upload-zip-title" className="card__title">
        ZIP upload
      </h2>
      <ZipPicker label={busy ? 'Reading…' : 'Choose a ZIP file'} onFile={choose} disabled={busy || disabled} describedBy="upload-zip-help" />
      <p id="upload-zip-help" className="hint">
        {UPLOAD_HINT}
      </p>
      {busy && <Spinner label={progress ?? 'Starting the upload…'} />}
      {error && <Notice tone="danger">{error}</Notice>}
    </section>
  )
}
