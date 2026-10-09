import { useCallback, useEffect, useRef, useState } from 'react'
import type { RepoSummary } from '../../shared/api.ts'
import { ErrorNotice, Spinner, StatusBadge } from '../components/ui.tsx'
import { ApiError, api, errorMessage } from '../lib/api.ts'
import { needsWork, repoState, shortSha } from '../lib/format.ts'
import { linkHandler } from '../lib/router.ts'
import { AskTab } from './repo/AskTab.tsx'
import { FilesTab } from './repo/FilesTab.tsx'
import { OverviewTab } from './repo/OverviewTab.tsx'
import { SearchTab } from './repo/SearchTab.tsx'

export type Tab = 'overview' | 'files' | 'search' | 'ask'
const TABS: Array<{ id: Tab; label: string; path: string }> = [
  { id: 'overview', label: 'Overview', path: '' },
  { id: 'files', label: 'Files', path: '/files' },
  { id: 'search', label: 'Search', path: '/search' },
  { id: 'ask', label: 'Ask', path: '/ask' },
]

/**
 * Loads a repository and, while it needs work and this page is open, drives
 * indexing one real server step at a time. The cron trigger continues when
 * the page is closed. Progress shown is only what the server reports.
 */
function useRepository(id: string) {
  const [repo, setRepo] = useState<RepoSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [missing, setMissing] = useState(false)

  const load = useCallback(async () => {
    try {
      setRepo(await api.getRepo(id))
      setError(null)
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setMissing(true)
      else setError(errorMessage(err))
    }
  }, [id])

  useEffect(() => {
    setRepo(null)
    setMissing(false)
    void load()
  }, [load])

  const working = repo !== null && needsWork(repo)
  const waitingUntil = repo && repoState(repo) === 'waiting' ? Math.max(repo.latest?.nextAttemptAt ?? 0, repo.active?.nextAttemptAt ?? 0) : 0
  const stepping = useRef(false)

  useEffect(() => {
    if (!working || stepping.current) return
    let cancelled = false
    stepping.current = true
    void (async () => {
      let failures = 0
      while (!cancelled) {
        try {
          const result = await api.step(id)
          if (cancelled) break
          setRepo(result.repo)
          failures = 0
          if (result.outcome.kind === 'waiting' || result.outcome.kind === 'idle' || !needsWork(result.repo)) break
        } catch (err) {
          if (cancelled) break
          failures++
          if (failures >= 3) {
            setError(`Indexing paused: ${errorMessage(err)}`)
            break
          }
          await new Promise((resolve) => setTimeout(resolve, 2_000 * failures))
        }
        await new Promise((resolve) => setTimeout(resolve, 150))
      }
      stepping.current = false
    })()
    return () => {
      cancelled = true
    }
  }, [id, working])

  // While paused (rate limit or daily AI allowance), re-check occasionally.
  useEffect(() => {
    if (!waitingUntil) return
    const timer = setInterval(() => void load(), 30_000)
    return () => clearInterval(timer)
  }, [waitingUntil, load])

  return { repo, setRepo, error, missing, reload: load }
}

export function RepoPage({ id, tab }: { id: string; tab: Tab }) {
  const { repo, setRepo, error, missing, reload } = useRepository(id)
  const base = `/repos/${encodeURIComponent(id)}`

  if (missing) {
    return (
      <main className="page">
        <ErrorNotice error="This repository does not exist or has been deleted." />
        <a className="button button--secondary" href="/" onClick={linkHandler('/')}>
          Back to repositories
        </a>
      </main>
    )
  }
  if (!repo) {
    return <main className="page">{error ? <ErrorNotice error={error} onRetry={reload} /> : <Spinner label="Loading repository…" />}</main>
  }

  const version = repo.active ?? repo.latest
  return (
    <main className="page page--wide">
      <header className="repo-header">
        <a className="back-link" href="/" onClick={linkHandler('/')}>
          ← Repositories
        </a>
        <div className="repo-header__title">
          <h1>
            {repo.owner}/<strong>{repo.name}</strong>
          </h1>
          <StatusBadge state={repoState(repo)} />
        </div>
        {version && (
          <p className="repo-header__meta">
            {version.ref} @{' '}
            <a href={`${repo.githubUrl}/commit/${version.commitSha}`} target="_blank" rel="noopener noreferrer">
              <code>{shortSha(version.commitSha)}</code>
            </a>{' '}
            · <a href={repo.githubUrl} target="_blank" rel="noopener noreferrer">View on GitHub ↗</a>
          </p>
        )}
        <nav className="tabs" aria-label="Repository sections">
          {TABS.map((item) => {
            const href = `${base}${item.path}`
            return (
              <a key={item.id} href={href} onClick={linkHandler(href)} className={item.id === tab ? 'tab tab--active' : 'tab'} aria-current={item.id === tab ? 'page' : undefined}>
                {item.label}
              </a>
            )
          })}
        </nav>
      </header>
      {error && <ErrorNotice error={error} onRetry={reload} />}
      {tab === 'overview' && <OverviewTab repo={repo} onChange={setRepo} />}
      {tab === 'files' && <FilesTab repo={repo} />}
      {tab === 'search' && <SearchTab repo={repo} />}
      {tab === 'ask' && <AskTab repo={repo} />}
    </main>
  )
}
