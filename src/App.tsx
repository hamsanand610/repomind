import { useEffect, useState } from 'react'
import { ApiError, fetchHealth } from './lib/api.ts'
import './App.css'

type HealthState =
  | { kind: 'checking' }
  | { kind: 'ok' }
  | { kind: 'error'; message: string; requestId: string | null }

/**
 * M0 foundation shell: brand, read-only promise and a real API health check.
 * Onboarding, repository views and chat arrive in later milestones.
 */
function App() {
  const [health, setHealth] = useState<HealthState>({ kind: 'checking' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    fetchHealth(controller.signal).then(
      () => setHealth({ kind: 'ok' }),
      (error: unknown) => {
        if (controller.signal.aborted) return
        setHealth(
          error instanceof ApiError
            ? { kind: 'error', message: error.message, requestId: error.requestId }
            : { kind: 'error', message: 'Something unexpected happened. Try again.', requestId: null },
        )
      },
    )
    return () => controller.abort()
  }, [attempt])

  const retry = () => {
    setHealth({ kind: 'checking' })
    setAttempt((n) => n + 1)
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header__inner">
          <span className="brand">
            <span className="brand__mark" aria-hidden="true" />
            RepoMind
          </span>
          <span className="pill">Read-only</span>
        </div>
      </header>

      <main className="app-main">
        <section className="intro">
          <h1>Understand a codebase by asking it questions.</h1>
          <p className="intro__lead">
            RepoMind indexes a public GitHub repository and answers with citations to the exact files and
            lines it used. It never modifies, commits to or runs your code, and it tells you when the
            evidence isn't there.
          </p>
        </section>

        <section className="card" aria-labelledby="status-heading">
          <h2 id="status-heading" className="card__title">
            Service status
          </h2>
          <div aria-live="polite">
            <HealthStatus state={health} onRetry={retry} />
          </div>
        </section>

        <p className="note">Repository indexing and chat are being built in the next milestones.</p>
      </main>

      <footer className="app-footer">
        <p>RepoMind answers only from indexed evidence and cites every source it uses.</p>
      </footer>
    </div>
  )
}

function HealthStatus({ state, onRetry }: { state: HealthState; onRetry: () => void }) {
  if (state.kind === 'checking') {
    return (
      <p className="status status--checking">
        <span className="status__dot" aria-hidden="true" />
        Checking the API…
      </p>
    )
  }
  if (state.kind === 'ok') {
    return (
      <p className="status status--ok">
        <span className="status__icon" aria-hidden="true">
          ✓
        </span>
        API reachable
      </p>
    )
  }
  return (
    <div className="status status--error" role="alert">
      <p>
        <span className="status__icon" aria-hidden="true">
          !
        </span>
        {state.message}
      </p>
      {state.requestId && (
        <p className="status__meta">
          Request ID: <code>{state.requestId}</code>
        </p>
      )}
      <button type="button" className="button button--secondary" onClick={onRetry}>
        Try again
      </button>
    </div>
  )
}

export default App
