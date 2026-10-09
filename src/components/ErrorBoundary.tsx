import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  failed: boolean
}

/** Replaces a crashed UI with a calm recovery message instead of a blank page. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false }

  static getDerivedStateFromError(): State {
    return { failed: true }
  }

  componentDidCatch(error: unknown) {
    // Name only: messages can contain repository content.
    console.error('RepoMind UI error:', error instanceof Error ? error.name : typeof error)
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <main className="fatal-error" role="alert">
        <h1>Something went wrong</h1>
        <p>RepoMind hit an unexpected problem while showing this page. Reloading usually fixes it.</p>
        <button type="button" className="button button--primary" onClick={() => window.location.reload()}>
          Reload RepoMind
        </button>
      </main>
    )
  }
}
