/**
 * Adapter interfaces.
 *
 * Every external system sits behind one of these. Two rules keep them
 * honest:
 *   1. Each has a mock implementation, so the whole session can run locally
 *      without spending ZEC or USDC. 1Click has no testnet worth the name.
 *   2. No adapter ever receives or returns a private key. Signing is handed
 *      a payload and gives back a signature.
 *
 * Interfaces marked UNVERIFIED carry a shape derived from vendor docs that
 * has not yet been exercised against the live API. The spikes in /spikes
 * exist to settle them; expect these to change once they run.
 */

import type { Amount, EvmAddress, Hex, ShieldedAddress } from '@/core/types'
import type { LighterAccount, SwapLeg } from '@/core/session'

/* ------------------------------------------------------------------ NEAR */

export interface QuoteRequest {
  readonly from: Amount
  readonly toAsset: 'USDC' | 'ZEC'
  /** Where the output goes: the session wallet, or a shielded address. */
  readonly recipient: string
  /** Where the input returns if the deadline lapses. */
  readonly refundTo: string
  readonly deadlineMs: number
}

/**
 * VERIFIED against the live API on 2026-10-26 (spikes/01-1click-quote.ts):
 * the request and response shapes, the required type enums, the asset ids
 * and the 201 on a created quote. See src/adapters/near1click/http.ts.
 *
 * Still open: the solver spread and the per-asset minimum on the Zcash legs,
 * which cannot be quoted without a real Zcash address.
 */
export interface NearIntentsAdapter {
  /** Ask for a quote. Does not move anything. */
  quote(request: QuoteRequest): Promise<SwapLeg>
  /** Current status of a quote, by its deposit address. */
  status(leg: SwapLeg): Promise<SwapLeg>
  /** Minimum the solver will accept for this pair. */
  minimum(asset: Amount['asset'], toAsset: 'USDC' | 'ZEC'): Promise<Amount>
}

/* ------------------------------------------------------------------ Noir */

/** UNVERIFIED: whether a dApp can send to an external transparent address. */
export interface NoirWalletAdapter {
  isAvailable(): Promise<boolean>
  connect(): Promise<void>
  /** A freshly rotated shielded receive address for this session's exit. */
  freshReceiveAddress(): Promise<ShieldedAddress>
  /**
   * Ask the wallet to send shielded ZEC to the 1Click deposit address.
   * Resolves when the user approves; the wallet broadcasts.
   */
  send(to: string, value: Amount, memo?: string): Promise<{ txid: string }>
  /**
   * The address of an already-connected wallet, without prompting.
   *
   * Null when nothing is connected. Optional, because the manual path has
   * no connection to restore.
   */
  connectedAddress?(): Promise<ShieldedAddress | null>
  /**
   * The wallet's own transaction history, exactly as it hands it over.
   *
   * Deliberately `unknown`: no published source says what shape this has,
   * so a type here would be a guess wearing a type's authority. Read it
   * with `statusOf` from `./noir/history`, which works structurally.
   *
   * Optional, because the manual path has no wallet to ask.
   */
  history?(): Promise<unknown>
  /** Spendable shielded balance, for the amount picker. */
  balance(): Promise<Amount>
}

/* --------------------------------------------------------------- Lighter */

export interface OrderRequest {
  readonly market: string
  readonly side: 'buy' | 'sell'
  readonly size: string
  readonly type: 'limit' | 'market'
  /**
   * Always required, and always signed.
   *
   * For a limit order it is the limit. For a market order it is the worst
   * price the immediate-or-cancel sweep may reach — Lighter's signer refuses
   * a price of zero, so there is no such thing as a priceless order here.
   */
  readonly price: string
  readonly reduceOnly: boolean
}

export interface Position {
  readonly market: string
  /** Signed: negative is short. Lighter stores the sign separately; this does not. */
  readonly size: string
  readonly entryPrice: string
  readonly unrealizedPnl: string
  /** Lighter's own figure, when it quotes one. Absent for a cross position. */
  readonly liquidationPrice?: string
}

/**
 * Reads are VERIFIED against the live API on 2026-10-26: 246 markets, every
 * one 0.0000/0.0000 taker and maker, ETH at market_id 0.
 *
 * Writes go through Lighter's official WebAssembly signer, which is fetched
 * and hash-verified by `pnpm fetch:signer`. Each one reads a fresh nonce,
 * signs, and submits to POST /api/v1/sendTx. Without a signer configured
 * they refuse and say why rather than pretending.
 *
 * None of them has signed a live transaction yet; that needs a funded
 * account. See src/adapters/lighter/http.ts.
 */
export interface LighterAdapter {
  /**
   * Where this wallet should send USDC to fund a Lighter account.
   *
   * Lighter accounts are created by a deposit, not by an API call, so this
   * has to happen before `openAccount` can find anything.
   */
  depositAddress(from: EvmAddress, value: Amount): Promise<EvmAddress>
  /** Find the account the deposit created, and register this session's key. */
  openAccount(from: EvmAddress, deposit: Amount): Promise<LighterAccount>
  placeOrder(account: LighterAccount, order: OrderRequest): Promise<{ orderId: string }>
  /**
   * Leverage is an account setting per market with its own transaction type,
   * so it must land BEFORE the order it is meant to apply to. It is on this
   * interface rather than on the HTTP adapter alone so that a leverage
   * control cannot be drawn against something that never sends it.
   */
  setLeverage(
    account: LighterAccount,
    market: string,
    initialMarginFraction: number,
    marginMode?: 'cross' | 'isolated',
  ): Promise<{ txHash: string }>
  positions(account: LighterAccount): Promise<readonly Position[]>
  /**
   * Cancel every resting order AND flatten every open position.
   *
   * Cancelling alone is not closing: an account with no orders and an open
   * perp is still exposed, and the session would withdraw its free collateral
   * and retire the key with the trade still running.
   */
  closeAll(account: LighterAccount): Promise<void>
  /** Fast withdrawal: USDC only, 4 USDC minimum. Falls back to secure. */
  withdraw(account: LighterAccount, to: EvmAddress, value: Amount): Promise<{ ref: string }>
  withdrawalStatus(ref: string): Promise<'pending' | 'settled' | 'failed'>
}

/* ------------------------------------------------------------- Paymaster */

/** Gas paid in USDC through Circle Paymaster v0.8, or in ETH when that is not configured. */
export interface GasAdapter {
  /**
   * Set the 7702 delegation and the paymaster permit so later calls pay gas
   * in USDC. Idempotent: returns the existing setup if already done.
   */
  prepare(wallet: EvmAddress): Promise<{ delegationTx: Hex | null; permitTx: Hex | null }>
  /** Send a call paying gas in USDC through the bundler. */
  send(wallet: EvmAddress, to: EvmAddress, data: Hex, value?: bigint): Promise<Hex>
  /** What a call of this shape will cost in USDC, including the surcharge. */
  estimate(wallet: EvmAddress, to: EvmAddress, data: Hex): Promise<Amount>
}

/* --------------------------------------------------------------- Network */

/**
 * Every outbound request goes through here, so the checker has one place to
 * assert that nothing is leaving over the clear network.
 */
export interface NetworkAdapter {
  /**
   * 'anon-rpc' used to sit in this union and was a trap: a privacy RPC
   * covers chain traffic only, so an adapter claiming that kind would have
   * reported `isPrivate` while 1Click and Lighter — neither of which is a
   * chain — went out over the clear network. A privacy RPC complements this
   * transport; it is not one, and it is chosen per session in readConfig.
   */
  readonly kind: 'tor' | 'nym' | 'direct'
  /** False means the checker must block every movement. */
  readonly isPrivate: boolean
  /**
   * How we know. `verified` means the claim was read from something we can
   * check, such as the page being served from a .onion origin. `asserted`
   * means the user told us and we cannot see behind it. The two look the
   * same to `kind`, so without this an onion origin and a self-declared
   * proxy are indistinguishable.
   */
  readonly assurance: 'verified' | 'asserted' | 'none'
  fetch(input: string, init?: RequestInit): Promise<Response>
}

/* ----------------------------------------------------------------- Bundle */

export interface Adapters {
  readonly near: NearIntentsAdapter
  readonly noir: NoirWalletAdapter
  readonly lighter: LighterAdapter
  readonly gas: GasAdapter
  readonly network: NetworkAdapter
}
