import { useCallback, useEffect, useState } from 'react'
import { SESSION_EXPIRED_EVENT, api, errorMessage } from './lib/api.ts'
import { linkHandler, match, navigate, useLocation } from './lib/router.ts'
import { ErrorNotice } from './components/ui.tsx'
import { LoginPage } from './pages/LoginPage.tsx'
import { RepoPage, type Tab } from './pages/RepoPage.tsx'
import { ReposPage } from './pages/ReposPage.tsx'
import './App.css'

type Session = { state: 'checking' } | { state: 'error'; message: string } | { state: 'ready'; authenticated: boolean; configured: boolean }

function App() {
  const [session, setSession] = useState<Session>({ state: 'checking' })

  const check = useCallback(async () => {
    try {
      const result = await api.session()
      setSession({ state: 'ready', authenticated: result.authenticated, configured: result.configured })
    } catch (err) {
      setSession({ state: 'error', message: errorMessage(err) })
    }
  }, [])

  useEffect(() => {
    void check()
    const expired = () => setSession((current) => (current.state === 'ready' ? { ...current, authenticated: false } : current))
    window.addEventListener(SESSION_EXPIRED_EVENT, expired)
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, expired)
  }, [check])

  async function signOut() {
    try {
      await api.logout()
    } finally {
      setSession((current) => (current.state === 'ready' ? { ...current, authenticated: false } : current))
      navigate('/', { replace: true })
    }
  }

  const authenticated = session.state === 'ready' && session.authenticated
  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header__inner">
          <a className="brand" href="/" onClick={linkHandler('/')}>
            <span className="brand__mark" aria-hidden="true" />
            RepoMind
          </a>
          <div className="app-header__actions">
            <span className="pill">Read-only</span>
            {authenticated && (
              <button type="button" className="button button--ghost button--small" onClick={signOut}>
                Sign out
              </button>
            )}
          </div>
        </div>
      </header>

      {session.state === 'checking' && (
        <main className="preloader" aria-busy="true">
          <span className="brand__mark brand__mark--large" aria-hidden="true" />
          <p>Loading RepoMind…</p>
        </main>
      )}
      {session.state === 'error' && (
        <main className="page">
          <ErrorNotice error={session.message} onRetry={check} />
        </main>
      )}
      {session.state === 'ready' && !session.authenticated && <LoginPage configured={session.configured} onSignedIn={check} />}
      {authenticated && <Routes />}

      <footer className="app-footer">
        <p>RepoMind answers only from indexed evidence, cites every source it uses, and never modifies or runs your code.</p>
      </footer>
    </div>
  )
}

function Routes() {
  const { pathname } = useLocation()
  const tabs: Array<[string, Tab]> = [
    ['/repos/:id', 'overview'],
    ['/repos/:id/files', 'files'],
    ['/repos/:id/search', 'search'],
    ['/repos/:id/ask', 'ask'],
  ]
  for (const [pattern, tab] of tabs) {
    const params = match(pattern, pathname)
    if (params) return <RepoPage key={params.id} id={params.id} tab={tab} />
  }
  if (pathname !== '/') {
    return (
      <main className="page">
        <ErrorNotice error="This page does not exist." />
        <a className="button button--secondary" href="/" onClick={linkHandler('/')}>
          Go to repositories
        </a>
      </main>
    )
  }
  return <ReposPage />
}

export default App
