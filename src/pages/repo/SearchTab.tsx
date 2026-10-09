import { type FormEvent, useEffect, useState } from 'react'
import type { RepoSummary, SearchResponse } from '../../../shared/api.ts'
import { EmptyState, ErrorNotice, Spinner } from '../../components/ui.tsx'
import { api, errorMessage } from '../../lib/api.ts'
import { navigate, useLocation } from '../../lib/router.ts'
import { filesHref, splitHighlights } from '../../lib/links.ts'

/** Server snippets with highlighted terms rendered as <mark>. */
function Snippet({ text }: { text: string }) {
  return (
    <pre className="snippet">
      <code>
        {splitHighlights(text).map((part, i) => (part.marked ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>))}
      </code>
    </pre>
  )
}

export function SearchTab({ repo }: { repo: RepoSummary }) {
  const { search } = useLocation()
  const q = search.get('q') ?? ''
  const [input, setInput] = useState(q)
  const [result, setResult] = useState<SearchResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    setInput(q)
    if (!q || !repo.active) return
    let cancelled = false
    setLoading(true)
    setError(null)
    api.search(repo.id, q).then(
      (response) => !cancelled && setResult(response),
      (err) => !cancelled && setError(errorMessage(err)),
    ).finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [q, repo.id, repo.active])

  function submit(event: FormEvent) {
    event.preventDefault()
    const term = input.trim()
    if (term) navigate(`/repos/${encodeURIComponent(repo.id)}/search?q=${encodeURIComponent(term)}`)
  }

  if (!repo.active) return <EmptyState title="No completed index yet">Search becomes available once the first index finishes.</EmptyState>

  return (
    <div className="stack">
      <form className="search-form" onSubmit={submit} role="search">
        <label className="visually-hidden" htmlFor="search-input">
          Search code and documentation
        </label>
        <input id="search-input" className="input" value={input} onChange={(event) => setInput(event.target.value)} placeholder="Exact terms or identifiers, e.g. verifyToken" maxLength={200} autoComplete="off" spellCheck={false} />
        <button type="submit" className="button button--primary" disabled={!input.trim()}>
          Search
        </button>
      </form>
      <p className="hint">Matches whole words and identifier prefixes in the indexed commit. All terms must appear in the same passage.</p>
      {loading && <Spinner label="Searching…" />}
      {error && <ErrorNotice error={error} />}
      {result && !loading && result.query === q && (
        <>
          {result.paths.length > 0 && (
            <section className="stack" aria-labelledby="path-matches">
              <h2 id="path-matches" className="section-title">
                Matching file names
              </h2>
              <ul className="chips">
                {result.paths.map((match) => {
                  const href = filesHref(repo.id, match.path)
                  return (
                    <li key={match.path}>
                      <a className="chip" href={href} onClick={(event) => { event.preventDefault(); navigate(href) }}>
                        {match.path}
                      </a>
                    </li>
                  )
                })}
              </ul>
            </section>
          )}
          <section className="stack" aria-labelledby="content-matches">
            <h2 id="content-matches" className="section-title">
              {result.hits.length === 0 ? 'No matching passages' : `${result.hits.length} matching passage${result.hits.length === 1 ? '' : 's'}`}
            </h2>
            {result.hits.length === 0 && <p className="muted">Try fewer or different terms. Searches match whole words and prefixes, not arbitrary substrings.</p>}
            <ul className="hits">
              {result.hits.map((hit) => {
                const href = filesHref(repo.id, hit.path, [hit.startLine, hit.endLine])
                return (
                  <li key={`${hit.path}:${hit.startLine}`} className="hit card">
                    <a className="hit__path" href={href} onClick={(event) => { event.preventDefault(); navigate(href) }}>
                      <code>{hit.path}</code> <span className="muted">lines {hit.startLine}–{hit.endLine}</span>
                    </a>
                    <Snippet text={hit.snippet} />
                  </li>
                )
              })}
            </ul>
          </section>
        </>
      )}
    </div>
  )
}
