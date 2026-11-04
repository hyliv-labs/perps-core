/**
 * A path router in thirty lines.
 *
 * Two routes, no dependency. Paths rather than hashes, so the landing page
 * is a real URL people can link to — which means static hosting needs a
 * fallback to index.html for unknown paths (see public/_redirects and the
 * deployment note in the README).
 */

import { useEffect, useState } from 'react'

export type Route = '/' | '/app' | '/pay'

function toRoute(pathname: string): Route {
  const path = pathname.replace(/\/+$/, '')
  if (path === '/app') return '/app'
  if (path === '/pay') return '/pay'
  return '/'
}

export function useRoute(): [Route, (next: Route) => void] {
  const [route, setRoute] = useState<Route>(() => toRoute(window.location.pathname))

  useEffect(() => {
    const onPop = () => setRoute(toRoute(window.location.pathname))
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const navigate = (next: Route) => {
    if (next === toRoute(window.location.pathname)) return
    window.history.pushState(null, '', next)
    setRoute(next)
    // A pushState navigation does not move focus or scroll; both are the
    // browser's job on a real navigation, so do them by hand.
    window.scrollTo(0, 0)
    document.getElementById('main')?.focus()
  }

  return [route, navigate]
}
