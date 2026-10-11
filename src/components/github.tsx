import { useCallback, useEffect, useMemo, useState } from 'react'
import type { GitHubRepositoriesResponse, GitHubStatusResponse } from '../../shared/api.ts'
import { api, errorMessage } from '../lib/api.ts'
import { navigate } from '../lib/router.ts'
import { ConfirmDialog, Notice, Spinner } from './ui.tsx'

/**
 * Private repositories through the GitHub App (ADR 0004). Hidden until the
 * server is configured. RepoMind asks GitHub only for read-only access to
 * repository contents; the list shows what both the user and the app can read.
 */
export function PrivateRepositories({ disabled, onChanged }: { disabled: boolean; onChanged?: () => void }) {
  const [status, setStatus] = useState<GitHubStatusResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [dialogError, setDialogError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api.githubStatus().then(
      (result) => !cancelled && setStatus(result),
      (err: unknown) => !cancelled && setError(errorMessage(err)),
    )
    return () => {
      cancelled = true
    }
  }, [])

  if (error && !status) {
    return (
      <Notice tone="warning" title="Private GitHub repositories">
        Their status could not be loaded ({error}). Reload the page to try again.
      </Notice>
    )
  }
  if (!status) return null
  if (!status.configured) return <PrivateUnavailable />

  async function connect() {
    setError(null)
    setBusy('Opening GitHub…')
    try {
      const { authorizeUrl } = await api.githubConnect()
      window.location.assign(authorizeUrl)
    } catch (err) {
      setError(errorMessage(err))
      setBusy(null)
    }
  }

  async function disconnect() {
    setBusy('Disconnecting…')
    setDialogError(null)
    try {
      const result = await api.githubDisconnect()
      setConfirming(false)
      setDone(
        `${result.repositoriesDeleted === 1 ? '1 private repository was' : `${result.repositoriesDeleted} private repositories were`} removed; their stored data is deleted in the background. ` +
          (result.revokedAtGitHub
            ? 'GitHub confirmed that RepoMind’s authorization was revoked.'
            : 'GitHub did not confirm the revocation: you can revoke it under GitHub → Settings → Applications → Authorized GitHub Apps.') +
          ' The app stays installed on your repositories until you uninstall it on GitHub.',
      )
      setStatus(await api.githubStatus())
      onChanged?.()
    } catch (err) {
      setDialogError(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="card stack" aria-labelledby="private-title">
      <h2 id="private-title" className="card__title">
        Private GitHub repositories
      </h2>
      {!status.connected && (
        <>
          {status.status === 'revoked' && (
            <Notice tone="warning">Your GitHub authorization was revoked or expired. Private repositories stay hidden until you connect again.</Notice>
          )}
          <p className="hint">
            RepoMind asks GitHub for <strong>read-only</strong> access to the contents of the repositories you install it on. It cannot push, create
            branches, edit issues or change anything, and your token never leaves the server.
          </p>
          <div className="actions-row">
            <button type="button" className="button button--primary" onClick={connect} disabled={busy !== null}>
              Connect GitHub
            </button>
          </div>
        </>
      )}
      {status.connected && (
        <>
          <p className="muted">
            Connected as <strong>@{status.login}</strong>.
          </p>
          <RepositoryPicker disabled={disabled} installUrl={status.installUrl} />
          <div className="actions-row">
            <button type="button" className="button button--danger-outline" onClick={() => setConfirming(true)} disabled={busy !== null}>
              Disconnect GitHub
            </button>
          </div>
        </>
      )}
      {busy && <Spinner label={busy} />}
      {error && <Notice tone="danger">{error}</Notice>}
      {done && <Notice tone="success" title="GitHub disconnected">{done}</Notice>}
      {confirming && (
        <ConfirmDialog
          title="Disconnect GitHub?"
          description={
            <p>
              RepoMind will ask GitHub to revoke its authorization, forget your tokens, and permanently delete the indexes of every repository you added
              through GitHub. Public repositories and ZIP uploads are not affected.
            </p>
          }
          confirmText="disconnect"
          actionLabel="Disconnect and delete"
          busy={busy !== null}
          error={dialogError}
          onConfirm={disconnect}
          onCancel={() => {
            setConfirming(false)
            setDialogError(null)
          }}
        />
      )}
    </section>
  )
}

/** Shown while this server has no GitHub App configured: the option exists, but is not offered here. */
export function PrivateUnavailable() {
  return (
    <section className="card card--unavailable stack" aria-labelledby="private-title">
      <h2 id="private-title" className="card__title">
        Private GitHub repository <span className="tag">Not enabled</span>
      </h2>
      <p className="hint">
        Connecting a private GitHub repository is not enabled on this RepoMind server. To explore a private project, download it as a ZIP (on
        GitHub: Code → Download ZIP) and use ZIP upload above. Nothing in the ZIP is run.
      </p>
    </section>
  )
}

function RepositoryPicker({ disabled, installUrl }: { disabled: boolean; installUrl: string | null }) {
  const [list, setList] = useState<GitHubRepositoriesResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [adding, setAdding] = useState<number | null>(null)
  const [round, setRound] = useState(0)

  useEffect(() => {
    let cancelled = false
    api.githubRepositories().then(
      (result) => !cancelled && setList(result),
      (err: unknown) => !cancelled && setError(errorMessage(err)),
    )
    return () => {
      cancelled = true
    }
  }, [round])

  const load = useCallback(() => {
    setError(null)
    setList(null)
    setRound((value) => value + 1)
  }, [])

  const matching = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    return (list?.repositories ?? []).filter((repo) => repo.fullName.toLowerCase().includes(needle))
  }, [list, filter])
  const shown = matching.slice(0, 50)

  async function add(id: number, fullName: string) {
    setAdding(id)
    setError(null)
    try {
      const repo = await api.githubAddRepository(id, fullName)
      navigate(`/repos/${encodeURIComponent(repo.id)}`)
    } catch (err) {
      setError(errorMessage(err))
      setAdding(null)
    }
  }

  return (
    <div className="stack">
      {!list && !error && <Spinner label="Loading the repositories RepoMind can read…" />}
      {error && (
        <Notice tone="danger">
          {error}{' '}
          <button type="button" className="button button--ghost button--small" onClick={load}>
            Try again
          </button>
        </Notice>
      )}
      {list && list.repositories.length === 0 && (
        <Notice tone="info">No repositories yet. Install RepoMind on the repositories you want to index, then refresh this list.</Notice>
      )}
      {list && list.repositories.length > 0 && (
        <>
          <label className="visually-hidden" htmlFor="private-filter">
            Filter repositories
          </label>
          <input id="private-filter" className="input" placeholder="Filter repositories" value={filter} onChange={(event) => setFilter(event.target.value)} autoComplete="off" spellCheck={false} />
          <ul className="choice-list">
            {shown.map((repo) => (
              <li key={repo.id} className="choice-list__item">
                <span className="choice-list__name">
                  <code>{repo.fullName}</code> {repo.private && <span className="tag">Private</span>}
                </span>
                <button type="button" className="button button--secondary button--small" onClick={() => add(repo.id, repo.fullName)} disabled={disabled || adding !== null}>
                  {adding === repo.id ? 'Adding…' : 'Index'}
                </button>
              </li>
            ))}
          </ul>
          {matching.length === 0 && <p className="muted">No repository matches “{filter.trim()}”.</p>}
          {matching.length > shown.length && <p className="hint">Showing 50 of {matching.length.toLocaleString()} matches. Type more of the name to narrow the list.</p>}
          {list.truncated && <p className="hint">Only the first 300 repositories are listed. Use the filter, or install RepoMind on fewer repositories.</p>}
        </>
      )}
      <p className="hint">
        {installUrl && (
          <a href={installUrl} target="_blank" rel="noopener noreferrer">
            Install RepoMind on more repositories ↗
          </a>
        )}
        {installUrl && ' · '}
        <button type="button" className="button button--ghost button--small" onClick={load}>
          Refresh list
        </button>
      </p>
    </div>
  )
}
