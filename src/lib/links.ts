/** Parses a `lines` query value such as "12" or "12-40". */
export function parseLines(value: string | null): [number, number] | null {
  const match = /^(\d+)(?:-(\d+))?$/.exec(value ?? '')
  if (!match) return null
  const start = Number(match[1])
  return [start, Math.max(start, Number(match[2] ?? start))]
}

/** In-app link to a file, optionally with a highlighted line range. */
export function filesHref(repoId: string, path: string, lines?: [number, number]) {
  const params = new URLSearchParams({ path })
  if (lines) params.set('lines', lines[0] === lines[1] ? String(lines[0]) : `${lines[0]}-${lines[1]}`)
  return `/repos/${encodeURIComponent(repoId)}/files?${params}`
}

/** Splits server snippets marked with \u0001…\u0002 into plain and highlighted parts. */
export function splitHighlights(text: string): Array<{ text: string; marked: boolean }> {
  const parts: Array<{ text: string; marked: boolean }> = []
  let index = 0
  while (index < text.length) {
    const start = text.indexOf('\u0001', index)
    if (start === -1) {
      parts.push({ text: text.slice(index), marked: false })
      break
    }
    if (start > index) parts.push({ text: text.slice(index, start), marked: false })
    const end = text.indexOf('\u0002', start + 1)
    const stop = end === -1 ? text.length : end
    parts.push({ text: text.slice(start + 1, stop), marked: true })
    index = stop + 1
  }
  return parts
}
