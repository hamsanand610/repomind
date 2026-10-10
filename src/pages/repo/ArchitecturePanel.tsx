import { useEffect, useState } from 'react'
import type { ArchitectureResponse, RepoSummary } from '../../../shared/api.ts'
import { BasisTag, FileLink, ImportTarget, SourceLink } from '../../components/code.tsx'
import { ErrorNotice, Notice, Spinner } from '../../components/ui.tsx'
import { api, errorMessage } from '../../lib/api.ts'

const cache = new Map<string, ArchitectureResponse>()
const LANGUAGE_NAMES: Record<string, string> = { javascript: 'JavaScript', typescript: 'TypeScript', python: 'Python', go: 'Go', html: 'HTML', css: 'CSS', markdown: 'Markdown', json: 'JSON', yaml: 'YAML' }
const languageName = (language: string) => LANGUAGE_NAMES[language] ?? language
const SCOPE_LABEL: Record<string, string> = { runtime: 'runtime', peer: 'peer', optional: 'optional', build: 'build', dev: 'development', indirect: 'indirect' }

/**
 * The repository's structure as evidence: every statement links to the file
 * and lines it comes from, and inferences are labelled as such.
 */
export function ArchitecturePanel({ repo }: { repo: RepoSummary }) {
  const version = repo.active
  const [data, setData] = useState<ArchitectureResponse | null>(version ? (cache.get(version.id) ?? null) : null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!version || cache.has(version.id)) return
    let cancelled = false
    api.architecture(repo.id).then(
      (result) => {
        cache.set(version.id, result)
        if (!cancelled) setData(result)
      },
      (err) => !cancelled && setError(errorMessage(err)),
    )
    return () => {
      cancelled = true
    }
  }, [repo.id, version])

  if (!version) return null
  return (
    <section className="card stack" aria-labelledby="architecture-title">
      <h2 id="architecture-title" className="card__title">
        Architecture
      </h2>
      {error && <ErrorNotice error={error} />}
      {!data && !error && <Spinner label="Reading the repository's structure…" />}
      {data && <ArchitectureBody repoId={repo.id} data={data} />}
    </section>
  )
}

export function ArchitectureBody({ repoId, data }: { repoId: string; data: ArchitectureResponse }) {
  const codeLines = data.languages.reduce((sum, l) => sum + l.lines, 0)
  const runtime = data.dependencies.filter((d) => d.scope !== 'dev' && d.scope !== 'indirect')
  const other = data.dependencies.filter((d) => d.scope === 'dev' || d.scope === 'indirect')
  return (
    <div className="stack">
      <p className="hint">
        Computed from the indexed files at this commit, without AI. Each statement links to its source; “Inferred” marks conclusions drawn from naming conventions.
      </p>
      {data.coverage.partial && (
        <Notice tone="warning">
          Partial index: {data.coverage.filesIndexed.toLocaleString()} of {(data.coverage.candidateFiles ?? data.coverage.filesSelected).toLocaleString()} supported files are analysed.
          Files outside the index are not reflected here.
        </Notice>
      )}

      {data.summary.length > 0 && (
        <ul className="evidence-list" aria-label="Summary">
          {data.summary.map((item) => (
            <li key={item.text}>
              <span>{item.text}</span> <BasisTag basis={item.basis} />
              {item.refs.map((ref) => (
                <span key={`${ref.path}:${ref.startLine}`}>
                  {' '}
                  <SourceLink repoId={repoId} source={ref} />
                </span>
              ))}
            </li>
          ))}
        </ul>
      )}

      {data.purpose.length > 0 && (
        <div className="stack">
          <h3 className="section-title">What the repository says about itself</h3>
          {data.purpose.map((p) => (
            <figure key={`${p.ref.path}:${p.ref.startLine}`} className="quote">
              <blockquote>{p.text}</blockquote>
              <figcaption>
                <SourceLink repoId={repoId} source={p.ref} />
              </figcaption>
            </figure>
          ))}
        </div>
      )}

      {data.languages.length > 0 && (
        <div className="stack">
          <h3 className="section-title">Languages (by indexed lines)</h3>
          <ul className="bars">
            {data.languages.slice(0, 8).map((l) => (
              <li key={l.language}>
                <span className="bars__label">{languageName(l.language)}</span>
                <span className="bars__track" aria-hidden="true">
                  <span className="bars__fill" style={{ width: `${codeLines ? Math.max(2, (l.lines / codeLines) * 100) : 0}%` }} />
                </span>
                <span className="muted">
                  {l.files.toLocaleString()} file{l.files === 1 ? '' : 's'} · {l.lines.toLocaleString()} lines
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="stack">
        <h3 className="section-title">Entry points</h3>
        {data.entryPoints.length === 0 ? (
          <p className="muted">No entry point is declared in a manifest, and no file has a conventional entry-point name.</p>
        ) : (
          <ul className="evidence-list">
            {data.entryPoints.map((entry) => (
              <li key={entry.path}>
                <FileLink repoId={repoId} path={entry.path} /> <span className="muted">— {entry.reason}</span> <BasisTag basis={entry.basis} />
                {entry.ref && (
                  <>
                    {' '}
                    <SourceLink repoId={repoId} source={entry.ref} />
                  </>
                )}
                {entry.imports.length > 0 && (
                  <details className="details">
                    <summary>
                      Imports {entry.imports.length}
                      {entry.imports.length === 1 ? ' module' : ' modules'} directly
                    </summary>
                    <ul className="import-list">
                      {entry.imports.map((imp) => (
                        <li key={`${imp.line}:${imp.specifier}`}>
                          <SourceLink repoId={repoId} source={{ path: entry.path, startLine: imp.line, endLine: imp.endLine }} label={imp.specifier} /> <ImportTarget repoId={repoId} imp={imp} />
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                {entry.dynamicImports > 0 && <p className="hint">{entry.dynamicImports} import{entry.dynamicImports === 1 ? ' is' : 's are'} computed at run time and not followed.</p>}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="stack">
        <h3 className="section-title">Dependencies</h3>
        {data.dependencies.length === 0 ? (
          <p className="muted">No dependencies are declared in an indexed manifest.</p>
        ) : (
          <>
            <p className="hint">A declared dependency shows what the project asks for. “Imported in” counts files whose import statements load it.</p>
            <DependencyTable repoId={repoId} deps={runtime} />
            {other.length > 0 && (
              <details className="details">
                <summary>{other.length} development dependencies</summary>
                <DependencyTable repoId={repoId} deps={other} />
              </details>
            )}
          </>
        )}
        {data.remoteScripts.length > 0 && (
          <>
            <h4 className="section-title">Loaded from CDNs</h4>
            <ul className="evidence-list">
              {data.remoteScripts.map((script) => (
                <li key={script.url}>
                  <code>{script.library ?? script.url}</code> <span className="muted">from</span> <SourceLink repoId={repoId} source={script.ref} />
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      {data.directories.length > 0 && (
        <div className="stack">
          <h3 className="section-title">Directories</h3>
          <ul className="evidence-list">
            {data.directories.map((dir) => (
              <li key={dir.path}>
                <code>{dir.path === '.' ? '(root)' : `${dir.path}/`}</code>{' '}
                <span className="muted">
                  {dir.files.toLocaleString()} file{dir.files === 1 ? '' : 's'}
                  {dir.languages.length > 0 && ` · ${dir.languages.map(languageName).join(', ')}`}
                </span>
                {dir.role && (
                  <>
                    {' '}
                    — {dir.role} {dir.basis && <BasisTag basis={dir.basis} />}
                    {dir.ref && (
                      <>
                        {' '}
                        <SourceLink repoId={repoId} source={dir.ref} />
                      </>
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {data.configFiles.length > 0 && (
        <div className="stack">
          <h3 className="section-title">Configuration files</h3>
          <ul className="chips">
            {data.configFiles.map((file) => (
              <li key={file.path} className="chip chip--static">
                <FileLink repoId={repoId} path={file.path} /> <span className="muted">{file.category}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {data.limitations.length > 0 && (
        <details className="details">
          <summary>Limits of this analysis</summary>
          <ul className="reason-list">
            {data.limitations.map((text) => (
              <li key={text}>{text}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

function DependencyTable({ repoId, deps }: { repoId: string; deps: ArchitectureResponse['dependencies'] }) {
  if (deps.length === 0) return <p className="muted">None.</p>
  return (
    <div className="table-scroll">
      <table className="dep-table">
        <thead>
          <tr>
            <th scope="col">Package</th>
            <th scope="col">Declared in</th>
            <th scope="col">Imported in</th>
          </tr>
        </thead>
        <tbody>
          {deps.map((dep) => (
            <tr key={`${dep.declaredIn.path}:${dep.name}`}>
              <td>
                <code>{dep.name}</code>
                {dep.version && <span className="muted"> {dep.version}</span>}
                <div className="muted">
                  {SCOPE_LABEL[dep.scope]}
                  {dep.label && ` · ${dep.label}`}
                </div>
              </td>
              <td>
                <SourceLink repoId={repoId} source={dep.declaredIn} />
              </td>
              <td>
                {dep.usage === null ? (
                  <span className="muted">not analysed for {dep.ecosystem}</span>
                ) : dep.usage.files === 0 ? (
                  <span className="muted">no import found in the indexed code</span>
                ) : (
                  <>
                    {dep.usage.files} file{dep.usage.files === 1 ? '' : 's'}, e.g. <SourceLink repoId={repoId} source={dep.usage.examples[0]} />
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
