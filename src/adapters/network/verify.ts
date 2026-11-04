/**
 * Asking the network where it comes out.
 *
 * Reading the origin only recognises an onion service. Someone running the
 * app in a Tor browser window, or behind system-wide Tor, is just as private
 * and would otherwise be told they are not and blocked from moving money.
 *
 * So this asks a check service, through the same transport the app uses, and
 * believes the answer. Two rules keep it honest:
 *
 *   - **It never runs on its own.** A privacy product that calls a third
 *     party on every load is doing the thing it warns about. This is wired
 *     to a button the person presses.
 *   - **The address is never kept.** The service replies with the exit IP;
 *     only the yes-or-no is read out of it. Nothing here returns, logs or
 *     stores the address, because an exit IP written into a log is the link
 *     the product exists to break.
 */

import type { NetworkAdapter } from '../types'
import { createDirectNetwork } from './index'

/** Returns `{"IsTor":true,"IP":"…"}`. We read the first field and drop the rest. */
export const TOR_CHECK_URL = 'https://check.torproject.org/api/ip'

export type ExitCheck =
  | { readonly result: 'tor' }
  | { readonly result: 'not-tor' }
  | { readonly result: 'unknown'; readonly reason: string }

export interface CheckOptions {
  readonly url?: string
  readonly timeoutMs?: number
}

/**
 * Ask whether this connection leaves through Tor.
 *
 * `unknown` is not a failure to handle loosely: the caller must treat it as
 * "not confirmed" and leave the checker blocking.
 */
export async function checkTorExit(
  network: NetworkAdapter,
  options: CheckOptions = {},
): Promise<ExitCheck> {
  const url = options.url ?? TOR_CHECK_URL
  try {
    const response = await network.fetch(url)
    if (!response.ok) return { result: 'unknown', reason: `the check service answered ${response.status}` }
    const body = (await response.json()) as { IsTor?: unknown }
    if (typeof body.IsTor !== 'boolean') {
      return { result: 'unknown', reason: 'the check service answered in an unexpected shape' }
    }
    // Only the boolean leaves this function. body.IP is deliberately dropped.
    return body.IsTor ? { result: 'tor' } : { result: 'not-tor' }
  } catch (error) {
    return {
      result: 'unknown',
      reason: error instanceof Error ? error.message : 'the check service could not be reached',
    }
  }
}

/**
 * A direct adapter that has been confirmed to leave through Tor.
 *
 * The person is running the app inside Tor themselves — a Tor browser
 * window, or system-wide Tor — so the page's ordinary requests are already
 * inside it. `verified` because it was measured, not asserted.
 */
export function createCheckedTorNetwork(
  base: NetworkAdapter = createDirectNetwork(),
): NetworkAdapter {
  return {
    kind: 'tor',
    isPrivate: true,
    assurance: 'verified',
    fetch: base.fetch,
  }
}

/**
 * Run the check and return an upgraded adapter when it passes.
 *
 * Returns the original adapter untouched when it does not, so a failed or
 * inconclusive check can never make the app look more private than it is.
 */
export async function upgradeIfTor(
  network: NetworkAdapter,
  options: CheckOptions = {},
): Promise<{ network: NetworkAdapter; check: ExitCheck }> {
  if (network.isPrivate) return { network, check: { result: 'unknown', reason: 'already private' } }
  const check = await checkTorExit(network, options)
  return check.result === 'tor'
    ? { network: createCheckedTorNetwork(network), check }
    : { network, check }
}

/** What to show the person after they press the button. */
export function describeCheck(check: ExitCheck): string {
  switch (check.result) {
    case 'tor':
      return 'This connection leaves through Tor. Sessions can proceed.'
    case 'not-tor':
      return 'This connection leaves from your own address. Open the app in a Tor browser window, or start the mixnet, before moving anything.'
    case 'unknown':
      return `The check could not be completed (${check.reason}). Treat the connection as not private.`
  }
}
