import type { Basis, ResolvedImport, SourceRef } from '../../shared/api.ts'
import { filesHref } from '../lib/links.ts'
import { navigate } from '../lib/router.ts'

/** An in-app link to exact lines in the file viewer; every displayed relationship points at one. */
export function SourceLink({ repoId, source, label }: { repoId: string; source: SourceRef; label?: string }) {
  const href = filesHref(repoId, source.path, [source.startLine, source.endLine])
  const lines = source.startLine === source.endLine ? `${source.startLine}` : `${source.startLine}–${source.endLine}`
  return (
    <a
      className="source-link"
      href={href}
      onClick={(event) => {
        event.preventDefault()
        navigate(href)
      }}
    >
      <code>{label ?? source.path}</code>
      <span className="muted">:{lines}</span>
    </a>
  )
}

/** A link to a whole file. */
export function FileLink({ repoId, path }: { repoId: string; path: string }) {
  const href = filesHref(repoId, path)
  return (
    <a
      className="source-link"
      href={href}
      onClick={(event) => {
        event.preventDefault()
        navigate(href)
      }}
    >
      <code>{path}</code>
    </a>
  )
}

/** Facts are quoted or counted from files; inferences come from conventions such as folder names. */
export function BasisTag({ basis }: { basis: Basis }) {
  return basis === 'explicit' ? (
    <span className="tag tag--explicit" title="Quoted or counted from the repository's files">
      From the files
    </span>
  ) : (
    <span className="tag tag--inferred" title="Inferred from a naming convention, not stated in the files">
      Inferred
    </span>
  )
}

export function KindTag({ kind }: { kind: string }) {
  return <span className="tag tag--kind">{kind}</span>
}

function hostOf(url: string): string {
  try {
    return new URL(url, 'https://unknown.invalid').host
  } catch {
    return 'an external URL'
  }
}

/** Where an import leads, with uncertainty stated rather than guessed. */
export function ImportTarget({ repoId, imp }: { repoId: string; imp: ResolvedImport }) {
  const r = imp.resolution
  switch (r.kind) {
    case 'internal':
      return (
        <span>
          → {r.targetType === 'directory' ? <code>{r.target === '.' ? 'repository root package' : `${r.target}/ (package)`}</code> : <FileLink repoId={repoId} path={r.target} />}
          {!r.indexed && <span className="muted"> (not indexed)</span>}
          {r.via && <span className="muted"> via {r.via}</span>}
        </span>
      )
    case 'package':
      return (
        <span>
          package <code>{r.name}</code>{' '}
          {r.declared ? (
            <span className="muted">
              declared in <SourceLink repoId={repoId} source={{ path: r.declared.path, startLine: r.declared.line, endLine: r.declared.line }} />
            </span>
          ) : (
            <span className="muted">not declared in an indexed manifest</span>
          )}
        </span>
      )
    case 'builtin':
      return (
        <span>
          standard library <code>{r.name}</code>
        </span>
      )
    case 'remote':
      return (
        <span>
          loaded from {hostOf(r.url)}
          {r.library && (
            <>
              {' '}
              (<code>{r.library}</code>)
            </>
          )}
        </span>
      )
    case 'unresolved':
      return <span className="muted">not resolved: {r.reason}</span>
  }
}
