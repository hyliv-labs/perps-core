import { describe, expect, it } from 'vitest'
import { emptyLedger, runChecker, type CheckerContext, type Movement } from '@/core/checker'
import { makeSession, T0, USDC, ZEC } from './helpers'
import type { ShieldedAddress } from '@/core/types'

const SHIELDED = `u1${'q'.repeat(40)}`

const ctx = (patch: Partial<CheckerContext> = {}): CheckerContext => ({
  session: makeSession(),
  ledger: emptyLedger,
  now: T0,
  networkPrivate: true,
  ...patch,
})

const swapIn = (patch: Partial<Extract<Movement, { kind: 'swap_in' }>> = {}): Movement => ({
  kind: 'swap_in',
  amount: ZEC('10'),
  recipient: `0x${'5e'.repeat(20)}`,
  refundTo: SHIELDED,
  deadline: Date.now() + 2 * 60 * 60_000,
  ...patch,
})

const swapOut = (patch: Partial<Extract<Movement, { kind: 'swap_out' }>> = {}): Movement => ({
  kind: 'swap_out',
  amount: USDC('455'),
  recipient: SHIELDED,
  refundTo: `0x${'5e'.repeat(20)}`,
  deadline: Date.now() + 60 * 60_000,
  ...patch,
})

describe('checker', () => {
  it('passes a clean inbound swap', () => {
    expect(runChecker(swapIn(), ctx()).pass).toBe(true)
  })

  it('blocks everything when the network is not private', () => {
    const report = runChecker(swapIn(), ctx({ networkPrivate: false }))
    expect(report.pass).toBe(false)
    expect(report.findings.map((f) => f.rule)).toContain('private_network')
  })

  it('blocks a refund to a transparent address', () => {
    const report = runChecker(swapIn({ refundTo: 't1transparentaddress' }), ctx())
    expect(report.pass).toBe(false)
    expect(report.findings.map((f) => f.rule)).toContain('shielded_refund')
  })

  it('blocks an exit before the random delay has elapsed', () => {
    const session = makeSession({
      state: 'withdrawing',
      custody: 'session_wallet',
      exitNotBefore: T0 + 600_000,
    })
    const report = runChecker(swapOut(), ctx({ session, now: T0 }))
    expect(report.pass).toBe(false)
    expect(report.findings.map((f) => f.rule)).toContain('exit_delay_elapsed')
  })

  it('allows the exit once the delay has passed', () => {
    const session = makeSession({
      state: 'withdrawing',
      custody: 'session_wallet',
      exitNotBefore: T0 + 600_000,
    })
    const report = runChecker(swapOut(), ctx({ session, now: T0 + 600_001 }))
    expect(report.pass).toBe(true)
  })

  it('blocks reuse of a shielded exit address', () => {
    const session = makeSession({
      state: 'withdrawing',
      custody: 'session_wallet',
      exitNotBefore: T0,
      exitAddress: SHIELDED as ShieldedAddress,
    })
    // Claimed by a different session, which is what makes it reuse.
    const ledger = {
      ...emptyLedger,
      usedExitAddresses: new Map([[SHIELDED, 'another-session']]),
    }
    const report = runChecker(swapOut(), ctx({ session, ledger, now: T0 }))
    expect(report.pass).toBe(false)
    expect(report.findings.map((f) => f.rule)).toContain('fresh_exit_address')
  })

  it('blocks a sweep from a wallet that no longer holds the funds', () => {
    const session = makeSession({
      state: 'withdrawing',
      custody: 'lighter',
      exitNotBefore: T0,
    })
    const report = runChecker(swapOut(), ctx({ session, now: T0 }))
    expect(report.findings.map((f) => f.rule)).toContain('no_dust_sweep')
  })

  it('warns, without blocking, when the exit amount equals the entry exactly', () => {
    const session = makeSession({
      state: 'withdrawing',
      custody: 'session_wallet',
      exitNotBefore: T0,
      swapIn: {
        quoteId: 'q1',
        depositAddress: 't1d',
        amountIn: ZEC('10'),
        amountOutMin: USDC('440'),
        deadline: T0,
        refundTo: SHIELDED,
        recipient: `0x${'5e'.repeat(20)}`,
        status: 'settled',
        settledAmount: USDC('455'),
      },
    })
    const report = runChecker(swapOut({ amount: USDC('455') }), ctx({ session, now: T0 }))
    expect(report.pass).toBe(true)
    const finding = report.findings.find((f) => f.rule === 'amount_fingerprint')
    expect(finding?.severity).toBe('warn')
  })
})
