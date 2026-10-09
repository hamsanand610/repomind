import { type FormEvent, useCallback, useEffect, useState } from 'react'
import type { RepoSummary } from '../../shared/api.ts'
import { describeGitHubUrlError, parseGitHubRepoUrl } from '../../shared/github-url.ts'
import { EmptyState, ErrorNotice, Notice, Progress, Spinner, StatusBadge } from '../components/ui.tsx'
import { ApiError, api, errorMessage } from '../lib/api.ts'
import { discoverRepository } from '../lib/discovery.ts'
import { relativeTime, repoState, shortSha } from '../lib/format.ts'
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

  return (
    <main className="page">
      <header className="page__header">
        <h1>Repositories</h1>
        <p className="lead">Add a public GitHub repository, then explore its files, search it and ask questions about it.</p>
      </header>
      <AddRepository disabled={repos !== null && repos.length >= limit} limit={limit} />
      <section aria-labelledby="repos-title" className="stack">
        <h2 id="repos-title" className="section-title">
          Your repositories {repos && <span className="muted">({repos.length} of {limit})</span>}
        </h2>
        {error && <ErrorNotice error={error} onRetry={load} />}
        {!repos && !error && <Spinner label="Loading repositories…" />}
        {repos && repos.length === 0 && <EmptyState title="No repositories yet">Add one above to start indexing.</EmptyState>}
        {repos && repos.length > 0 && (
          <ul className="repo-list">
            {repos.map((repo) => (
              <RepoCard key={repo.id} repo={repo} />
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}

function RepoCard({ repo }: { repo: RepoSummary }) {
  const state = repoState(repo)
  const version = repo.latest?.status === 'indexing' ? repo.latest : (repo.active ?? repo.latest)
  const href = `/repos/${encodeURIComponent(repo.id)}`
  return (
    <li className="repo-card">
      <a href={href} onClick={linkHandler(href)} className="repo-card__link">
        <span className="repo-card__name">
          {repo.owner}/<strong>{repo.name}</strong>
        </span>
        <StatusBadge state={state} />
      </a>
      <p className="repo-card__meta">
        {version ? (
          <>
            {version.ref} @ <code>{shortSha(version.commitSha)}</code> · updated {relativeTime(repo.updatedAt)}
          </>
        ) : (
          'No index yet'
        )}
      </p>
      {state === 'indexing' && version && <Progress label="Files indexed" value={version.filesProcessed} total={version.filesTotal} />}
      {state === 'failed' && repo.latest?.errorMessage && <p className="repo-card__error">{repo.latest.errorMessage}</p>}
    </li>
  )
}

function AddRepository({ disabled, limit }: { disabled: boolean; limit: number }) {
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
        Add a repository
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
        <button type="submit" className="button button--primary" disabled={busy || disabled || !parsed.ok}>
          {busy ? 'Adding…' : 'Index repository'}
        </button>
      </form>
      <p id="repo-url-help" className="hint">
        Public repositories only, e.g. <code>github.com/expressjs/cors</code> or a <code>/tree/branch</code> URL.
      </p>
      {disabled && <Notice tone="info">You have reached the limit of {limit} repositories. Delete one to add another.</Notice>}
      {invalid && <Notice tone="warning">{invalid}</Notice>}
      {busy && <Spinner label={progress ?? undefined} />}
      {error && <Notice tone="danger">{error}</Notice>}
    </section>
  )
}
