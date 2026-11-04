import { beforeEach, describe, expect, it } from 'vitest'
import {
  CheckerBlockedError,
  PositionsStillOpenError,
  UnreconciledEffectError,
  createOrchestrator,
  USDC_ARBITRUM,
} from '@/orchestrator/orchestrator'
import { createMockAdapters } from '@/adapters/mock'
import { createMemoryStore, createSessionStore, openDatabase, type SessionStore } from '@/core/store'
import {
  generateRecoveryPhrase,
  newVaultRecord,
  openWithPassphrase,
  passphraseLock,
  type Vault,
  type VaultRecord,
} from '@/core/keys'
import { testLogger, T0, USDC, ZEC } from './helpers'
import type { ShieldedAddress } from '@/core/types'

const REFUND = `u1${'r'.repeat(40)}` as ShieldedAddress

let databaseCount = 0

/**
 * The same suite runs against both stores. The in-memory one is fast; the
 * IndexedDB one is what actually ships, and is the only thing that exercises
 * the ledger's Map/array serialization.
 */
const STORES: readonly [string, () => Promise<SessionStore>][] = [
  ['memory', async () => createMemoryStore()],
  [
    'indexeddb',
    async () => {
      // A uniquely named database per test: deleting a shared one blocks on
      // the previous test's open connection and hangs the suite.
      databaseCount += 1
      return createSessionStore(await openDatabase(`coldtrail-test-${databaseCount}`))
    },
  ],
]

describe.each(STORES)('orchestrator (%s store)', (_name, makeStore) => {
  let store: SessionStore
  let vault: Vault
  let record: VaultRecord

  beforeEach(async () => {
    store = await makeStore()
    record = newVaultRecord([await passphraseLock(generateRecoveryPhrase(), 'pass')])
    await store.saveVault(record)
    vault = await openWithPassphrase(record, 'pass')
  })

  function build(adapters = createMockAdapters({ now: () => T0 }), withStore = store) {
    let clock = T0
    const orchestrator = createOrchestrator({
      // The close-out poll waits between looks; a test should not.
      wait: async () => {},
      adapters,
      store: withStore,
      vault,
      logger: testLogger,
      now: () => clock,
      random: () => 0, // shortest legal exit delay, deterministically
    })
    return { orchestrator, adapters, advance: (ms: number) => (clock += ms) }
  }

  /** Drive a session up to `trading`. */
  async function toTrading(ctx: ReturnType<typeof build>) {
    let session = await ctx.orchestrator.create(ZEC('10'))
    session = await ctx.orchestrator.fund(session.id, REFUND)
    ctx.adapters.settleSwaps()
    session = await ctx.orchestrator.pollSwap(session.id, 'in')
    session = await ctx.orchestrator.setupGas(session.id)
    return ctx.orchestrator.openLighter(session.id, USDC('440'))
  }

  it('drives a session from new to trading', async () => {
    const ctx = build()
    const session = await toTrading(ctx)
    expect(session.state).toBe('trading')
    expect(session.lighter?.accountIndex).toBe(1001)
  })

  it('sends the USDC to Lighter before trying to open the account', async () => {
    // A Lighter account is created by a deposit, not by an API call. This
    // step used to only look one up, so on a real run the USDC sat in the
    // session wallet and `openAccount` failed for ever.
    const ctx = build()
    await toTrading(ctx)

    const deposit = ctx.adapters.calls.gasSends.find(
      (call) => call.to === USDC_ARBITRUM && call.data.length > 10,
    )
    expect(deposit).toBeDefined()
    // An ERC-20 transfer to the token contract, not native value anywhere.
    expect(deposit?.data.startsWith('0xa9059cbb')).toBe(true)
    expect(deposit?.value).toBe(0n)
  })

  it('waits for the bridge to credit before opening the account', async () => {
    // The deposit is a chain transaction and then Lighter noticing it, so
    // the account does not exist the instant the transfer lands.
    const adapters = createMockAdapters({ now: () => T0 })
    let looks = 0
    const ctx = build({
      ...adapters,
      lighter: {
        ...adapters.lighter,
        async openAccount(from, value) {
          looks += 1
          if (looks < 3) throw new Error('account not ready')
          return adapters.lighter.openAccount(from, value)
        },
      },
    })
    const session = await toTrading(ctx)
    expect(session.state).toBe('trading')
    expect(looks).toBeGreaterThanOrEqual(3)
  })

  it('does not send the deposit twice when the account already exists', async () => {
    // The reconcile path: an unconfirmed deposit plus an account that is
    // already there means the money landed, so sending again would double it.
    const adapters = createMockAdapters({ now: () => T0 })
    const ctx = build(adapters)
    const session = await toTrading(ctx)
    const before = ctx.adapters.calls.gasSends.length

    await ctx.orchestrator.openLighter(session.id, USDC('455'))
    expect(ctx.adapters.calls.gasSends.length).toBe(before)
  })

  it('refuses to withdraw while Lighter still reports a position', async () => {
    // Cancelling orders is not closing a position. Withdrawing the free
    // collateral here would retire the key with the trade still running.
    const adapters = createMockAdapters({ now: () => T0 })
    const stuck = {
      ...adapters,
      lighter: {
        ...adapters.lighter,
        async closeAll() {},
        async positions() {
          return [
            { market: 'ZEC', size: '1.5', entryPrice: '1240', unrealizedPnl: '0' },
          ]
        },
      },
    }
    const ctx = build(stuck)
    const session = await toTrading(ctx)

    const refused = await ctx.orchestrator
      .endTrading(session.id, USDC('455'))
      .then(() => null)
      .catch((caught: unknown) => caught)
    expect(refused).toBeInstanceOf(PositionsStillOpenError)
    expect((refused as Error).message).toMatch(/still running/)
    expect((refused as Error).message).toMatch(/ZEC 1.5/)
  })

  it('will not blindly re-send a withdrawal it cannot ask about', async () => {
    // The first attempt journalled itself and then failed. There is no way
    // to ask Lighter whether that withdrawal landed, so a retry must refuse
    // rather than either double-sending or reporting a success that did not
    // happen — which is how a session exits with nothing.
    const adapters = createMockAdapters({ now: () => T0 })
    let flat = false
    const ctx = build({
      ...adapters,
      lighter: {
        ...adapters.lighter,
        async positions() {
          return flat ? [] : [{ market: 'ZEC', size: '2', entryPrice: '1240', unrealizedPnl: '0' }]
        },
      },
    })
    const session = await toTrading(ctx)
    await expect(ctx.orchestrator.endTrading(session.id, USDC('455'))).rejects.toThrow(
      PositionsStillOpenError,
    )

    flat = true
    await expect(ctx.orchestrator.endTrading(session.id, USDC('455'))).rejects.toThrow(
      UnreconciledEffectError,
    )
  })

  it('withdraws once the close-out has actually flattened', async () => {
    // A position that reads zero is flat, not open: it must not block.
    const adapters = createMockAdapters({ now: () => T0 })
    const flat = {
      ...adapters,
      lighter: {
        ...adapters.lighter,
        async positions() {
          return [{ market: 'ZEC', size: '0', entryPrice: '0', unrealizedPnl: '0' }]
        },
      },
    }
    const ctx = build(flat)
    const session = await toTrading(ctx)
    const done = await ctx.orchestrator.endTrading(session.id, USDC('455'))
    expect(done.state).toBe('withdrawing')
  })

  it('completes the round trip back to shielded ZEC', async () => {
    const ctx = build()
    let session = await toTrading(ctx)

    session = await ctx.orchestrator.endTrading(session.id, USDC('455'))
    expect(session.state).toBe('withdrawing')
    // The delay is armed only once the withdrawal has actually landed.
    expect(session.exitNotBefore).toBeNull()

    session = await ctx.orchestrator.pollWithdrawal(session.id, USDC('455'))
    expect(session.exitNotBefore).toBeGreaterThan(T0)

    await expect(ctx.orchestrator.exit(session.id, USDC('455'))).rejects.toThrow(
      CheckerBlockedError,
    )

    ctx.advance(11 * 60_000)
    session = await ctx.orchestrator.exit(session.id, USDC('455'))
    expect(session.state).toBe('swap_out_pending')

    ctx.adapters.settleSwaps()
    session = await ctx.orchestrator.pollSwap(session.id, 'out')
    expect(session.state).toBe('closed')
    expect(session.custody).toBe('user_shielded')
  })

  describe('idempotency', () => {
    it('never sends the ZEC twice when fund is called again', async () => {
      const ctx = build()
      let session = await ctx.orchestrator.create(ZEC('10'))
      session = await ctx.orchestrator.fund(session.id, REFUND)
      await ctx.orchestrator.fund(session.id, REFUND)
      expect(ctx.adapters.calls.noirSends).toHaveLength(1)
    })

    it('does not resend when the confirming write was lost mid-flight', async () => {
      const adapters = createMockAdapters({ now: () => T0 })
      // The save that would confirm `send_zec` fails: the attempt marker is
      // already stored, the ZEC is already gone.
      let failNextSave = false
      const realSave = store.save.bind(store)
      store.save = async (session) => {
        if (failNextSave && session.completed[`${session.id}:send_zec`]?.confirmed) {
          failNextSave = false
          throw new Error('storage died')
        }
        return realSave(session)
      }
      const ctx = build(adapters)
      const session = await ctx.orchestrator.create(ZEC('10'))
      failNextSave = true
      await expect(ctx.orchestrator.fund(session.id, REFUND)).rejects.toThrow('storage died')
      expect(adapters.calls.noirSends).toHaveLength(1)

      // The retry must reconcile against the solver, not send again.
      await ctx.orchestrator.fund(session.id, REFUND).catch(() => undefined)
      expect(adapters.calls.noirSends).toHaveLength(1)
    })
  })

  describe('recovery', () => {
    it('resumes a session that crashed mid-swap and settles it', async () => {
      const adapters = createMockAdapters({ now: () => T0 })
      const first = build(adapters)
      const created = await first.orchestrator.create(ZEC('10'))
      const session = await first.orchestrator.fund(created.id, REFUND)
      expect(session.state).toBe('swap_in_pending')

      adapters.settleSwaps()
      const second = build(adapters)
      const resumed = await second.orchestrator.resume()
      expect(resumed[0]!.state).toBe('funded')
      expect((await store.get(session.id))!.state).toBe('funded')
    })

    it('carries an inbound refund all the way to closed', async () => {
      const adapters = createMockAdapters({ now: () => T0, expireSwapIn: true })
      const ctx = build(adapters)
      let session = await ctx.orchestrator.create(ZEC('10'))
      session = await ctx.orchestrator.fund(session.id, REFUND)

      adapters.settleSwaps() // deposited -> expired
      session = await ctx.orchestrator.pollSwap(session.id, 'in')
      expect(session.state).toBe('refunding')

      // The refund lands. Without resume covering `refunding`, this sticks.
      adapters.refundSwaps()
      session = await ctx.orchestrator.pollSwap(session.id, 'in')
      expect(session.state).toBe('closed')
      expect(session.custody).toBe('user_shielded')
    })

    it('does not loop in refunding when the deadline has passed', async () => {
      const adapters = createMockAdapters({ now: () => T0, expireSwapIn: true })
      const ctx = build(adapters)
      let session = await ctx.orchestrator.create(ZEC('10'))
      session = await ctx.orchestrator.fund(session.id, REFUND)
      adapters.settleSwaps()
      session = await ctx.orchestrator.pollSwap(session.id, 'in')

      ctx.advance(3 * 60 * 60_000) // well past the deadline
      const before = session.revision
      session = await ctx.orchestrator.pollSwap(session.id, 'in')
      expect(session.state).toBe('refunding')
      expect(session.revision).toBe(before)
    })

    it('fails the session when the fast withdrawal does not land', async () => {
      const ctx = build(createMockAdapters({ now: () => T0, withdrawalStatus: 'failed' }))
      let session = await toTrading(ctx)
      session = await ctx.orchestrator.endTrading(session.id, USDC('455'))
      session = await ctx.orchestrator.pollWithdrawal(session.id, USDC('455'))
      expect(session.state).toBe('failed')
      expect(session.failure?.retryable).toBe(true)
    })
  })

  describe('keys', () => {
    it('hands out a new index after a reload, and the session still funds', async () => {
      const first = build()
      const one = await first.orchestrator.create(ZEC('10'))
      expect(one.keyIndex).toBe(0)

      // Reload: a fresh vault from the same record, memory counter at zero.
      vault = await openWithPassphrase((await store.vault())!, 'pass')
      const second = build()
      const two = await second.orchestrator.create(ZEC('10'))
      expect(two.keyIndex).toBe(1)
      expect(two.sessionWallet).not.toBe(one.sessionWallet)

      // The checker must not see the new session's own wallet as reuse.
      const funded = await second.orchestrator.fund(two.id, REFUND)
      expect(funded.state).toBe('swap_in_pending')
    })

    it('persists the highest index to the vault record', async () => {
      const ctx = build()
      await ctx.orchestrator.create(ZEC('10'))
      expect((await store.vault())!.highestIndex).toBe(0)
    })
  })

  describe('the exit', () => {
    it('sends USDC as an ERC-20 transfer, not as native value', async () => {
      const ctx = build()
      let session = await toTrading(ctx)
      session = await ctx.orchestrator.endTrading(session.id, USDC('455'))
      session = await ctx.orchestrator.pollWithdrawal(session.id, USDC('455'))
      ctx.advance(11 * 60_000)
      await ctx.orchestrator.exit(session.id, USDC('455'))

      const call = ctx.adapters.calls.gasSends.at(-1)!
      expect(call.to).toBe(USDC_ARBITRUM)
      expect(call.value).toBe(0n)
      expect(call.data.startsWith('0xa9059cbb')).toBe(true) // transfer(address,uint256)
    })

    it('does not ask for a quote before the delay has elapsed', async () => {
      const ctx = build()
      let session = await toTrading(ctx)
      session = await ctx.orchestrator.endTrading(session.id, USDC('455'))
      session = await ctx.orchestrator.pollWithdrawal(session.id, USDC('455'))

      await expect(ctx.orchestrator.exit(session.id, USDC('455'))).rejects.toThrow(
        CheckerBlockedError,
      )
      // Reaching the solver at withdrawal time would defeat the delay.
      expect((await store.get(session.id))!.swapOut).toBeNull()
    })

    it('re-quotes when the stored quote lapsed during the delay', async () => {
      const ctx = build()
      let session = await toTrading(ctx)
      session = await ctx.orchestrator.endTrading(session.id, USDC('455'))
      session = await ctx.orchestrator.pollWithdrawal(session.id, USDC('455'))
      ctx.advance(11 * 60_000)
      session = await ctx.orchestrator.exit(session.id, USDC('455'))
      const firstQuote = session.swapOut!.quoteId

      // The outbound leg lapses and refunds; the retry must not reuse it.
      ctx.advance(2 * 60 * 60_000)
      session = await ctx.orchestrator.pollSwap(session.id, 'out')
      expect(session.state).toBe('refunding')
      ctx.adapters.refundSwaps()
      session = await ctx.orchestrator.pollSwap(session.id, 'out')
      expect(session.state).toBe('withdrawing')

      session = await ctx.orchestrator.exit(session.id, USDC('455'))
      expect(session.swapOut!.quoteId).not.toBe(firstQuote)
    })
  })

  describe('the checker', () => {
    it('blocks every movement when the network is not private', async () => {
      const adapters = createMockAdapters({ now: () => T0 })
      Object.defineProperty(adapters.network, 'isPrivate', { value: false })
      const ctx = build(adapters)
      const session = await ctx.orchestrator.create(ZEC('10'))
      await expect(ctx.orchestrator.fund(session.id, REFUND)).rejects.toThrow(
        CheckerBlockedError,
      )
    })

    it('records each session wallet against its own session', async () => {
      const ctx = build()
      const session = await ctx.orchestrator.create(ZEC('10'))
      const ledger = await store.ledger()
      expect(ledger.usedSessionWallets.get(session.sessionWallet.toLowerCase())).toBe(session.id)
      expect(ledger.usedKeyIndices.get(session.keyIndex)).toBe(session.id)
    })
  })

  it('rejects a stale write from a second tab', async () => {
    const ctx = build()
    const session = await ctx.orchestrator.create(ZEC('10'))
    await expect(store.save({ ...session, revision: session.revision })).rejects.toThrow(
      /revision/,
    )
  })
})
