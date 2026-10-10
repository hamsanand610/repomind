import { type FormEvent, useEffect, useState } from 'react'
import type { RepoSummary, SearchResponse, SymbolReference, SymbolsResponse } from '../../../shared/api.ts'
import { KindTag, SourceLink } from '../../components/code.tsx'
import { EmptyState, ErrorNotice, Notice, Spinner } from '../../components/ui.tsx'
import { api, errorMessage } from '../../lib/api.ts'
import { navigate, useLocation } from '../../lib/router.ts'
import { filesHref, splitHighlights } from '../../lib/links.ts'

/** A single identifier, optionally qualified (Command.Execute looks up Execute). */
const IDENTIFIER = /^[A-Za-z_$#][\w$]*(?:\.[A-Za-z_$][\w$]*)?$/

const ROLE_LABEL: Record<SymbolReference['role'], string> = { source: 'Source', test: 'Tests', declaration: 'Type declarations', docs: 'Documentation' }

/** Definitions first, then usages grouped by source, tests, declarations and docs. */
export function SymbolResults({ repo, data }: { repo: RepoSummary; data: SymbolsResponse }) {
  const groups = (['source', 'test', 'declaration', 'docs'] as const).map((role) => ({ role, items: data.references.filter((r) => r.role === role) })).filter((g) => g.items.length > 0)
  return (
    <section className="stack" aria-labelledby="symbol-results">
      <h2 id="symbol-results" className="section-title">
        {data.definitions.length === 0 ? `No definition of ${data.name} found` : `${data.definitions.length} definition${data.definitions.length === 1 ? '' : 's'} of ${data.name}`}
      </h2>
      {data.definitions.length === 0 && (
        <p className="muted">
          No function, class, method, type or constant named <code>{data.name}</code> is defined in the indexed files
          {repo.active?.coverage === 'partial' ? ' (this is a partial index, so it may be defined in a file that was not indexed)' : ''}.
        </p>
      )}
      {data.unsupportedLanguages.length > 0 && (
        <Notice tone="info">Definitions are not detected in {data.unsupportedLanguages.join(', ')} files; those occurrences are listed as usages.</Notice>
      )}
      <ul className="hits">
        {data.definitions.map((d) => (
          <li key={`${d.path}:${d.startLine}`} className="hit card">
            <div className="symbol__header">
              <KindTag kind={d.kind} />
              <strong>
                {d.container ? `${d.container}.` : ''}
                {d.name}
              </strong>
              {d.role !== 'source' && <span className="tag">{ROLE_LABEL[d.role]}</span>}
              <SourceLink repoId={repo.id} source={d} />
            </div>
            <pre className="snippet">
              <code>{d.signature}</code>
            </pre>
            {!d.endKnown && <p className="hint">The end of this definition was not found; the range covers its first line.</p>}
          </li>
        ))}
      </ul>
      {groups.length > 0 && (
        <details className="details" open={data.definitions.length === 0}>
          <summary>
            {data.references.length}
            {data.truncated ? '+' : ''} usage{data.references.length === 1 ? '' : 's'}: {groups.map((g) => `${g.items.length} in ${ROLE_LABEL[g.role].toLowerCase()}`).join(', ')}
          </summary>
          {groups.map((g) => (
            <div key={g.role} className="stack">
              <h3 className="section-title">{ROLE_LABEL[g.role]}</h3>
              <ul className="usage-list">
                {g.items.map((r) => (
                  <li key={`${r.path}:${r.startLine}`}>
                    <SourceLink repoId={repo.id} source={r} />
                    {r.kind === 'import' && <span className="tag">import</span>}
                    <code className="usage-list__text">{r.text}</code>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {data.truncated && <p className="hint">The name appears in more places than were examined; the list is not complete.</p>}
        </details>
      )}
    </section>
  )
}

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

  const [symbols, setSymbols] = useState<SymbolsResponse | null>(null)
  const identifier = IDENTIFIER.test(q)

  useEffect(() => {
    setInput(q)
    if (!q || !repo.active) return
    let cancelled = false
    setLoading(true)
    setError(null)
    setSymbols(null)
    // An identifier also gets its definitions and usages; plain words only get passages.
    const lookups: Array<Promise<unknown>> = [
      api.search(repo.id, q).then((response) => !cancelled && setResult(response)),
      ...(IDENTIFIER.test(q) ? [api.symbols(repo.id, q).then((response) => !cancelled && setSymbols(response))] : []),
    ]
    Promise.all(lookups)
      .catch((err) => !cancelled && setError(errorMessage(err)))
      .finally(() => !cancelled && setLoading(false))
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
      <p className="hint">
        Matches whole words and identifier prefixes in the indexed commit. All terms must appear in the same passage. A single identifier also shows where it is defined and used.
      </p>
      {loading && <Spinner label="Searching…" />}
      {error && <ErrorNotice error={error} />}
      {result && !loading && result.query === q && (
        <>
          {identifier && symbols && <SymbolResults repo={repo} data={symbols} />}
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
