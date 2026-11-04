/**
 * The checker.
 *
 * The doc commits to "prove privacy with a pass/fail checker instead of
 * claiming it", and gates every money movement on it. It does not enumerate
 * the rules, so the set below is derived from the privacy properties the doc
 * does claim — each rule cites the claim it enforces. Treat the list as the
 * place to add rules, not as settled.
 *
 * A `block` finding stops the movement. A `warn` finding is shown to the user
 * and can be overridden deliberately; it is still recorded.
 */

import type { Amount } from './types'
import { formatAmount } from './types'
import type { Session } from './session'

export type Severity = 'block' | 'warn'

export interface Finding {
  readonly rule: string
  readonly severity: Severity
  readonly message: string
  /** What the user can do about it. */
  readonly remedy: string
}

export interface CheckerReport {
  readonly pass: boolean
  readonly findings: readonly Finding[]
  readonly checkedAt: number
}

/** Every movement the checker gates. */
export type Movement =
  | { kind: 'swap_in'; amount: Amount; recipient: string; refundTo: string; deadline: number }
  | { kind: 'open_lighter'; amount: Amount }
  | { kind: 'withdraw'; amount: Amount }
  | { kind: 'swap_out'; amount: Amount; recipient: string; refundTo: string; deadline: number }

/**
 * Addresses and indices this device has already used, across all sessions,
 * each mapped to the session that claimed it. The owner matters: a session
 * registers its own wallet at creation, and must not then be blocked for
 * reusing itself.
 */
export interface LinkabilityLedger {
  readonly usedKeyIndices: ReadonlyMap<number, string>
  readonly usedExitAddresses: ReadonlyMap<string, string>
  readonly usedSessionWallets: ReadonlyMap<string, string>
}

/** True when `holder` is recorded against a session other than `sessionId`. */
function claimedByAnother<K>(
  ledger: ReadonlyMap<K, string>,
  holder: K,
  sessionId: string,
): boolean {
  const owner = ledger.get(holder)
  return owner !== undefined && owner !== sessionId
}

export interface CheckerContext {
  readonly session: Session
  readonly ledger: LinkabilityLedger
  readonly now: number
  /** True when every outbound request is going over Tor, Nym or anon-RPC. */
  readonly networkPrivate: boolean
}

export interface Rule {
  readonly id: string
  /** The claim in the architecture doc this rule enforces. */
  readonly enforces: string
  check(movement: Movement, ctx: CheckerContext): Finding | null
}

const MIN_DEADLINE_MS = 15 * 60_000
const MAX_DEADLINE_MS = 4 * 60 * 60_000

export const RULES: readonly Rule[] = [
  {
    id: 'fresh_session_key',
    enforces: 'Fresh session wallet per trading session, never reused.',
    check(_m, { session, ledger }) {
      const reused =
        claimedByAnother(ledger.usedSessionWallets, session.sessionWallet.toLowerCase(), session.id) ||
        claimedByAnother(ledger.usedKeyIndices, session.keyIndex, session.id)
      if (!reused) return null
      return {
        rule: 'fresh_session_key',
        severity: 'block',
        message: 'This session wallet has been used before.',
        remedy: 'Start a new session so a fresh key is derived.',
      }
    },
  },
  {
    id: 'fresh_exit_address',
    enforces: 'Exit goes to a fresh rotated shielded address.',
    check(movement, { session, ledger }) {
      if (movement.kind !== 'swap_out') return null
      if (!session.exitAddress) {
        return {
          rule: 'fresh_exit_address',
          severity: 'block',
          message: 'No rotated shielded address was read for the exit.',
          remedy: 'Reconnect the Noir Wallet so it can hand over a fresh receive address.',
        }
      }
      if (!claimedByAnother(ledger.usedExitAddresses, session.exitAddress, session.id)) {
        return null
      }
      return {
        rule: 'fresh_exit_address',
        severity: 'block',
        message: 'This shielded address has already received an exit.',
        remedy: 'Ask the wallet to rotate before withdrawing.',
      }
    },
  },
  {
    id: 'shielded_refund',
    enforces: "Refund on the inbound leg goes to the user's shielded address.",
    check(movement) {
      if (movement.kind !== 'swap_in') return null
      const shielded = /^(u1|zs1)/.test(movement.refundTo)
      if (shielded) return null
      return {
        rule: 'shielded_refund',
        severity: 'block',
        message: 'The inbound refund address is not a shielded Zcash address.',
        remedy: 'A refund to a transparent address would publish the amount and the link.',
      }
    },
  },
  {
    id: 'exit_delay_elapsed',
    enforces: 'The exit swap is requested only after a random delay.',
    check(movement, { session, now }) {
      if (movement.kind !== 'swap_out') return null
      if (session.exitNotBefore === null || now >= session.exitNotBefore) return null
      const left = Math.ceil((session.exitNotBefore - now) / 60_000)
      return {
        rule: 'exit_delay_elapsed',
        severity: 'block',
        message: `The exit delay has ${left} minute(s) left.`,
        remedy: 'Exiting immediately ties the exit to the entry by timing alone.',
      }
    },
  },
  {
    id: 'private_network',
    enforces: 'Anon-RPC for Arbitrum reads; Tor or Nym for NEAR and Lighter APIs.',
    check(_m, { networkPrivate }) {
      if (networkPrivate) return null
      return {
        rule: 'private_network',
        severity: 'block',
        message: 'Outbound requests are going out over the clear network.',
        remedy: 'Your IP would link the ZEC deposit to the Lighter account. Enable Tor or Nym.',
      }
    },
  },
  {
    id: 'deadline_sane',
    enforces: '~2-hour deadline for ZEC deposits.',
    check(movement, { now }) {
      if (movement.kind !== 'swap_in' && movement.kind !== 'swap_out') return null
      const window = movement.deadline - now
      if (window >= MIN_DEADLINE_MS && window <= MAX_DEADLINE_MS) return null
      return {
        rule: 'deadline_sane',
        severity: 'warn',
        message: `The quote's deadline window is ${Math.round(window / 60_000)} minutes.`,
        remedy: 'Too short risks a refund round trip; too long leaves funds with the solver.',
      }
    },
  },
  {
    id: 'amount_fingerprint',
    enforces: 'Entry and exit should not be matchable by value alone.',
    check(movement, { session }) {
      if (movement.kind !== 'swap_out') return null
      const inAmount = session.swapIn?.settledAmount
      if (!inAmount || inAmount.asset !== movement.amount.asset) return null
      if (inAmount.units !== movement.amount.units) return null
      return {
        rule: 'amount_fingerprint',
        severity: 'warn',
        message: `The exit amount equals the entry amount exactly (${formatAmount(movement.amount)}).`,
        remedy: 'An observer can pair the two legs by value. Vary the amount or split the exit.',
      }
    },
  },
  {
    id: 'no_dust_sweep',
    enforces: 'Dust is never swept from a retired session wallet.',
    check(movement, { session }) {
      if (movement.kind !== 'swap_out') return null
      if (session.state !== 'withdrawing') return null
      if (session.custody === 'session_wallet') return null
      return {
        rule: 'no_dust_sweep',
        severity: 'block',
        message: 'Funds are not in the session wallet; this looks like a sweep.',
        remedy: 'Sweeping a retired wallet links that session to this one.',
      }
    },
  },
]

export function runChecker(movement: Movement, ctx: CheckerContext): CheckerReport {
  const findings = RULES.map((rule) => rule.check(movement, ctx)).filter(
    (f): f is Finding => f !== null,
  )
  return {
    pass: !findings.some((f) => f.severity === 'block'),
    findings,
    checkedAt: ctx.now,
  }
}

export const emptyLedger: LinkabilityLedger = {
  usedKeyIndices: new Map(),
  usedExitAddresses: new Map(),
  usedSessionWallets: new Map(),
}
