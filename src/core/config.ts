import type { EvmAddress } from './types'

/**
 * What the browser build knows about the outside world.
 *
 * Only `VITE_`-prefixed variables reach the client; the ones in `.env`
 * without that prefix belong to the spikes, which run under Node. Nothing
 * secret goes here: anything in this file is readable by anyone who opens
 * the page, so a key that must stay private cannot live in a static app.
 *
 * Every value is optional. Missing configuration makes a movement refuse
 * with a reason, which is the behaviour the capability report depends on —
 * never a default that quietly does something less private.
 */

const read = (name: string): string | undefined => {
  const value = (import.meta.env as Record<string, string | undefined>)[name]
  return value && value.length > 0 ? value : undefined
}

const address = (name: string): EvmAddress | undefined => {
  const value = read(name)
  return value && /^0x[0-9a-fA-F]{40}$/.test(value) ? (value as EvmAddress) : undefined
}

export interface AppConfig {
  /**
   * The Arbitrum RPCs, in the order they were given.
   *
   * An RPC is unavoidable: the session has to send a transfer on Arbitrum,
   * and that means asking some node. What matters is what the node learns.
   *
   * Every call goes through `rpcOver`, which uses the network adapter, and
   * the checker refuses to move anything while that adapter is not private.
   * So the provider sees a Tor or Nym exit, not the person — and the address
   * it is asked about is on a public chain anyway, where a block explorer
   * shows the same thing to anyone.
   *
   * What one provider can still do is notice that two session wallets were
   * asked about by the same customer, and so link two sessions that have
   * nothing else in common. That is what a list fixes: `pickRpc` gives each
   * session a different endpoint, so no provider sees more than its share.
   *
   * There is no default. A public endpoint baked into the build would hand
   * one company that graph for every user of the app, and would be used by
   * everyone who never thought about it.
   */
  readonly rpcUrls: readonly string[]
  /** Raises the 1Click fee from 0.25% to 0.20%. Public by nature. */
  readonly oneClickJwt: string | undefined
  readonly bundlerUrl: string | undefined
  readonly paymasterAddress: EvmAddress | undefined
  readonly delegateAddress: EvmAddress | undefined
  /**
   * Run the real adapters against the real venues with the privacy gate off.
   *
   * There is exactly one reason this exists: the end-to-end path cannot be
   * exercised locally otherwise. The checker refuses every movement while
   * the connection is not private, which is correct for the product and
   * useless for finding out whether 1Click, Lighter and the signer actually
   * work together. So this turns the gate into a warning — and nothing else.
   * Every adapter stays real, every signature is real, and every transfer
   * spends real money.
   *
   * What it costs, said plainly rather than buried: the venues see the
   * machine's own IP address, the two swap legs and the Lighter account are
   * linkable to it and to each other, and that linkage is permanent and
   * public. Use a throwaway amount and assume this session is deanonymised.
   *
   * `import.meta.env.DEV` is folded to `false` at build time, so the flag
   * cannot be set in anything that ships, whatever the environment says.
   * That is deliberate: a privacy gate with a production escape hatch is
   * not a privacy gate.
   */
  readonly unsafeLiveTest: boolean
}

/**
 * Split a comma-separated list, dropping blanks and duplicates.
 *
 * Duplicates are dropped because a list with the same endpoint twice would
 * quietly halve the rotation while looking like it had not.
 */
function list(name: string): readonly string[] {
  const raw = read(name)
  if (!raw) return []
  return [...new Set(raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0))]
}

/**
 * Which endpoint a session uses, by its key index.
 *
 * Deterministic rather than random, and that is the point. A random pick
 * would land two sessions on the same provider now and then — exactly the
 * event this is meant to prevent — and would re-roll every time the adapters
 * were rebuilt, scattering one session across several providers. Key indices
 * are consecutive, so any run of n sessions gets n different endpoints.
 */
export function pickRpc(urls: readonly string[], keyIndex: number): string | undefined {
  if (urls.length === 0) return undefined
  // Negative or fractional indices would wrap backwards or miss; neither
  // should ever happen, and neither should silently pick nothing.
  const i = Math.abs(Math.trunc(keyIndex)) % urls.length
  return urls[i]
}

export function readConfig(): AppConfig {
  return {
    rpcUrls: list('VITE_ARBITRUM_RPC_URLS').length
      ? list('VITE_ARBITRUM_RPC_URLS')
      : // The singular name still works, and is simply a list of one.
        list('VITE_ARBITRUM_RPC_URL'),
    oneClickJwt: read('VITE_ONECLICK_JWT'),
    bundlerUrl: read('VITE_BUNDLER_URL'),
    paymasterAddress: address('VITE_PAYMASTER_ADDRESS'),
    delegateAddress: address('VITE_DELEGATE_ADDRESS'),
    // The `DEV` conjunct is the whole safety property. Read it as: the flag
    // is only ever consulted when this is a dev server, never in a build.
    unsafeLiveTest: Boolean(import.meta.env.DEV) && read('VITE_UNSAFE_LIVE_TEST') === '1',
  }
}

/** What is missing before the app can run against the real thing at all. */
export function configGaps(config: AppConfig): readonly string[] {
  const gaps: string[] = []
  if (config.rpcUrls.length === 0) {
    gaps.push('VITE_ARBITRUM_RPC_URLS, so nothing can read Arbitrum')
  }
  if (!config.bundlerUrl) gaps.push('VITE_BUNDLER_URL, so gas cannot be paid in USDC')
  if (!config.paymasterAddress) gaps.push('VITE_PAYMASTER_ADDRESS')
  if (!config.delegateAddress) gaps.push('VITE_DELEGATE_ADDRESS')
  return gaps
}
