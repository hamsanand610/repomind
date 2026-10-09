import { type FormEvent, useEffect, useRef, useState } from 'react'
import type { AskResponse, Citation, RepoSummary } from '../../../shared/api.ts'
import { CodeView } from '../../components/CodeView.tsx'
import { RichText } from '../../components/RichText.tsx'
import { EmptyState, Notice, Spinner } from '../../components/ui.tsx'
import { api, errorMessage } from '../../lib/api.ts'
import { shortSha } from '../../lib/format.ts'
import { navigate } from '../../lib/router.ts'
import { filesHref } from '../../lib/links.ts'

interface Turn {
  id: number
  question: string
  pending: boolean
  response?: AskResponse
  error?: string
}

// Kept for this browser tab only; nothing about the conversation is stored on the server.
const conversations = new Map<string, Turn[]>()
let nextId = 1

const SUGGESTIONS = [
  'What does this project do?',
  'Which languages, frameworks and dependencies does it use?',
  'Where is the main entry point?',
  'How is configuration loaded?',
]

export function AskTab({ repo }: { repo: RepoSummary }) {
  const [turns, setTurns] = useState<Turn[]>(() => conversations.get(repo.id) ?? [])
  const [question, setQuestion] = useState('')
  const endRef = useRef<HTMLDivElement>(null)
  const pending = turns.some((turn) => turn.pending)
  const version = repo.active

  useEffect(() => {
    conversations.set(repo.id, turns)
  }, [repo.id, turns])

  async function ask(text: string) {
    const trimmed = text.trim()
    if (trimmed.length < 3 || pending) return
    const id = nextId++
    setTurns((current) => [...current, { id, question: trimmed, pending: true }])
    setQuestion('')
    requestAnimationFrame(() => endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }))
    try {
      const response = await api.ask(repo.id, trimmed)
      setTurns((current) => current.map((turn) => (turn.id === id ? { ...turn, pending: false, response } : turn)))
    } catch (err) {
      setTurns((current) => current.map((turn) => (turn.id === id ? { ...turn, pending: false, error: errorMessage(err) } : turn)))
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    void ask(question)
  }

  if (!version) return <EmptyState title="No completed index yet">Questions become available once the first index finishes.</EmptyState>

  return (
    <div className="ask">
      {version.chunksEmbedded < version.chunksEmbeddable && (
        <Notice tone="info">The semantic index is still being built ({version.chunksEmbedded.toLocaleString()} of {version.chunksEmbeddable.toLocaleString()}). Answers use keyword retrieval until it finishes.</Notice>
      )}
      {turns.length === 0 && (
        <div className="ask__intro card stack">
          <p>
            Ask about <strong>{repo.owner}/{repo.name}</strong> at commit <code>{shortSha(version.commitSha)}</code>. Every answer cites the exact files and
            lines it used, or says the evidence isn't there.
          </p>
          <div className="chips">
            {SUGGESTIONS.map((suggestion) => (
              <button key={suggestion} type="button" className="chip" onClick={() => void ask(suggestion)}>
                {suggestion}
              </button>
            ))}
          </div>
        </div>
      )}
      <ol className="turns">
        {turns.map((turn) => (
          <li key={turn.id} className="turn">
            <p className="turn__question">{turn.question}</p>
            <div className="turn__answer card">
              {turn.pending && <Spinner label="Searching the repository and writing an answer…" />}
              {turn.error && <Notice tone="danger">{turn.error}</Notice>}
              {turn.response && <Answer repo={repo} response={turn.response} />}
            </div>
          </li>
        ))}
      </ol>
      <div ref={endRef} />
      <form className="ask__form card" onSubmit={submit}>
        <label className="visually-hidden" htmlFor="question">
          Your question
        </label>
        <textarea
          id="question"
          className="input ask__input"
          rows={2}
          maxLength={1000}
          placeholder="Ask about this repository…"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void ask(question)
            }
          }}
        />
        <button type="submit" className="button button--primary" disabled={pending || question.trim().length < 3}>
          Ask
        </button>
      </form>
      <p className="hint">Enter to send, Shift+Enter for a new line. RepoMind reads code; it cannot change or run it.</p>
    </div>
  )
}

function Answer({ repo, response }: { repo: RepoSummary; response: AskResponse }) {
  const [focused, setFocused] = useState<number | null>(null)
  const listRef = useRef<HTMLOListElement>(null)
  const cite = (number: number) => {
    setFocused(number)
    listRef.current?.querySelector(`[data-citation="${number}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }
  const retrieval = response.retrieval.semantic ? 'keyword + semantic retrieval' : 'keyword retrieval'

  return (
    <div className="stack">
      {response.status === 'answered' && response.answer && <RichText text={response.answer} onCite={cite} />}
      {response.status === 'insufficient_evidence' && (
        <Notice tone="info" title="Not enough evidence">
          {response.message ?? 'The indexed files do not support an answer to this question.'}
        </Notice>
      )}
      {response.status === 'unavailable' && <Notice tone="warning" title="No AI answer">{response.message}</Notice>}
      {response.citations.length > 0 && (
        <div className="stack">
          <p className="section-title">{response.status === 'answered' ? 'Sources' : 'Most relevant passages'}</p>
          <ol className="citations" ref={listRef}>
            {response.citations.map((citation) => (
              <CitationItem key={citation.number} repo={repo} citation={citation} focused={focused === citation.number} />
            ))}
          </ol>
        </div>
      )}
      <p className="hint">
        From commit <code>{shortSha(response.commitSha)}</code> using {retrieval}.
      </p>
    </div>
  )
}

function CitationItem({ repo, citation, focused }: { repo: RepoSummary; citation: Citation; focused: boolean }) {
  const href = filesHref(repo.id, citation.path, [citation.startLine, citation.endLine])
  return (
    <li className={focused ? 'citation citation--focused' : 'citation'} data-citation={citation.number}>
      <div className="citation__header">
        <span className="cite cite--static">{citation.number}</span>
        <a href={href} onClick={(event) => { event.preventDefault(); navigate(href) }} className="citation__path">
          <code>{citation.path}</code> <span className="muted">lines {citation.startLine}–{citation.endLine}</span>
        </a>
        <a href={citation.url} target="_blank" rel="noopener noreferrer" className="citation__github">
          GitHub ↗
        </a>
      </div>
      <details open={focused}>
        <summary>Show snippet</summary>
        <CodeView content={citation.snippet} startAt={citation.startLine} />
      </details>
    </li>
  )
}
