/**
 * The Zcash side.
 *
 * Two implementations behind one interface, because the biggest open
 * question in this product is whether a dApp can make the Noir Wallet send
 * to an external address at all (spikes/02-noir-send.ts). If it can, the
 * extension path is the good one. If it cannot, step 3 of the fund flow
 * does not collapse: the person pastes an address and sends the ZEC from
 * any wallet themselves.
 *
 * Building the fallback now means the answer to spike 02 changes which path
 * runs, not whether the product works.
 *
 * Neither implementation ever sees a Zcash key. The extension holds them;
 * the manual path has the person use their own wallet. That is not a
 * limitation to work around — it is the arrangement.
 */

import type { NoirWalletAdapter } from '../types'
import {
  type Amount,
  type ShieldedAddress,
  type ZcashNetwork,
  amount,
  formatAmount,
} from '@/core/types'
import type { Logger } from '@/core/log'

/**
 * The human-readable prefixes of the shielded address kinds, by network.
 *
 * Longest first, so `utest1` is tried before `u1` would be considered. They
 * do not actually overlap — the second character differs — but ordering by
 * length keeps that from being a property anyone has to notice.
 *
 * `uregtest1` is deliberately absent. Regtest is a private chain anyone can
 * mint on, so an address from it is not evidence of anything and must not be
 * mistaken for testnet.
 */
const SHIELDED_PREFIXES: readonly { readonly prefix: string; readonly network: ZcashNetwork }[] = [
  { prefix: 'ztestsapling1', network: 'test' },
  { prefix: 'utest1', network: 'test' },
  { prefix: 'zs1', network: 'main' },
  { prefix: 'u1', network: 'main' },
]

/**
 * Which network a shielded address belongs to, or `undefined` if it is not a
 * shielded address at all.
 *
 * This reads the prefix and the shape; it does not decode the address. For a
 * unified address that means it cannot tell which receivers are inside, and
 * in particular cannot tell an Orchard-only address — which can no longer
 * receive, now that NU7 has sealed the pool — from one carrying an Ironwood
 * or Sapling receiver. The sending wallet refuses that send, so the cost of
 * not knowing here is a clear failure at send time rather than lost funds.
 */
export function shieldedNetwork(value: string): ZcashNetwork | undefined {
  const trimmed = value.trim().toLowerCase()
  for (const { prefix, network } of SHIELDED_PREFIXES) {
    if (!trimmed.startsWith(prefix)) continue
    // Length and charset are a sanity check, not validation: the wallet is
    // what actually decodes a bech32m address, and it is the one to trust.
    if (/^[0-9a-z]{30,}$/.test(trimmed.slice(prefix.length))) return network
  }
  return undefined
}

/**
 * Unified and Sapling addresses can receive shielded. Transparent ones
 * cannot, and accepting one would publish the amount and the link while still
 * looking like it worked.
 *
 * `network` is required and has no default. An optional parameter meaning
 * "any network" would be precisely the hole this exists to close, and making
 * it required turns every call site into a compile error until it has been
 * thought about.
 */
export function isShieldedAddress(value: string, network: ZcashNetwork): value is ShieldedAddress {
  return shieldedNetwork(value) === network
}

export class NotShieldedError extends Error {
  override readonly name = 'NotShieldedError'
  constructor(value: string, network: ZcashNetwork) {
    const trimmed = value.trim()
    const found = shieldedNetwork(trimmed)
    super(
      found !== undefined
        ? // Shielded, but on the other chain. This is the dangerous one: it
          // looks right, and on mainnet it would send real ZEC to an address
          // that does not exist on the chain it was sent on.
          `That is a ${wording(found)} address and this is the ${wording(network)} app. ` +
            'Sending to it would lose the funds rather than shield them.'
        : `That is ${/^t/i.test(trimmed) ? 'a transparent address' : 'not a Zcash address'}. ` +
            'The exit has to land on a shielded address, or the amount and the link are ' +
            'published along with it.',
    )
  }
}

function wording(network: ZcashNetwork): string {
  return network === 'test' ? 'testnet' : 'mainnet'
}

export class NoirUnavailableError extends Error {
  override readonly name = 'NoirUnavailableError'
}

/* ------------------------------------------------------------ the extension */

/**
 * The provider Noir Wallet injects, as its documentation describes it.
 *
 * This used to be a guess — `window.noir ?? window.zcash`, with methods
 * named `getNewAddress` and `send` — written before anything had been
 * checked, and every name in it was wrong. The real provider is
 * `window.noirwallet`, the Zcash calls live under `.zcash`, and the send is
 * `sendTransaction`. Spike 02 existed to settle this; the published provider
 * API settled it instead.
 *
 * Two documented facts shape what can be built on top:
 *
 *  - **There is no rotate-address call.** `connect()` returns the account's
 *    primary shielded address and nothing offers a fresh one. Address
 *    rotation is the product's unit of unlinkability, so this is a real
 *    limitation and is reported rather than papered over.
 *  - **A dApp cannot ask which network the wallet is on.** `switchNetwork`
 *    is deprecated and throws, and mainnet and testnet are separate
 *    extensions. The prefix of the address we are handed is the only signal
 *    there is, which is why `isShieldedAddress` takes a network.
 *
 * Everything here still fails closed: a provider that does not answer is
 * treated as absent, and the manual path takes over.
 */
interface NoirZcash {
  connect?: () => Promise<{ shielded?: string; transparent?: string; accounts?: unknown[] }>
  getAccounts?: () => Promise<{ shielded?: string; accounts?: unknown[] } | null>
  getBalance?: (accountId?: string) => Promise<{
    total?: string
    available?: string
    synced?: boolean
    accounts?: unknown[]
  }>
  sendTransaction?: (params: {
    to: string
    amount: string
    memo?: string
    fundingSource?: 'shielded' | 'transparent'
  }) => Promise<string>
  getTransactionHistory?: () => Promise<unknown>
}

function injected(): NoirZcash | undefined {
  const w = globalThis as { noirwallet?: { zcash?: NoirZcash } }
  return w.noirwallet?.zcash
}

/** Memos are capped at 512 bytes, and it is bytes rather than characters. */
export const MEMO_MAX_BYTES = 512

export function memoByteLength(memo: string): number {
  return new TextEncoder().encode(memo).length
}

/**
 * A Zcash transaction id: 32 bytes, written as 64 hex characters.
 *
 * Checked because the alternative was returning the string `'unknown'` when
 * the wallet gave nothing back, and a submission whose evidence is the word
 * "unknown" is worse than one that admits it has none.
 */
export function isTxid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value.trim())
}

/**
 * A decimal ZEC string from the wallet, as zatoshis.
 *
 * Done on the string rather than through `Number`, because a float carries
 * about fifteen significant digits and ZEC has eight decimals on top of
 * however many whole units: the rounding is silent and the error is money.
 * A ninth decimal place is a refusal, not a rounding — the wallet quoting
 * more precision than the chain has means something is wrong with the
 * reading, and guessing which way to round it is not this code's business.
 */
export function parseZec(value: string): Amount {
  const trimmed = value.trim()
  const match = /^(\d+)(?:\.(\d{1,8}))?$/.exec(trimmed)
  if (!match) throw new NoirUnavailableError(`the wallet gave "${value}" where a ZEC amount goes`)
  const [, whole = '0', frac = ''] = match
  return amount('ZEC', BigInt(whole) * 100_000_000n + BigInt(frac.padEnd(8, '0')))
}

export function createNoirExtensionAdapter(
  logger: Logger,
  network: ZcashNetwork,
): NoirWalletAdapter {
  const api = () => {
    const found = injected()
    if (!found) throw new NoirUnavailableError('no Noir Wallet is injected on this page')
    return found
  }

  return {
    async isAvailable() {
      return Boolean(injected())
    },
    async connect() {
      // The documentation is explicit that this needs a user gesture, so it
      // belongs to a button press and never to a render.
      await api().connect?.()
    },
    async freshReceiveAddress(): Promise<ShieldedAddress> {
      const wallet = api()
      /*
       * Not rotated, whatever the name of this method promises. The provider
       * has no call for a new address, so this is the account's primary
       * shielded one and reusing it joins this session to the last. The
       * caller is told through `chooseNoir`'s reason; here the job is simply
       * not to invent an address that does not exist.
       */
      const existing = await wallet.getAccounts?.()
      const value = existing?.shielded ?? (await wallet.connect?.())?.shielded
      if (!value) throw new NoirUnavailableError('the wallet gave no shielded address')
      // Separate extensions build mainnet and testnet, and a dApp cannot ask
      // which one this is. The address prefix is the only evidence there is.
      if (!isShieldedAddress(value, network)) throw new NotShieldedError(value, network)
      return value
    },
    async send(to: string, value: Amount, memo?: string) {
      const wallet = api()
      if (!wallet.sendTransaction) {
        throw new NoirUnavailableError(
          'this Noir Wallet exposes no sendTransaction to a dApp; use the manual path',
        )
      }
      if (memo !== undefined && memoByteLength(memo) > MEMO_MAX_BYTES) {
        // Counted in bytes, because a memo of 512 characters is over the
        // limit the moment one of them is not ASCII.
        throw new NoirUnavailableError(
          `that memo is ${memoByteLength(memo)} bytes and the limit is ${MEMO_MAX_BYTES}`,
        )
      }
      const txid = await wallet.sendTransaction({
        to,
        // `formatAmount` yields a bare decimal string. Nothing here goes
        // near a float: eight decimals do not survive one.
        amount: formatAmount(value),
        ...(memo ? { memo } : {}),
        // Passed rather than defaulted, so a future change to the default
        // cannot silently start spending transparent funds.
        fundingSource: 'shielded',
      })
      if (!isTxid(txid)) {
        throw new NoirUnavailableError(
          'the wallet approved the send but returned no usable transaction id',
        )
      }
      logger.info('noir send accepted', { broadcast: true })
      // Broadcast is not payment. The caller still has to see it mined.
      return { txid: txid.trim().toLowerCase() }
    },
    /**
     * The shielded address of an already-connected site, or null.
     *
     * Never prompts. `getAccounts()` is documented as needing no approval
     * and as answering null when the site is not connected, so this reads a
     * permission that was already granted rather than asking for one. That
     * distinction is what makes it safe to call on mount, where a `connect()`
     * would be a popup nobody asked for — and would be refused anyway,
     * since connecting requires a user gesture.
     */
    async connectedAddress(): Promise<ShieldedAddress | null> {
      const value = (await api().getAccounts?.())?.shielded
      if (!value) return null
      // A wallet on the other network is not a connection this page can use.
      return isShieldedAddress(value, network) ? value : null
    },
    async history(): Promise<unknown> {
      const read = api().getTransactionHistory
      if (!read) {
        throw new NoirUnavailableError('this Noir Wallet exposes no transaction history to a dApp')
      }
      // Returned raw. Nothing here knows the shape, and `statusOf` in
      // ./history is where that is dealt with honestly.
      return read()
    },
    async balance(): Promise<Amount> {
      const raw = await api().getBalance?.()
      if (!raw) throw new NoirUnavailableError('the wallet gave no balance')
      /*
       * `synced: false` marks a zero the wallet is falling back to while it
       * catches up, not a wallet with nothing in it. Returning it would show
       * an empty balance to someone whose funds are fine, and — worse — let
       * an amount picker conclude there is nothing to send.
       */
      if (raw.synced === false) {
        throw new NoirUnavailableError('the wallet is still syncing, so its balance is not known yet')
      }
      // `available` excludes pending funds; `total` includes money that
      // cannot be spent yet, and offering that is how a send fails late.
      const value = raw.available
      if (value === undefined) throw new NoirUnavailableError('the wallet gave no spendable balance')
      return parseZec(value)
    },
  }
}

/* ---------------------------------------------------------------- by hand */

/**
 * What the UI must be able to ask. The adapter does not know how these are
 * presented; it only knows it cannot continue without an answer.
 */
export interface ManualPrompts {
  /** Ask for a freshly rotated shielded address to receive the exit. */
  askReceiveAddress(): Promise<string>
  /**
   * Show the deposit address and amount, and resolve when the person says
   * they have sent it. Rejecting cancels the session cleanly.
   */
  confirmSent(request: { to: string; value: Amount; memo?: string }): Promise<void>
  /** Optional: what they say they hold, for the amount picker. */
  askBalance?(): Promise<Amount>
}

/**
 * The fallback the architecture doc names: the person pastes an address and
 * sends the ZEC from whatever wallet they like.
 *
 * The app cannot see that the send happened, and does not pretend to. It
 * returns no transaction id and the session waits on the solver's status
 * instead, which is how the orchestrator already learns a swap settled.
 */
export function createManualNoirAdapter(
  prompts: ManualPrompts,
  logger: Logger,
  network: ZcashNetwork,
): NoirWalletAdapter {
  return {
    async isAvailable() {
      return true
    },
    async connect() {},

    async freshReceiveAddress(): Promise<ShieldedAddress> {
      const value = (await prompts.askReceiveAddress()).trim()
      if (!isShieldedAddress(value, network)) throw new NotShieldedError(value, network)
      return value
    },

    async send(to: string, value: Amount, memo?: string) {
      await prompts.confirmSent({ to, value, ...(memo ? { memo } : {}) })
      logger.info('manual send confirmed by the person', { amount: formatAmount(value) })
      // Nothing here witnessed a transaction, so nothing here invents an id
      // for one. The solver's status is the only honest evidence.
      return { txid: 'manual' }
    },

    async balance(): Promise<Amount> {
      return prompts.askBalance ? prompts.askBalance() : amount('ZEC', 0n)
    },
  }
}

/** True when the send came from the manual path and was never witnessed. */
export const MANUAL_TXID = 'manual'

/* -------------------------------------------------------------- choosing */

export interface ChooseNoirOptions {
  readonly prompts: ManualPrompts
  readonly logger: Logger
  /** The network every address this adapter accepts has to be on. */
  readonly network: ZcashNetwork
  /** Skip detection and take the fallback, for someone who prefers it. */
  readonly preferManual?: boolean
}

/**
 * Take the extension when it is there and will send, otherwise the person
 * does it by hand.
 *
 * The probe is cheap and read-only: an extension that is present but refuses
 * dApp sends is no better than an absent one, and finding that out at the
 * moment money should move would strand the session.
 */
export async function chooseNoir(options: ChooseNoirOptions): Promise<{
  adapter: NoirWalletAdapter
  kind: 'extension' | 'manual'
  reason?: string
}> {
  const { logger, prompts, network } = options
  if (options.preferManual) {
    return { adapter: createManualNoirAdapter(prompts, logger, network), kind: 'manual' }
  }

  const found = injected()
  if (!found) {
    return {
      adapter: createManualNoirAdapter(prompts, logger, network),
      kind: 'manual',
      reason: 'no Noir Wallet is installed on this browser',
    }
  }
  if (typeof found.sendTransaction !== 'function') {
    return {
      adapter: createManualNoirAdapter(prompts, logger, network),
      kind: 'manual',
      reason: 'the installed wallet does not let a page send on its behalf',
    }
  }
  return {
    adapter: createNoirExtensionAdapter(logger, network),
    kind: 'extension',
    /*
     * Taken, but not silently. The provider has no call for a fresh
     * address, so the exit lands on the account's primary shielded one, and
     * a second session landing on the same address links the two. That is a
     * real cost and the person carrying it should be the one who knows.
     */
    reason:
      'Noir Wallet offers no rotated address, so the exit reuses the account’s primary ' +
      'shielded address. A second session on the same address links the two.',
  }
}
