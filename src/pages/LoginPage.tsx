import { type FormEvent, useState } from 'react'
import { api, errorMessage } from '../lib/api.ts'
import { Notice } from '../components/ui.tsx'

export function LoginPage({ configured, onSignedIn }: { configured: boolean; onSignedIn: () => void }) {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.login(code.trim())
      onSignedIn()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="login">
      <section className="login__intro">
        <h1>Understand a codebase by asking it questions.</h1>
        <p className="lead">
          RepoMind indexes a public GitHub repository and answers with citations to the exact files and lines it used. It never
          modifies, commits to or runs your code, and it tells you when the evidence isn't there.
        </p>
        <ul className="login__points">
          <li>Answers grounded in the repository, pinned to a commit</li>
          <li>Exact-term and identifier search across every indexed file</li>
          <li>Read-only: nothing is executed, nothing is pushed</li>
        </ul>
      </section>
      <section className="card login__card" aria-labelledby="signin-title">
        <h2 id="signin-title">Sign in</h2>
        {!configured ? (
          <Notice tone="warning">Sign-in is not configured on this server yet.</Notice>
        ) : (
          <form onSubmit={submit} className="stack">
            <label className="field__label" htmlFor="invite">
              Invite code
            </label>
            <input
              id="invite"
              className="input"
              type="password"
              autoComplete="current-password"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              required
              minLength={16}
              maxLength={200}
            />
            {error && <Notice tone="danger">{error}</Notice>}
            <button type="submit" className="button button--primary" disabled={busy || code.trim().length < 16}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
            <p className="hint">RepoMind is invite-only while it runs on free-tier limits.</p>
          </form>
        )}
      </section>
    </main>
  )
}
