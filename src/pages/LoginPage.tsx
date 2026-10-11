import { type FormEvent, useState } from 'react'
import { isInvitationCode } from '../../shared/accounts.ts'
import { api, errorMessage } from '../lib/api.ts'
import { Notice } from '../components/ui.tsx'

/**
 * Sign-in and sign-up in one field: an invitation code (rmi_…) creates an
 * account and shows its personal sign-in key once; a sign-in key (rmk_…), or
 * an older invite code, signs in.
 */
export function LoginPage({ configured, onSignedIn }: { configured: boolean; onSignedIn: () => void }) {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [issued, setIssued] = useState<{ key: string; recovery: boolean } | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      if (isInvitationCode(code)) {
        const result = await api.redeem(code.trim())
        setCode('')
        setIssued({ key: result.signInKey, recovery: result.purpose === 'recovery' })
      } else {
        await api.login(code.trim())
        onSignedIn()
      }
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
          RepoMind reads a code project, from a public GitHub link or a ZIP file, and helps you find your way around it: browse the files, search for
          functions, see how the parts fit together, and ask questions in plain English. Every answer points to the exact files and lines it came from,
          and says so when the project doesn't contain the answer.
        </p>
        <ul className="login__points">
          <li>Read-only: RepoMind never changes, pushes or runs your code.</li>
          <li>Answers cite their sources, so you can check them.</li>
          <li>Invite-only for now. Everyone gets their own private account.</li>
        </ul>
      </section>
      {issued ? (
        <KeyReveal signInKey={issued.key} recovery={issued.recovery} onContinue={onSignedIn} />
      ) : (
        <section className="card login__card" aria-labelledby="signin-title">
          <h2 id="signin-title">Sign in or join</h2>
          {!configured ? (
            <Notice tone="warning">Sign-in is not configured on this server yet.</Notice>
          ) : (
            <form onSubmit={submit} className="stack">
              <label className="field__label" htmlFor="access-code">
                Invitation code or sign-in key
              </label>
              <input
                id="access-code"
                className="input input--mono"
                type="password"
                autoComplete="current-password"
                spellCheck={false}
                value={code}
                onChange={(event) => {
                  setCode(event.target.value)
                  setError(null)
                }}
                aria-describedby="access-help"
                required
                maxLength={200}
              />
              {error && <Notice tone="danger">{error}</Notice>}
              <button type="submit" className="button button--primary" disabled={busy || code.trim().length < 16}>
                {busy ? 'Checking…' : 'Continue'}
              </button>
              <ul id="access-help" className="login__help">
                <li>
                  <strong>New here?</strong> Paste the invitation code you were sent (it starts with <code>rmi_</code>). RepoMind creates your own
                  account and gives you a personal sign-in key.
                </li>
                <li>
                  <strong>Coming back?</strong> Paste your sign-in key (it starts with <code>rmk_</code>).
                </li>
                <li>
                  <strong>No invitation?</strong> RepoMind is invite-only while it runs on free-tier limits. Ask the person who runs it.
                </li>
              </ul>
            </form>
          )}
        </section>
      )}
    </main>
  )
}

/** Shown once after an invitation is redeemed: the key cannot be retrieved later. */
export function KeyReveal({ signInKey, recovery, onContinue }: { signInKey: string; recovery: boolean; onContinue: () => void }) {
  const [saved, setSaved] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)

  async function copy() {
    try {
      await navigator.clipboard.writeText(signInKey)
      setCopied('Copied to the clipboard.')
    } catch {
      setCopied('Copying was blocked by the browser. Select the key and copy it yourself.')
    }
  }

  function download() {
    const text = `RepoMind sign-in key\n\n${signInKey}\n\nSign in at ${window.location.origin} by pasting this key. Keep it private, like a password.\n`
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
    const link = document.createElement('a')
    link.href = url
    link.download = 'repomind-sign-in-key.txt'
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <section className="card login__card stack" aria-labelledby="key-title">
      <h2 id="key-title">{recovery ? 'Your new sign-in key' : 'Your account is ready'}</h2>
      <p>
        {recovery
          ? 'Your old key no longer works, and your other devices were signed out. Your repositories are unchanged.'
          : 'This is your own RepoMind account. The invitation gave you access to RepoMind, not to anyone else’s repositories, and nobody else can see yours.'}
      </p>
      <Notice tone="warning" title="Save your sign-in key now">
        It is the only way to sign in again. RepoMind keeps only a fingerprint of it, so it cannot show it to you again. Keep it private, like a
        password.
      </Notice>
      <label className="field__label" htmlFor="sign-in-key">
        Your sign-in key
      </label>
      <input id="sign-in-key" className="input input--mono" readOnly value={signInKey} onFocus={(event) => event.currentTarget.select()} />
      <div className="actions-row">
        <button type="button" className="button button--secondary" onClick={copy}>
          Copy key
        </button>
        <button type="button" className="button button--secondary" onClick={download}>
          Download as a text file
        </button>
      </div>
      {copied && (
        <p className="hint" role="status">
          {copied}
        </p>
      )}
      <label className="checkbox">
        <input type="checkbox" checked={saved} onChange={(event) => setSaved(event.target.checked)} />I have saved my sign-in key somewhere safe
      </label>
      <button type="button" className="button button--primary" disabled={!saved} onClick={onContinue}>
        Continue to RepoMind
      </button>
      <p className="hint">Lose it later? Ask the person who invited you for a recovery code; your repositories are kept.</p>
    </section>
  )
}
