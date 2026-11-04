/**
 * The Nym mixnet, as a transport.
 *
 * This is the one arrangement that makes a browser page private by itself.
 * `mixFetch` runs a mixnet client in a Web Worker: the request takes several
 * hops and leaves through an IPR gateway, so 1Click and Lighter see the
 * gateway's address and never ours.
 *
 * Three things about it shape this file:
 *
 *   - **No AbortController.** The documented limitations rule it out, so the
 *     deadline here is a race rather than a cancel. The request keeps going
 *     after we stop waiting; we just stop trusting it.
 *   - **It is slow to start.** A cold tunnel has been measured at fifteen to
 *     thirty seconds, so `warmMixnet` exists to pay that before the person
 *     is waiting on a quote.
 *   - **It is a large WASM payload.** The import is dynamic so it stays out
 *     of the main bundle and out of the way of anyone who never uses it.
 *
 * Its other limitations — no cookies, no cache, HTTPS only — are things this
 * product already wanted.
 */

import type { NetworkAdapter } from '../types'
import { NetworkTimeoutError, DEFAULT_TIMEOUT_MS } from './index'

/** The slice of @nymproject/mix-fetch this file uses. */
export interface MixFetchModule {
  createMixFetch: (opts?: Record<string, unknown>) => Promise<
    (url: string, init?: RequestInit) => Promise<Response>
  >
  getTunnelState: () => { state: string }
  disconnectMixTunnel: () => Promise<void> | void
}

export type MixnetState = 'idle' | 'connecting' | 'ready' | 'failed'

export class MixnetUnavailableError extends Error {
  override readonly name = 'MixnetUnavailableError'
}

export interface MixnetOptions {
  readonly timeoutMs?: number
  /** How long to allow for the tunnel itself to come up. */
  readonly connectTimeoutMs?: number
  /** Swappable so this is testable without the WASM worker. */
  readonly load?: () => Promise<MixFetchModule>
  readonly onState?: (state: MixnetState) => void
}

const defaultLoad = (): Promise<MixFetchModule> =>
  import('@nymproject/mix-fetch') as unknown as Promise<MixFetchModule>

/** Deadline without cancellation, because mixFetch has no AbortController. */
async function withDeadline<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new NetworkTimeoutError(label, ms)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Bring the tunnel up and hand back an adapter.
 *
 * The tunnel underneath is a singleton, so calling this twice is cheap and
 * the second caller joins the first.
 */
export async function createMixnetNetwork(
  options: MixnetOptions = {},
): Promise<NetworkAdapter & { readonly state: () => MixnetState; disconnect: () => Promise<void> }> {
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const connectTimeout = options.connectTimeoutMs ?? 45_000
  const load = options.load ?? defaultLoad

  options.onState?.('connecting')

  let mod: MixFetchModule
  try {
    mod = await load()
  } catch (error) {
    options.onState?.('failed')
    throw new MixnetUnavailableError(
      `the mixnet client could not be loaded: ${error instanceof Error ? error.message : error}`,
    )
  }

  let send: (url: string, init?: RequestInit) => Promise<Response>
  try {
    send = await withDeadline(
      mod.createMixFetch({ connectTimeoutMs: connectTimeout }),
      connectTimeout,
      'the mixnet',
    )
  } catch (error) {
    options.onState?.('failed')
    throw new MixnetUnavailableError(
      error instanceof NetworkTimeoutError
        ? 'the mixnet did not come up in time'
        : `the mixnet refused to start: ${error instanceof Error ? error.message : error}`,
    )
  }

  options.onState?.('ready')

  return {
    kind: 'nym',
    // Not a claim about configuration: the traffic really does leave through
    // a gateway rather than this machine.
    isPrivate: true,
    assurance: 'verified',
    state: () => {
      try {
        const raw = mod.getTunnelState().state
        return raw === 'ready' || raw === 'connecting' || raw === 'failed' ? raw : 'idle'
      } catch {
        return 'idle'
      }
    },
    async fetch(input, init) {
      return withDeadline(
        send(input, {
          ...init,
          // Harmless against a transport that carries neither, and it keeps
          // the intent stated in one place.
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          cache: 'no-store',
        }),
        timeout,
        input,
      )
    },
    async disconnect() {
      try {
        await mod.disconnectMixTunnel()
      } finally {
        options.onState?.('idle')
      }
    },
  }
}

/**
 * Start the tunnel early, swallowing failure.
 *
 * Called on load so the first quote is not also the first fifteen to thirty
 * seconds of mixnet setup. Nothing depends on it succeeding.
 */
export function warmMixnet(options: MixnetOptions = {}): void {
  void createMixnetNetwork(options).catch(() => undefined)
}
