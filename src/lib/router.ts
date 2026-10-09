import { useSyncExternalStore } from 'react'

/** A tiny History-API router: enough for a handful of routes, no dependency. */

const CHANGE = 'repomind:navigate'

function subscribe(callback: () => void) {
  window.addEventListener('popstate', callback)
  window.addEventListener(CHANGE, callback)
  return () => {
    window.removeEventListener('popstate', callback)
    window.removeEventListener(CHANGE, callback)
  }
}

const snapshot = () => window.location.pathname + window.location.search

export function useLocation(): { pathname: string; search: URLSearchParams } {
  const value = useSyncExternalStore(subscribe, snapshot)
  const url = new URL(value, window.location.origin)
  return { pathname: url.pathname, search: url.searchParams }
}

export function navigate(to: string, options: { replace?: boolean } = {}) {
  if (to === snapshot()) return
  if (options.replace) window.history.replaceState(null, '', to)
  else window.history.pushState(null, '', to)
  window.dispatchEvent(new Event(CHANGE))
  if (!options.replace) window.scrollTo(0, 0)
}

/** Matches `/repos/:id/files` style patterns; returns params or null. */
export function match(pattern: string, pathname: string): Record<string, string> | null {
  const a = pattern.split('/')
  const b = pathname.replace(/\/$/, '').split('/')
  if (a.length !== b.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(':')) {
      try {
        params[a[i].slice(1)] = decodeURIComponent(b[i])
      } catch {
        return null
      }
    } else if (a[i] !== b[i]) {
      return null
    }
  }
  return params
}

/** Internal link that navigates without a full reload. */
export function linkHandler(to: string) {
  return (event: { preventDefault(): void; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; button: number }) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return
    event.preventDefault()
    navigate(to)
  }
}
