import { describe, expect, it } from 'vitest'
import { canTransition, reduce, reduceAll } from '@/core/machine'
import type { SessionEvent, SwapLeg } from '@/core/session'
import { makeSession, T0, USDC, ZEC } from './helpers'

const leg = (patch: Partial<SwapLeg> = {}): SwapLeg => ({
  quoteId: 'q1',
  depositAddress: 't1deposit',
  amountIn: ZEC('10'),
  amountOutMin: USDC('440'),
  deadline: T0 + 2 * 60 * 60_000,
  refundTo: `u1${'q'.repeat(40)}`,
  recipient: `0x${'5e'.repeat(20)}`,
  status: 'quoted',
  ...patch,
})

const happyPath: SessionEvent[] = [
  { type: 'quote_in_received', leg: leg() },
  { type: 'zec_sent', at: T0 },
  { type: 'swap_in_settled', received: USDC('448') },
  { type: 'gas_ready' },
  { type: 'lighter_ready', account: { accountIndex: 1, apiKeyIndex: 0, apiPublicKey: '0xab' } },
  { type: 'withdraw_requested' },
  { type: 'withdraw_settled', received: USDC('455'), exitNotBefore: T0 + 600_000 },
  { type: 'quote_out_received', leg: leg({ quoteId: 'q2', amountIn: USDC('455') }) },
  { type: 'usdc_sent' },
  { type: 'swap_out_settled', received: ZEC('10.02') },
]

describe('session machine', () => {
  it('runs the full round trip to closed', () => {
    const { session, commands } = reduceAll(makeSession(), happyPath, T0)
    expect(session.state).toBe('closed')
    expect(session.custody).toBe('user_shielded')
    expect(commands.at(-1)).toEqual({ type: 'retire_key', keyIndex: 0 })
  })

  it('is pure: the input session is never mutated', () => {
    const before = makeSession()
    const snapshot = structuredClone(before)
    reduce(before, { type: 'quote_in_received', leg: leg() }, T0)
    expect(before).toEqual(snapshot)
  })

  it('ignores events that do not apply to the current state', () => {
    const session = makeSession()
    // No quote yet, so nothing can have been sent.
    const { session: next } = reduce(session, { type: 'zec_sent', at: T0 }, T0)
    expect(next).toBe(session)
    expect(next.state).toBe('new')
  })

  it('ignores a duplicate settle from a poller that ran twice', () => {
    const { session } = reduceAll(makeSession(), happyPath.slice(0, 3), T0)
    expect(session.state).toBe('funded')
    const { session: again } = reduce(session, { type: 'swap_in_settled', received: USDC('448') }, T0)
    expect(again).toBe(session)
    expect(again.revision).toBe(session.revision)
  })

  it('bumps the revision on every accepted transition', () => {
    const start = makeSession()
    const { session } = reduceAll(start, happyPath.slice(0, 3), T0)
    expect(session.revision).toBeGreaterThan(start.revision)
  })

  it('records an effect once and ignores the repeat', () => {
    const effect = { key: 'session-1:send_zec' as never, at: T0, handle: 'tx1', confirmed: true }
    const first = reduce(makeSession(), { type: 'effect_completed', effect }, T0).session
    expect(Object.keys(first.completed)).toHaveLength(1)
    const second = reduce(first, { type: 'effect_completed', effect }, T0).session
    expect(second).toBe(first)
  })

  describe('failure paths', () => {
    it('refunds an expired inbound leg to the user and closes', () => {
      const { session } = reduceAll(makeSession(), happyPath.slice(0, 2), T0)
      expect(session.state).toBe('swap_in_pending')
      const expired = reduce(session, { type: 'swap_expired', leg: 'in' }, T0).session
      expect(expired.state).toBe('refunding')
      const closed = reduce(expired, { type: 'refund_confirmed' }, T0)
      expect(closed.session.state).toBe('closed')
      expect(closed.session.custody).toBe('user_shielded')
    })

    it('retries the exit when the outbound leg refunds to the session wallet', () => {
      const { session } = reduceAll(makeSession(), happyPath.slice(0, 9), T0)
      expect(session.state).toBe('swap_out_pending')
      const expired = reduce(session, { type: 'swap_expired', leg: 'out' }, T0).session
      const retried = reduce(expired, { type: 'refund_confirmed' }, T0)
      // Funds must not be stranded with the solver or declared gone.
      expect(retried.session.state).toBe('withdrawing')
      expect(retried.session.custody).toBe('session_wallet')
      expect(retried.commands).toContainEqual({ type: 'request_exit_quote' })
    })

    it('accepts nothing once terminal', () => {
      const { session } = reduceAll(makeSession(), happyPath, T0)
      const after = reduce(session, { type: 'gas_ready' }, T0)
      expect(after.session).toBe(session)
    })
  })

  describe('transition table', () => {
    it('forbids skipping the swap', () => {
      expect(canTransition('new', 'trading')).toBe(false)
      expect(canTransition('new', 'swap_in_pending')).toBe(true)
    })

    it('lets any state fail', () => {
      for (const state of ['new', 'swap_in_pending', 'funded', 'trading'] as const) {
        expect(canTransition(state, 'failed')).toBe(true)
      }
    })
  })
})
