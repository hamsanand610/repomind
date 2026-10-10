import { useEffect, useMemo, useState } from 'react'
import type { FileContentResponse, FileEntry, ImportersResponse, RepoSummary } from '../../../shared/api.ts'
import { CodeView } from '../../components/CodeView.tsx'
import { ImportTarget, KindTag, SourceLink } from '../../components/code.tsx'
import { EmptyState, ErrorNotice, Notice, Spinner } from '../../components/ui.tsx'
import { api, errorMessage } from '../../lib/api.ts'
import { SKIP_REASON_LABEL, formatBytes } from '../../lib/format.ts'
import { filesHref, parseLines } from '../../lib/links.ts'
import { navigate, useLocation } from '../../lib/router.ts'

const fileListCache = new Map<string, FileEntry[]>()

interface DirNode {
  name: string
  path: string
  dirs: Map<string, DirNode>
  files: FileEntry[]
}

function buildTree(files: FileEntry[]): DirNode {
  const root: DirNode = { name: '', path: '', dirs: new Map(), files: [] }
  for (const file of files) {
    const parts = file.path.split('/')
    let node = root
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join('/')
      let child = node.dirs.get(parts[i])
      if (!child) {
        child = { name: parts[i], path, dirs: new Map(), files: [] }
        node.dirs.set(parts[i], child)
      }
      node = child
    }
    node.files.push(file)
  }
  return root
}

export function FilesTab({ repo }: { repo: RepoSummary }) {
  const { search } = useLocation()
  const selected = search.get('path')
  const lines = parseLines(search.get('lines'))
  const version = repo.active
  const [files, setFiles] = useState<FileEntry[] | null>(version ? (fileListCache.get(version.id) ?? null) : null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')

  useEffect(() => {
    if (!version || fileListCache.has(version.id)) {
      if (version) setFiles(fileListCache.get(version.id) ?? null)
      return
    }
    let cancelled = false
    api.files(repo.id).then(
      (result) => {
        fileListCache.set(version.id, result.files)
        if (!cancelled) setFiles(result.files)
      },
      (err) => !cancelled && setError(errorMessage(err)),
    )
    return () => {
      cancelled = true
    }
  }, [repo.id, version])

  if (!version) return <EmptyState title="No completed index yet">Files appear here once the first index finishes.</EmptyState>

  return (
    <div className={selected ? 'files files--viewing' : 'files'}>
      <aside className="files__tree card" aria-label="Indexed files">
        <input className="input input--small" placeholder="Filter files…" value={filter} onChange={(event) => setFilter(event.target.value)} aria-label="Filter files" />
        {error && <ErrorNotice error={error} />}
        {!files && !error && <Spinner label="Loading files…" />}
        {files && <FileTree files={files} filter={filter} selected={selected} repoId={repo.id} />}
      </aside>
      <section className="files__viewer">
        {selected ? (
          <FileViewer repo={repo} path={selected} lines={lines} />
        ) : (
          <EmptyState title="Select a file">Choose a file to read it exactly as it was indexed.</EmptyState>
        )}
      </section>
    </div>
  )
}

function FileTree({ files, filter, selected, repoId }: { files: FileEntry[]; filter: string; selected: string | null; repoId: string }) {
  const tree = useMemo(() => buildTree(files), [files])
  const [open, setOpen] = useState<Set<string>>(() => {
    const initial = new Set<string>()
    if (selected) selected.split('/').slice(0, -1).forEach((_, i, parts) => initial.add(parts.slice(0, i + 1).join('/')))
    return initial
  })
  const needle = filter.trim().toLowerCase()
  const indexed = files.filter((file) => file.status === 'indexed').length

  if (needle) {
    const matches = files.filter((file) => file.path.toLowerCase().includes(needle)).slice(0, 300)
    return (
      <ul className="tree">
        {matches.length === 0 && <li className="muted">No matching files.</li>}
        {matches.map((file) => (
          <FileItem key={file.path} file={file} label={file.path} selected={selected} repoId={repoId} />
        ))}
      </ul>
    )
  }

  const toggle = (path: string) =>
    setOpen((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  const render = (node: DirNode, depth: number) => (
    <>
      {[...node.dirs.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((dir) => (
          <li key={dir.path}>
            <button type="button" className="tree__dir" style={{ paddingInlineStart: `${depth * 0.875 + 0.5}rem` }} onClick={() => toggle(dir.path)} aria-expanded={open.has(dir.path)}>
              <span aria-hidden="true">{open.has(dir.path) ? '▾' : '▸'}</span> {dir.name}
            </button>
            {open.has(dir.path) && <ul className="tree">{render(dir, depth + 1)}</ul>}
          </li>
        ))}
      {node.files
        .sort((a, b) => a.path.localeCompare(b.path))
        .map((file) => (
          <FileItem key={file.path} file={file} label={file.path.split('/').pop() ?? file.path} selected={selected} repoId={repoId} depth={depth} />
        ))}
    </>
  )

  return (
    <>
      <p className="hint">
        {indexed.toLocaleString()} indexed file{indexed === 1 ? '' : 's'}
        {files.length > indexed && `, ${(files.length - indexed).toLocaleString()} skipped`}
      </p>
      <ul className="tree">{render(tree, 0)}</ul>
    </>
  )
}

function FileItem({ file, label, selected, repoId, depth = 0 }: { file: FileEntry; label: string; selected: string | null; repoId: string; depth?: number }) {
  const href = filesHref(repoId, file.path)
  return (
    <li>
      <a
        href={href}
        onClick={(event) => {
          event.preventDefault()
          navigate(href)
        }}
        className={`tree__file${file.path === selected ? ' tree__file--active' : ''}${file.status === 'skipped' ? ' tree__file--skipped' : ''}`}
        style={{ paddingInlineStart: `${depth * 0.875 + 1.5}rem` }}
        aria-current={file.path === selected ? 'page' : undefined}
        title={file.status === 'skipped' ? `Not indexed: ${SKIP_REASON_LABEL[file.skipReason ?? ''] ?? file.skipReason}` : file.path}
      >
        {label}
      </a>
    </li>
  )
}

/** Outline, imports and importers of the open file; each entry links to exact lines. */
export function CodeMap({ repoId, path, data }: { repoId: string; path: string; data: FileContentResponse }) {
  const [importers, setImporters] = useState<ImportersResponse | null>(null)
  const [importersError, setImportersError] = useState<string | null>(null)
  const [loadingImporters, setLoadingImporters] = useState(false)
  const language = data.file.language
  const loadImporters = () => {
    if (importers || loadingImporters) return
    setLoadingImporters(true)
    api.importers(repoId, path).then(setImporters, (err) => setImportersError(errorMessage(err))).finally(() => setLoadingImporters(false))
  }
  const outline = data.outline
  const imports = data.imports
  return (
    <div className="code-map">
      <details className="details">
        <summary>Outline{outline ? ` (${outline.length})` : ''}</summary>
        {outline === null ? (
          <p className="muted">Definitions are not detected in {language} files.</p>
        ) : outline.length === 0 ? (
          <p className="muted">No functions, classes or other definitions were found in this file.</p>
        ) : (
          <ul className="outline">
            {outline.slice(0, 400).map((d) => (
              <li key={`${d.line}:${d.name}`} className={d.container ? 'outline__nested' : undefined}>
                <KindTag kind={d.kind} /> <SourceLink repoId={repoId} source={{ path, startLine: d.line, endLine: d.endLine }} label={d.container ? `${d.container}.${d.name}` : d.name} />
              </li>
            ))}
          </ul>
        )}
      </details>
      <details className="details">
        <summary>Imports{imports ? ` (${imports.length})` : ''}</summary>
        {imports === null ? (
          <p className="muted">Imports are not analysed for {language} files.</p>
        ) : imports.length === 0 ? (
          <p className="muted">This file has no import statements.</p>
        ) : (
          <ul className="import-list">
            {imports.map((imp) => (
              <li key={`${imp.line}:${imp.specifier}`}>
                <SourceLink repoId={repoId} source={{ path, startLine: imp.line, endLine: imp.endLine }} label={imp.specifier} /> <ImportTarget repoId={repoId} imp={imp} />
              </li>
            ))}
          </ul>
        )}
        {data.dynamicImports.length > 0 && (
          <p className="hint">
            {data.dynamicImports.length} import{data.dynamicImports.length === 1 ? ' is' : 's are'} computed at run time and cannot be followed (line
            {data.dynamicImports.length === 1 ? '' : 's'} {data.dynamicImports.map((d) => d.line).join(', ')}).
          </p>
        )}
      </details>
      <details className="details" onToggle={(event) => event.currentTarget.open && loadImporters()}>
        <summary>Imported by{importers ? ` (${importers.importers.length}${importers.truncated ? '+' : ''})` : ''}</summary>
        {loadingImporters && <Spinner label="Finding files that import this one…" />}
        {importersError && <ErrorNotice error={importersError} />}
        {importers && !importers.supported && <p className="muted">Importers cannot be found for this file name.</p>}
        {importers && importers.supported && importers.importers.length === 0 && <p className="muted">No indexed file imports this one.</p>}
        {importers && importers.importers.length > 0 && (
          <ul className="import-list">
            {importers.importers.map((r) => (
              <li key={`${r.path}:${r.startLine}`}>
                <SourceLink repoId={repoId} source={r} /> <code className="muted">{r.specifier}</code>
              </li>
            ))}
          </ul>
        )}
        {importers?.truncated && <p className="hint">More files mention this name than were examined; the list may be incomplete.</p>}
      </details>
    </div>
  )
}

function FileViewer({ repo, path, lines }: { repo: RepoSummary; path: string; lines: [number, number] | null }) {
  const [data, setData] = useState<FileContentResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setData(null)
    setError(null)
    api.file(repo.id, path).then(
      (result) => !cancelled && setData(result),
      (err) => !cancelled && setError(errorMessage(err)),
    )
    return () => {
      cancelled = true
    }
  }, [repo.id, path])

  const anchor = lines ? `#L${lines[0]}${lines[1] !== lines[0] ? `-L${lines[1]}` : ''}` : ''
  return (
    <div className="viewer card">
      <div className="viewer__header">
        <button type="button" className="button button--ghost button--small viewer__back" onClick={() => navigate(`/repos/${encodeURIComponent(repo.id)}/files`)}>
          ← All files
        </button>
        <code className="viewer__path">{path}</code>
        {data?.githubUrl && (
          <a className="viewer__github" href={`${data.githubUrl}${anchor}`} target="_blank" rel="noopener noreferrer">
            GitHub ↗
          </a>
        )}
      </div>
      {error && <ErrorNotice error={error} />}
      {!data && !error && <Spinner label="Loading file…" />}
      {data && data.file.status === 'skipped' && (
        <Notice tone="info">Not indexed: {SKIP_REASON_LABEL[data.file.skipReason ?? ''] ?? data.file.skipReason}. Open it on GitHub instead.</Notice>
      )}
      {data && data.file.status === 'indexed' && (
        <>
          <p className="viewer__meta">
            {data.file.language} · {data.file.lineCount.toLocaleString()} lines · {formatBytes(data.file.size)}
            {lines && ` · showing lines ${lines[0]}–${lines[1]}`}
          </p>
          {data.file.secretsRedacted > 0 && (
            <Notice tone="warning">
              {data.file.secretsRedacted} credential-like value{data.file.secretsRedacted === 1 ? ' was' : 's were'} redacted before indexing. Line numbers are unchanged.
            </Notice>
          )}
          <CodeMap key={path} repoId={repo.id} path={path} data={data} />
          <CodeView content={data.content} highlight={lines} />
        </>
      )}
    </div>
  )
}
