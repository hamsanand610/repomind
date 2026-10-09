import { useEffect, useMemo, useRef } from 'react'

/** Read-only source with GitHub line numbers; an optional range is highlighted and scrolled into view. */
export function CodeView({ content, highlight, startAt = 1 }: { content: string; highlight?: [number, number] | null; startAt?: number }) {
  const lines = useMemo(() => (content === '' ? [] : content.split('\n')), [content])
  const ref = useRef<HTMLDivElement>(null)
  const [from, to] = highlight ?? [0, -1]

  useEffect(() => {
    if (!highlight) return
    ref.current?.querySelector('[data-highlight="true"]')?.scrollIntoView({ block: 'center' })
  }, [highlight])

  if (lines.length === 0) return <p className="code__empty">This file is empty.</p>
  const width = String(startAt + lines.length - 1).length
  return (
    <div className="code" ref={ref} style={{ ['--gutter' as string]: `${width + 2}ch` }}>
      <pre>
        <code>
          {lines.map((line, i) => {
            const number = startAt + i
            const marked = number >= from && number <= to
            return (
              <span key={number} className={marked ? 'code__line code__line--marked' : 'code__line'} data-highlight={marked && number === from ? 'true' : undefined}>
                <span className="code__number" aria-hidden="true">
                  {number}
                </span>
                <span className="code__text">{line || ' '}</span>
              </span>
            )
          })}
        </code>
      </pre>
    </div>
  )
}
