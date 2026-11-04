/**
 * Session types.
 *
 * A session is the unit of unlinkability: one session key, one Lighter
 * account, one round trip from shielded ZEC and back. It is persisted after
 * every transition, because a reload in the middle of "swap-in pending"
 * leaves real money in flight against a deadline we did not set.
 *
 * States and failure paths follow the architecture doc's session table.
 */

import type { Amount, EvmAddress, IdempotencyKey, SessionId, ShieldedAddress } from './types'

export type { SessionId } from './types'

export type SessionState =
  /** Approved by the checker; a session key exists; nothing has moved. */
  | 'new'
  /** ZEC sent to the NEAR deposit address; waiting on the solver. */
  | 'swap_in_pending'
  /** USDC is in the session wallet. */
  | 'funded'
  /** 7702 delegation and paymaster permit are set; gas is payable in USDC. */
  | 'converted'
  /** Lighter account live; the user can trade. */
  | 'trading'
  /** Positions flat; a withdrawal from Lighter is in flight. */
  | 'withdrawing'
  /** USDC sent back to NEAR after the delay; waiting on ZEC. */
  | 'swap_out_pending'
  /** ZEC received at a fresh rotated address. Session key retired. */
  | 'closed'
  /** A swap deadline lapsed; funds return to the refund address. */
  | 'refunding'
  /** Terminal, unhappy. Funds are wherever `custody` says they are. */
  | 'failed'

export const TERMINAL_STATES: readonly SessionState[] = ['closed', 'failed']

/** Where the money physically sits. Survives a crash; drives recovery. */
export type Custody =
  | 'user_shielded'     // in the user's Noir Wallet
  | 'near_solver'       // in flight through 1Click
  | 'session_wallet'    // USDC on Arbitrum under the session key
  | 'lighter'           // deposited on the venue
  | 'unknown'           // reconcile before doing anything else

export interface SwapLeg {
  readonly quoteId: string
  readonly depositAddress: string
  readonly amountIn: Amount
  readonly amountOutMin: Amount
  /** Unix ms. After this, 1Click refunds to `refundTo`. */
  readonly deadline: number
  readonly refundTo: string
  readonly recipient: string
  readonly status: 'quoted' | 'deposited' | 'settled' | 'refunded' | 'expired'
  readonly settledAmount?: Amount
}

export interface LighterAccount {
  readonly accountIndex: number
  readonly apiKeyIndex: number
  /** Public key only. The secret lives in the key manager, never here. */
  readonly apiPublicKey: string
}

export interface Session {
  readonly id: SessionId
  readonly state: SessionState
  readonly custody: Custody
  readonly createdAt: number
  readonly updatedAt: number
  /** Monotonic; every persisted mutation bumps it. Guards lost updates. */
  readonly revision: number

  /** Derivation index of this session's EVM key. Never reused. */
  readonly keyIndex: number
  readonly sessionWallet: EvmAddress

  /** What the user asked to put in. */
  readonly notional: Amount
  /** Fresh rotated shielded address for the exit. Read at session start. */
  readonly exitAddress: ShieldedAddress | null

  readonly swapIn: SwapLeg | null
  readonly swapOut: SwapLeg | null
  readonly lighter: LighterAccount | null

  /** Unix ms before which the exit swap must not be requested. */
  readonly exitNotBefore: number | null

  /** Side effects already performed, by idempotency key. */
  readonly completed: Readonly<Record<string, CompletedEffect>>

  readonly failure: SessionFailure | null
}

/**
 * One externally visible side effect.
 *
 * An entry is written with `confirmed: false` BEFORE the effect runs, so a
 * crash mid-flight is visible on resume as "attempted, unconfirmed" rather
 * than disappearing. An unconfirmed entry is never grounds to blindly retry:
 * the orchestrator reconciles it against the outside world first.
 */
export interface CompletedEffect {
  readonly key: IdempotencyKey
  readonly at: number
  /** What the adapter returned: a tx hash, a quote id, an order id. */
  readonly handle: string | null
  readonly confirmed: boolean
}

export interface SessionFailure {
  readonly code: string
  readonly message: string
  readonly at: number
  /** True when the user can retry the same step safely. */
  readonly retryable: boolean
}

export type SessionEvent =
  | { type: 'quote_in_received'; leg: SwapLeg; effect?: CompletedEffect }
  | { type: 'zec_sent'; at: number }
  | { type: 'swap_in_settled'; received: Amount }
  | { type: 'swap_expired'; leg: 'in' | 'out' }
  | { type: 'refund_confirmed' }
  | { type: 'gas_ready' }
  | { type: 'lighter_ready'; account: LighterAccount }
  | { type: 'withdraw_requested' }
  | { type: 'withdraw_settled'; received: Amount; exitNotBefore: number }
  | { type: 'quote_out_received'; leg: SwapLeg; effect?: CompletedEffect }
  | { type: 'usdc_sent' }
  | { type: 'swap_out_settled'; received: Amount }
  | { type: 'failed'; failure: SessionFailure }
  | { type: 'effect_completed'; effect: CompletedEffect }

/** Commands the orchestrator should carry out after a transition. */
export type Command =
  | { type: 'poll_swap'; leg: 'in' | 'out' }
  | { type: 'setup_gas' }
  | { type: 'open_lighter' }
  | { type: 'request_exit_quote' }
  | { type: 'retire_key'; keyIndex: number }
  | { type: 'await_refund' }
