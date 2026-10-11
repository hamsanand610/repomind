import { useEffect, useRef, useState } from 'react'
import { Notice, Spinner } from '../components/ui.tsx'
import { api, errorMessage } from '../lib/api.ts'
import { linkHandler } from '../lib/router.ts'

/**
 * Where GitHub sends the browser after authorization. The one-time code and
 * state are taken out of the address bar at once, then sent to the server,
 * which checks them against this session before exchanging the code.
 */
export function GitHubCallbackPage({ code, state, denied }: { code: string | null; state: string | null; denied: boolean }) {
  const [initial] = useState({ code, state, denied })
  const [completed, setCompleted] = useState<{ ok: true; login: string } | { ok: false; message: string } | null>(null)
  const sent = useRef(false)
  const usable = !initial.denied && initial.code !== null && initial.state !== null
  const result = usable
    ? completed
    : { ok: false as const, message: initial.denied ? 'GitHub authorization was cancelled. Nothing was connected.' : 'This page needs a GitHub authorization. Start from Connect GitHub.' }

  useEffect(() => {
    window.history.replaceState(null, '', '/github/callback')
    if (sent.current || !usable || !initial.code || !initial.state) return
    sent.current = true
    api.githubComplete(initial.code, initial.state).then(
      (done) => setCompleted({ ok: true, login: done.login }),
      (err: unknown) => setCompleted({ ok: false, message: errorMessage(err) }),
    )
  }, [initial, usable])

  return (
    <main className="page">
      <section className="card stack" aria-live="polite">
        <h1 className="card__title">Connect GitHub</h1>
        {!result && <Spinner label="Confirming the authorization with GitHub…" />}
        {result?.ok === true && <Notice tone="success">Connected as @{result.login}. Choose a repository to index.</Notice>}
        {result?.ok === false && <Notice tone="danger">{result.message}</Notice>}
        <a className="button button--secondary" href="/" onClick={linkHandler('/')}>
          Back to repositories
        </a>
      </section>
    </main>
  )
}
