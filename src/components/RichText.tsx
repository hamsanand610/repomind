import { Fragment, type ReactNode } from 'react'

/**
 * Renders model-written answer text as React elements: paragraphs, bullet and
 * numbered lists, fenced code, inline code, bold and [n] citation markers.
 * Nothing is ever injected as HTML, and model-written links are shown as
 * plain text: only server-built citation links are clickable.
 */
export function RichText({ text, onCite }: { text: string; onCite?: (number: number) => void }) {
  const blocks: ReactNode[] = []
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim().startsWith('```')) {
      const code: string[] = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith('```')) code.push(lines[i++])
      i++
      blocks.push(
        <pre className="rich__code" key={blocks.length}>
          <code>{code.join('\n')}</code>
        </pre>,
      )
      continue
    }
    const bullet = /^\s*[-*•]\s+(.*)$/
    const numbered = /^\s*\d+[.)]\s+(.*)$/
    if (bullet.test(line) || numbered.test(line)) {
      const ordered = numbered.test(line)
      const pattern = ordered ? numbered : bullet
      const items: string[] = []
      while (i < lines.length && pattern.test(lines[i])) {
        items.push((pattern.exec(lines[i]) as RegExpExecArray)[1])
        i++
      }
      const ListTag = ordered ? 'ol' : 'ul'
      blocks.push(
        <ListTag className="rich__list" key={blocks.length}>
          {items.map((item, n) => (
            <li key={n}>{inline(item, onCite)}</li>
          ))}
        </ListTag>,
      )
      continue
    }
    if (line.trim() === '') {
      i++
      continue
    }
    const paragraph: string[] = []
    while (i < lines.length && lines[i].trim() !== '' && !lines[i].trim().startsWith('```') && !bullet.test(lines[i]) && !numbered.test(lines[i])) {
      paragraph.push(lines[i++].replace(/^#{1,6}\s+/, ''))
    }
    blocks.push(<p key={blocks.length}>{inline(paragraph.join(' '), onCite)}</p>)
  }
  return <div className="rich">{blocks}</div>
}

/** Inline code, **bold** and [n] citation markers. */
function inline(text: string, onCite?: (number: number) => void): ReactNode[] {
  const out: ReactNode[] = []
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[\d+\])/g
  let last = 0
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0
    if (index > last) out.push(<Fragment key={out.length}>{text.slice(last, index)}</Fragment>)
    const token = match[0]
    if (match[1]) out.push(<code key={out.length}>{token.slice(1, -1)}</code>)
    else if (match[2]) out.push(<strong key={out.length}>{token.slice(2, -2)}</strong>)
    else {
      const number = Number(token.slice(1, -1))
      out.push(
        <button key={out.length} type="button" className="cite" onClick={() => onCite?.(number)} aria-label={`Show source ${number}`}>
          {number}
        </button>,
      )
    }
    last = index + token.length
  }
  if (last < text.length) out.push(<Fragment key={out.length}>{text.slice(last)}</Fragment>)
  return out
}
