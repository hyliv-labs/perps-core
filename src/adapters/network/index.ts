/**
 * The network layer.
 *
 * One honest fact shapes everything here: **a web page cannot route its own
 * requests over Tor.** There is no browser API for it. A page can only be
 * loaded somewhere that is already private, and then be careful.
 *
 * So this adapter does not make the connection private. It reports whether
 * it is, and the checker refuses to move money when it is not. The three
 * arrangements, strongest first:
 *
 *   1. **Onion origin.** The app is served as a Tor onion service and the
 *      page was loaded from a `.onion` host. Every same-origin and outbound
 *      request from that page is already inside Tor, and the origin is
 *      something we can actually read rather than guess at.
 *   2. **A proxy the user runs.** They point the app at a local forwarder
 *      that they have put over Tor or Nym themselves. We can confirm it
 *      answers; we cannot confirm what is behind it, so this is their
 *      assertion and is labelled as such.
 *   3. **Direct.** Honest about being nothing: `isPrivate` is false and the
 *      checker blocks every movement.
 *
 * Whatever the arrangement, every request made through here drops cookies,
 * drops the referrer, skips the cache and carries a deadline. Those are the
 * leaks a page gives away without being asked.
 */

import type { NetworkAdapter } from '../types'

export const DEFAULT_TIMEOUT_MS = 30_000

export class NetworkTimeoutError extends Error {
  override readonly name = 'NetworkTimeoutError'
  constructor(url: string, ms: number) {
    // The URL's path can name a deposit address, so only the origin is kept.
    super(`${safeOrigin(url)} did not answer within ${ms}ms`)
  }
}

export class NotOnionError extends Error {
  override readonly name = 'NotOnionError'
  constructor(host: string) {
    super(`this page is served from ${host}, not a .onion address`)
  }
}

/** Only the origin: a path can carry a deposit address or a quote id. */
function safeOrigin(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return 'the endpoint'
  }
}

/**
 * The hardening every arrangement shares. A browser will attach cookies and
 * a referrer unless told not to, and either one links two requests that
 * should look unrelated.
 */
async function guardedFetch(
  input: string,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(input, {
      ...init,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal,
    })
  } catch (error) {
    if (controller.signal.aborted) throw new NetworkTimeoutError(input, timeoutMs)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export interface NetworkOptions {
  readonly timeoutMs?: number
  /** Overridable so this is testable off a real browser. */
  readonly hostname?: string
}

/**
 * No protection at all, and it says so. Useful for development, and the
 * checker will refuse every movement while it is in use.
 */
export function createDirectNetwork(options: NetworkOptions = {}): NetworkAdapter {
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return {
    kind: 'direct',
    isPrivate: false,
    assurance: 'none',
    fetch: (input, init) => guardedFetch(input, init, timeout),
  }
}

/**
 * The page is inside Tor because it was loaded from an onion address.
 *
 * Refuses to be created anywhere else: an adapter that claimed Tor on an
 * ordinary origin would be a lie the checker then trusts.
 */
export function createOnionNetwork(options: NetworkOptions = {}): NetworkAdapter {
  const host = options.hostname ?? globalThis.location?.hostname ?? ''
  if (!isOnion(host)) throw new NotOnionError(host || 'an unknown host')
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return {
    kind: 'tor',
    // Read off the origin, not taken on trust.
    isPrivate: true,
    assurance: 'verified',
    fetch: (input, init) => guardedFetch(input, init, timeout),
  }
}

export function isOnion(hostname: string): boolean {
  return /\.onion$/i.test(hostname)
}

export interface ProxyOptions extends NetworkOptions {
  /** A forwarder the user runs, e.g. http://127.0.0.1:8118/ */
  readonly endpoint: string
  /** Tor or Nym, as the user described it. Theirs to assert, not ours. */
  readonly kind: 'tor' | 'nym'
  /**
   * The user has stated this forwarder really is over Tor or Nym. We cannot
   * see behind it, so without this it is treated as no protection.
   */
  readonly asserted: boolean
}

/**
 * Route through a forwarder the user runs themselves.
 *
 * The target URL is passed on rather than fetched directly, so the browser
 * never resolves or connects to the destination.
 */
export function createProxyNetwork(options: ProxyOptions): NetworkAdapter {
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const base = options.endpoint.endsWith('/') ? options.endpoint : `${options.endpoint}/`
  return {
    kind: options.kind,
    // Their word, not our measurement. Said plainly so the checker's verdict
    // means what it says.
    isPrivate: options.asserted,
    assurance: options.asserted ? 'asserted' : 'none',
    fetch: (input, init) =>
      guardedFetch(`${base}${encodeURIComponent(input)}`, init, timeout),
  }
}

/** Does the forwarder answer at all? Says nothing about what is behind it. */
export async function proxyReachable(endpoint: string, timeoutMs = 5_000): Promise<boolean> {
  try {
    const response = await guardedFetch(endpoint, { method: 'HEAD' }, timeoutMs)
    return response.ok || response.status === 405
  } catch {
    return false
  }
}

export interface ChooseOptions extends NetworkOptions {
  readonly proxy?: ProxyOptions
  /**
   * Bring the Nym mixnet up and use it. Off by default: it costs a large
   * WASM download and fifteen to thirty seconds of setup, which should be
   * the person's choice rather than something that happens to them.
   */
  readonly mixnet?: boolean
}

/**
 * Pick the strongest arrangement that is actually true right now.
 *
 * Never guesses upwards: when nothing can be confirmed it returns the direct
 * adapter, and the checker stops the session rather than letting it proceed
 * on an assumption.
 */
export async function chooseNetwork(options: ChooseOptions = {}): Promise<NetworkAdapter> {
  const host = options.hostname ?? globalThis.location?.hostname ?? ''
  // Already inside Tor, and we can read that off the origin rather than ask.
  if (isOnion(host)) return createOnionNetwork(options)

  if (options.mixnet) {
    try {
      // Imported here so the mixnet's WASM stays out of the main bundle for
      // everyone who never turns it on.
      const { createMixnetNetwork } = await import('./mixnet')
      return await createMixnetNetwork(options)
    } catch {
      // Fall through: a mixnet that will not start must not silently become
      // a direct connection that claims to be private.
    }
  }

  if (options.proxy?.asserted && (await proxyReachable(options.proxy.endpoint))) {
    return createProxyNetwork(options.proxy)
  }

  // Nothing could be confirmed, so claim nothing. The checker stops here.
  return createDirectNetwork(options)
}

/** What to tell the user about where they stand, in their words not ours. */
export function describeNetwork(network: NetworkAdapter): string {
  // Branch on the arrangement, not on the assurance. A verified mixnet is
  // every bit as verified as an onion origin and is not Tor, and describing
  // it as Tor told the person something false about where their traffic goes.
  if (network.kind === 'tor' && network.assurance === 'verified') {
    return 'This page is served over Tor, so every request is already inside it.'
  }
  if (network.kind === 'nym' && network.assurance === 'verified') {
    return 'Requests go through the Nym mixnet running in this tab, so the destination never sees your address.'
  }
  if (network.isPrivate) {
    return `Requests go through the ${network.kind} forwarder you are running. We cannot see behind it, so this is your word for it.`
  }
  return 'Requests would go out over the ordinary network, so your address would tie the deposit to the account. Nothing will move until that changes.'
}
