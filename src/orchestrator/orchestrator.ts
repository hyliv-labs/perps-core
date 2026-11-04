/**
 * The orchestrator.
 *
 * Owns the loop: read a session, run the checker, perform one effect, record
 * it, feed the resulting event back into the reducer, persist. Nothing here
 * decides policy — the checker does that — and nothing here mutates a
 * session directly; every change goes through `reduce`.
 *
 * Idempotency is the whole game. Each externally visible effect has a key
 * derived from the session and the step. The key is recorded in the session
 * journal before the effect runs, so a crash mid-flight is visible on resume
 * as "recorded but unconfirmed" rather than silently repeated.
 */

import { encodeFunctionData } from 'viem'
import type { Adapters, Position } from '@/adapters/types'
import type { LighterAccount } from '@/core/session'
import type { EvmAddress } from '@/core/types'
import type { SessionStore } from '@/core/store'
import type {
  CompletedEffect,
  Session,
  SessionEvent,
  SessionId,
  SwapLeg,
} from '@/core/session'
import { reduce } from '@/core/machine'
import { runChecker, type CheckerReport, type Movement } from '@/core/checker'
import type { Vault } from '@/core/keys'
import {
  type Amount,
  type Hex,
  type IdempotencyKey,
  type ShieldedAddress,
  amount,
  evmAddress,
  hex,
} from '@/core/types'
import type { Logger } from '@/core/log'

/** ZEC deposits get ~2 hours, matching what other 1Click integrators use. */
export const SWAP_IN_DEADLINE_MS = 2 * 60 * 60_000
export const SWAP_OUT_DEADLINE_MS = 60 * 60_000

/** The random wait before the exit swap, so entry and exit do not pair up. */
export const EXIT_DELAY_MIN_MS = 10 * 60_000
export const EXIT_DELAY_MAX_MS = 90 * 60_000

/** Native USDC on Arbitrum One. */
export const USDC_ARBITRUM = evmAddress('0xaf88d065e77c8cC2239327C5EDb3A432268e5831')

const ERC20_TRANSFER_ABI = [
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const

/** How many times the close-out is confirmed before giving up on it. */
/** How long to wait for Lighter to credit a deposit before giving up. */
export const DEPOSIT_CHECKS = 20
export const DEPOSIT_CHECK_MS = 3_000

export const FLAT_CHECKS = 6
export const FLAT_CHECK_MS = 2_000

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))

export class UnreconciledEffectError extends Error {
  override readonly name = 'UnreconciledEffectError'
  constructor(readonly step: string) {
    super(
      `The "${step}" step was started but never confirmed, and there is no way to ask ` +
        'whether it landed. It will not be run again blindly: check the venue before retrying.',
    )
  }
}

export class PositionsStillOpenError extends Error {
  override readonly name = 'PositionsStillOpenError'
  constructor(readonly open: readonly string[]) {
    super(
      `Lighter still reports an open position (${open.join(', ')}), so the withdrawal ` +
        'was not sent. Withdrawing now would retire this session with the trade still running.',
    )
  }
}

export class CheckerBlockedError extends Error {
  override readonly name = 'CheckerBlockedError'
  constructor(readonly report: CheckerReport) {
    const blocking = report.findings.filter((f) => f.severity === 'block')
    super(`checker blocked the movement: ${blocking.map((f) => f.rule).join(', ')}`)
  }
}

export interface OrchestratorDeps {
  readonly adapters: Adapters
  readonly store: SessionStore
  readonly vault: Vault
  readonly logger: Logger
  readonly now?: () => number
  /** How the orchestrator waits between polls. Tests pass a no-op. */
  readonly wait?: (ms: number) => Promise<void>
  readonly random?: () => number
  readonly newSessionId?: () => SessionId
}

function effectKey(session: Session, step: string): IdempotencyKey {
  return `${session.id}:${step}` as IdempotencyKey
}

/**
 * The index the next session will be derived at.
 *
 * Exported because the screen has to answer the same question *before* a
 * session exists: while gas is paid in ETH, someone must send a little to
 * the session wallet, and a wallet address shown from a different index
 * than `create` goes on to use is ETH sent to a wallet nothing will ever
 * open. The two cannot be allowed to compute it differently, so they call
 * the same function.
 *
 * The vault's counter lives in memory; the ledger is what survives a
 * reload. Taking the max of both stops a reload handing out index 0 again,
 * which the checker would then block forever as reuse.
 */
export async function nextKeyIndex(store: SessionStore, vault: Vault): Promise<number> {
  const ledger = await store.ledger()
  const highestClaimed = [...ledger.usedKeyIndices.keys()].reduce((max, i) => Math.max(max, i), -1)
  return Math.max(vault.nextIndex(), highestClaimed + 1)
}

export function createOrchestrator(deps: OrchestratorDeps) {
  const { adapters, store, vault, logger } = deps
  const now = deps.now ?? (() => Date.now())
  // Injected in tests, so a bounded wait does not become a bounded test run.
  const wait = deps.wait ?? sleep
  const random = deps.random ?? Math.random
  const newId =
    deps.newSessionId ?? (() => globalThis.crypto.randomUUID() as SessionId)

  /** Apply an event, persist, and return the new session. */
  async function apply(session: Session, event: SessionEvent): Promise<Session> {
    const { session: next } = reduce(session, event, now())
    if (next === session) {
      logger.debug('event ignored in this state', { event: event.type, state: session.state })
      return session
    }
    await store.save(next)
    logger.info('session advanced', {
      event: event.type,
      from: session.state,
      to: next.state,
      revision: next.revision,
    })
    return next
  }

  /**
   * Run an effect at most once per session+step.
   *
   * The journal entry is written BEFORE the effect, unconfirmed. A crash
   * between the two therefore leaves evidence the step was attempted, and
   * resume reconciles it against the outside world instead of repeating it
   * — which for `send_zec` would mean sending the user's ZEC twice.
   *
   * `reconcile` answers "did this already happen?" for an unconfirmed entry.
   * Without one, an unconfirmed entry is treated as done and NOT retried:
   * for money movements, doing nothing is the safe failure.
   */
  async function once<T>(
    session: Session,
    step: string,
    run: () => Promise<{ handle: string; value: T }>,
    reconcile?: () => Promise<{ handle: string; value: T } | null>,
  ): Promise<{ session: Session; value: T | null }> {
    const key = effectKey(session, step)
    const previous = session.completed[key]

    if (previous?.confirmed) {
      logger.debug('effect already confirmed, skipping', { step })
      return { session, value: null }
    }

    if (previous) {
      logger.warn('effect was attempted but never confirmed', { step })
      // Without a way to find out, "we do not know" is not "it is done".
      // Returning as though it had landed is how a session withdraws
      // nothing and then exits with nothing, reporting success throughout.
      if (!reconcile) throw new UnreconciledEffectError(step)
      const found = await reconcile()
      if (found) {
        const next = await apply(session, {
          type: 'effect_completed',
          effect: { key, at: now(), handle: found.handle, confirmed: true },
        })
        return { session: next, value: found.value }
      }
      logger.info('reconciled: the effect never landed, retrying', { step })
    }

    // Mark the attempt, then act. The order is the whole point.
    const attempted = await apply(session, {
      type: 'effect_completed',
      effect: { key, at: now(), handle: null, confirmed: false },
    })
    const { handle, value } = await run()
    const confirmed = await apply(attempted, {
      type: 'effect_completed',
      effect: { key, at: now(), handle, confirmed: true },
    })
    return { session: confirmed, value }
  }

  async function gate(session: Session, movement: Movement): Promise<void> {
    const report = runChecker(movement, {
      session,
      ledger: await store.ledger(),
      now: now(),
      networkPrivate: adapters.network.isPrivate,
    })
    for (const finding of report.findings) {
      logger.warn('checker finding', { rule: finding.rule, severity: finding.severity })
    }
    if (!report.pass) throw new CheckerBlockedError(report)
  }

  /**
   * Always work from what is stored, never from a caller's snapshot. A
   * caller that held a session across a thrown checker error, a reload or
   * another tab's write would otherwise save over newer state.
   */
  /**
   * What is still open, after giving the close-out a moment to fill.
   *
   * A reduce-only order is sent and then has to be matched, so asking once,
   * immediately, would nearly always find the position still there. This
   * polls a bounded number of times and then reports what is left.
   */
  async function settled(account: LighterAccount): Promise<readonly Position[]> {
    // A size of zero is flat, not open. Counting it would spend the whole
    // retry budget waiting for a position that closed before the first look.
    const live = async () =>
      (await adapters.lighter.positions(account)).filter((p) => Number(p.size) !== 0)

    let open = await live()
    for (let i = 0; open.length > 0 && i < FLAT_CHECKS; i += 1) {
      await wait(FLAT_CHECK_MS)
      open = await live()
    }
    return open
  }

  /**
   * Wait for the bridge to credit the deposit, then open the account.
   *
   * A deposit is a chain transaction followed by Lighter noticing it, so the
   * account does not exist the instant the transfer lands. Asking once would
   * fail on every real run.
   */
  async function credited(wallet: EvmAddress, deposit: Amount): Promise<LighterAccount> {
    let last: unknown
    for (let i = 0; i <= DEPOSIT_CHECKS; i += 1) {
      try {
        return await adapters.lighter.openAccount(wallet, deposit)
      } catch (caught) {
        last = caught
        if (i < DEPOSIT_CHECKS) await wait(DEPOSIT_CHECK_MS)
      }
    }
    throw last
  }

  async function load(id: SessionId): Promise<Session> {
    const session = await store.get(id)
    if (!session) throw new Error(`no such session: ${id}`)
    return session
  }

  return {
    /** Derive a key, read a rotated exit address, and open a session. */
    async create(notional: Amount): Promise<Session> {
      // The vault's counter lives in memory; the ledger is what survives a
      // reload. Taking the max of both stops a reload handing out index 0
      // again, which the checker would then block forever as reuse.
      const index = await nextKeyIndex(store, vault)
      const key = vault.deriveSessionKey(index)
      await adapters.noir.connect()
      const exitAddress: ShieldedAddress = await adapters.noir.freshReceiveAddress()

      const session: Session = {
        id: newId(),
        state: 'new',
        custody: 'user_shielded',
        createdAt: now(),
        updatedAt: now(),
        revision: 1,
        keyIndex: index,
        sessionWallet: key.address,
        notional,
        exitAddress,
        swapIn: null,
        swapOut: null,
        lighter: null,
        exitNotBefore: null,
        completed: {},
        failure: null,
      }
      await store.save(session)
      await store.recordUse(session.id, { keyIndex: index, sessionWallet: key.address })
      // Persist the counter too, so a reload before any ledger write still
      // moves forward.
      const record = await store.vault()
      if (record && record.highestIndex < index) {
        await store.saveVault({ ...record, highestIndex: index })
      }
      logger.info('session created', { id: session.id, keyIndex: index })
      return session
    },

    /** Quote the inbound leg, then ask the wallet to send the ZEC. */
    async fund(id: SessionId, refundTo: ShieldedAddress): Promise<Session> {
      let current = await load(id)

      // A user who was prompted hours ago and only now approves must not be
      // sent to a lapsed deposit address.
      const stale = current.swapIn !== null && now() > current.swapIn.deadline
      if (stale) logger.info('inbound quote lapsed, re-quoting')

      let leg = stale ? null : current.swapIn
      if (!leg) {
        const fresh = await adapters.near.quote({
          from: current.notional,
          toAsset: 'USDC',
          recipient: current.sessionWallet,
          refundTo,
          deadlineMs: SWAP_IN_DEADLINE_MS,
        })
        current = await apply(current, {
          type: 'quote_in_received',
          leg: fresh,
          effect: {
            key: effectKey(current, 'quote_in'),
            at: now(),
            handle: fresh.quoteId,
            confirmed: true,
          },
        })
        leg = current.swapIn
      }
      if (!leg) throw new Error('no inbound quote available')

      await gate(current, {
        kind: 'swap_in',
        amount: current.notional,
        recipient: leg.recipient,
        refundTo: leg.refundTo,
        deadline: leg.deadline,
      })

      const confirmedLeg = leg
      const sent = await once(
        current,
        'send_zec',
        async () => {
          const { txid } = await adapters.noir.send(
            confirmedLeg.depositAddress,
            current.notional,
          )
          return { handle: txid, value: txid }
        },
        // An attempt we never confirmed: ask the solver whether the deposit
        // arrived rather than sending the user's ZEC a second time.
        async () => {
          const fresh = await adapters.near.status(confirmedLeg)
          return fresh.status === 'quoted' ? null : { handle: fresh.quoteId, value: fresh.quoteId }
        },
      )
      return apply(sent.session, { type: 'zec_sent', at: now() })
    },

    /** Poll a leg once and feed the result in. Safe to call repeatedly. */
    async pollSwap(id: SessionId, which: 'in' | 'out'): Promise<Session> {
      const session = await load(id)
      const leg: SwapLeg | null = which === 'in' ? session.swapIn : session.swapOut
      if (!leg) return session
      const fresh = await adapters.near.status(leg)

      // Order matters: a refunded leg is also past its deadline, so testing
      // for expiry first would re-fire `swap_expired` forever and the
      // session would never leave `refunding`.
      if (fresh.status === 'refunded') {
        return apply(session, { type: 'refund_confirmed' })
      }
      if (fresh.status === 'settled' && fresh.settledAmount) {
        return apply(
          session,
          which === 'in'
            ? { type: 'swap_in_settled', received: fresh.settledAmount }
            : { type: 'swap_out_settled', received: fresh.settledAmount },
        )
      }
      if (fresh.status === 'expired' || now() > fresh.deadline) {
        return apply(session, { type: 'swap_expired', leg: which })
      }
      return session
    },

    /** Set up 7702 delegation and the paymaster permit. */
    async setupGas(id: SessionId): Promise<Session> {
      const session = await load(id)
      const done = await once(
        session,
        'setup_gas',
        async () => {
          const result = await adapters.gas.prepare(session.sessionWallet)
          return { handle: result.delegationTx ?? 'already-delegated', value: result }
        },
        // `prepare` is idempotent by contract: it reads the delegation back
        // and returns the existing setup. Asking again IS the reconcile.
        async () => {
          const result = await adapters.gas.prepare(session.sessionWallet)
          return { handle: result.delegationTx ?? 'already-delegated', value: result }
        },
      )
      return apply(done.session, { type: 'gas_ready' })
    },

    /** Deposit to Lighter and register an API key. */
    /**
     * Fund the Lighter account, then open it.
     *
     * A Lighter account is created by a deposit, not by an API call. Until
     * now this step only looked one up, so on a real run `openAccount` would
     * have thrown `AccountNotReadyError` for ever: the USDC sat in the
     * session wallet and nothing ever moved it.
     *
     * The deposit address is derived from the sender, so asking for it twice
     * is free and a retry cannot create a second place for the money to go.
     */
    async openLighter(id: SessionId, deposit: Amount): Promise<Session> {
      const session = await load(id)
      await gate(session, { kind: 'open_lighter', amount: deposit })

      const to = await adapters.lighter.depositAddress(session.sessionWallet, deposit)
      const funded = await once(
        session,
        'lighter_deposit',
        async () => {
          // USDC is an ERC-20: the call goes to the token contract.
          const data = encodeFunctionData({
            abi: ERC20_TRANSFER_ABI,
            functionName: 'transfer',
            args: [to as `0x${string}`, deposit.units],
          })
          const txHash = await adapters.gas.send(
            session.sessionWallet,
            USDC_ARBITRUM,
            data as Hex,
            0n,
          )
          return { handle: txHash, value: txHash }
        },
        // The account appearing is the proof the deposit landed. If it has,
        // the transfer need not be sent again.
        async () => {
          try {
            const found = await adapters.lighter.openAccount(session.sessionWallet, deposit)
            return { handle: `${found.accountIndex}`, value: 'already-deposited' }
          } catch {
            return null
          }
        },
      )

      const done = await once(
        funded.session,
        'open_lighter',
        async () => {
          const account = await credited(session.sessionWallet, deposit)
          return { handle: `${account.accountIndex}`, value: account }
        },
        // Opening looks the account up by its L1 address, so running it
        // again finds whatever the first attempt created.
        async () => {
          const account = await credited(session.sessionWallet, deposit)
          return { handle: `${account.accountIndex}`, value: account }
        },
      )
      const account = done.value ?? done.session.lighter
      if (!account) throw new Error('lighter account missing after open')
      return apply(done.session, { type: 'lighter_ready', account })
    },

    /** Flatten and request the withdrawal. Settlement is polled separately. */
    async endTrading(id: SessionId, expected: Amount): Promise<Session> {
      const session = await load(id)
      if (!session.lighter) throw new Error('no lighter account')
      const account = session.lighter
      await gate(session, { kind: 'withdraw', amount: expected })
      let current = await apply(session, { type: 'withdraw_requested' })

      const done = await once(current, 'withdraw', async () => {
        await adapters.lighter.closeAll(account)

        // Closing is asked for, not granted. Withdrawing the free collateral
        // while a position is still open would retire the key with the trade
        // still running, and the loss would land on an account nobody is
        // watching any more. So the withdrawal waits for flat, and gives up
        // loudly rather than proceeding on hope.
        const open = await settled(account)
        if (open.length > 0) {
          throw new PositionsStillOpenError(open.map((p) => `${p.market} ${p.size}`))
        }

        const { ref } = await adapters.lighter.withdraw(
          account,
          current.sessionWallet,
          expected,
        )
        return { handle: ref, value: ref }
      })
      return done.session
    },

    /**
     * Check whether the Lighter withdrawal has landed. Only once it has is
     * the exit delay armed, because the delay is measured from the money
     * actually being back on the session wallet.
     */
    async pollWithdrawal(id: SessionId, received: Amount): Promise<Session> {
      const session = await load(id)
      if (session.state !== 'withdrawing') return session
      if (session.exitNotBefore !== null) return session // already armed

      const ref = session.completed[effectKey(session, 'withdraw')]?.handle
      if (!ref) return session

      const status = await adapters.lighter.withdrawalStatus(ref)
      if (status === 'pending') return session
      if (status === 'failed') {
        // The slow path is ~27 minutes via Ethereum; funds are not lost.
        return apply(session, {
          type: 'failed',
          failure: {
            code: 'withdrawal_failed',
            message: 'Fast withdrawal failed; fall back to the secure withdrawal.',
            at: now(),
            retryable: true,
          },
        })
      }

      const delay =
        EXIT_DELAY_MIN_MS + Math.floor(random() * (EXIT_DELAY_MAX_MS - EXIT_DELAY_MIN_MS))
      return apply(session, {
        type: 'withdraw_settled',
        received,
        exitNotBefore: now() + delay,
      })
    },

    /** Quote and send the exit leg. Blocked until the delay has elapsed. */
    async exit(id: SessionId, value: Amount): Promise<Session> {
      let current = await load(id)
      const exitAddress = current.exitAddress
      if (!exitAddress) throw new Error('no rotated exit address')

      // Gate BEFORE quoting. The quote request itself reaches the solver, so
      // asking for it at withdrawal time would defeat the random delay the
      // check exists to enforce.
      await gate(current, {
        kind: 'swap_out',
        amount: value,
        recipient: exitAddress,
        refundTo: current.sessionWallet,
        deadline: now() + SWAP_OUT_DEADLINE_MS,
      })

      // The exit delay can outlast a quote's deadline, so a retry must never
      // reuse a lapsed one: that would send USDC to a dead deposit address.
      const stale = current.swapOut !== null && now() > current.swapOut.deadline
      if (stale) logger.info('outbound quote lapsed, re-quoting')

      let leg = stale ? null : current.swapOut
      if (!leg) {
        const fresh = await adapters.near.quote({
          from: value,
          toAsset: 'ZEC',
          recipient: exitAddress,
          refundTo: current.sessionWallet,
          deadlineMs: SWAP_OUT_DEADLINE_MS,
        })
        current = await apply(current, {
          type: 'quote_out_received',
          leg: fresh,
          effect: {
            key: effectKey(current, 'quote_out'),
            at: now(),
            handle: fresh.quoteId,
            confirmed: true,
          },
        })
        leg = current.swapOut
      }
      if (!leg) throw new Error('no outbound quote available')

      const confirmedLeg = leg
      const sent = await once(
        current,
        'send_usdc',
        async () => {
          // USDC is an ERC-20: the call goes to the token contract with a
          // transfer, not to the deposit address with a native value.
          const data = encodeFunctionData({
            abi: ERC20_TRANSFER_ABI,
            functionName: 'transfer',
            args: [confirmedLeg.depositAddress as `0x${string}`, value.units],
          })
          const txHash = await adapters.gas.send(
            current.sessionWallet,
            USDC_ARBITRUM,
            data as Hex,
            0n,
          )
          return { handle: txHash, value: txHash }
        },
        async () => {
          const fresh = await adapters.near.status(confirmedLeg)
          return fresh.status === 'quoted' ? null : { handle: fresh.quoteId, value: fresh.quoteId }
        },
      )
      current = await apply(sent.session, { type: 'usdc_sent' })
      await store.recordUse(current.id, { exitAddress })
      return current
    },

    /**
     * Reconcile every unfinished session against the outside world.
     * Called on load, before the UI offers any new action.
     */
    async resume(): Promise<readonly Session[]> {
      const open = await store.open()
      const out: Session[] = []
      for (const session of open) {
        logger.info('resuming session', { id: session.id, state: session.state })
        try {
          let current = session
          if (current.state === 'swap_in_pending') current = await this.pollSwap(current.id, 'in')
          if (current.state === 'swap_out_pending') current = await this.pollSwap(current.id, 'out')
          // A refund in flight still needs watching, or the session sits in
          // `refunding` with the user's money at the solver and no action
          // offered anywhere.
          if (current.state === 'refunding') {
            const leg = current.swapIn?.status === 'expired' ? 'in' : 'out'
            current = await this.pollSwap(current.id, leg)
          }
          if (current.state === 'withdrawing' && current.exitNotBefore === null) {
            const expected = current.swapIn?.settledAmount
            if (expected) current = await this.pollWithdrawal(current.id, expected)
          }
          out.push(current)
        } catch (error) {
          logger.error('resume failed', { id: session.id, error })
          out.push(session)
        }
      }
      return out
    },

    /** Mark a session failed; funds stay wherever custody says. */
    async fail(id: SessionId, code: string, message: string, retryable: boolean) {
      const session = await load(id)
      return apply(session, {
        type: 'failed',
        failure: { code, message, at: now(), retryable },
      })
    },
  }
}

export type Orchestrator = ReturnType<typeof createOrchestrator>

/** Convenience for the UI: the smallest deposit Lighter will take. */
export const LIGHTER_MIN_WITHDRAWAL = amount('USDC', 4_000_000n)
