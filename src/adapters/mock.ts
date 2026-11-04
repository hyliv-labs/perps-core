/**
 * Mock adapters.
 *
 * A complete, deterministic session without touching a real network. Every
 * delay is controllable so tests run instantly and the UI can be driven
 * through all eight states by hand.
 */

import type {
  Adapters,
  GasAdapter,
  LighterAdapter,
  NearIntentsAdapter,
  NetworkAdapter,
  NoirWalletAdapter,
  OrderRequest,
  Position,
  QuoteRequest,
} from './types'
import type { LighterAccount, SwapLeg } from '@/core/session'
import {
  type Amount,
  type EvmAddress,
  type Hex,
  type ShieldedAddress,
  ASSETS,
  amount,
  bps,
  evmAddress,
  hex,
} from '@/core/types'

export interface MockOptions {
  /** Force the inbound swap to lapse instead of settling. */
  readonly expireSwapIn?: boolean
  /** Deposited legs go straight to `refunded`, as after a lapsed deadline. */
  readonly refundSwaps?: boolean
  /** What the Lighter withdrawal reports. */
  readonly withdrawalStatus?: 'pending' | 'settled' | 'failed'
  /** USD per ZEC. The default is the price 1Click quoted on 2026-10-26. */
  readonly zecUsd?: number
  readonly now?: () => number
}

/** Calls the mock recorded, for tests that assert on call shape. */
export interface MockCalls {
  readonly gasSends: { to: string; data: string; value: bigint | undefined }[]
  readonly noirSends: { to: string; units: bigint }[]
  /** Proves the leverage the ticket shows was actually sent. */
  readonly leverage: { market: string; initialMarginFraction: number }[]
}

let counter = 0
const nextId = () => `mock-${(counter += 1)}`

/** Converts between assets at a fixed rate, with the 1Click fee applied. */
function convert(from: Amount, toAsset: 'USDC' | 'ZEC', zecUsd: number): Amount {
  const fromDec = ASSETS[from.asset].decimals
  const toDec = ASSETS[toAsset].decimals
  const rate = from.asset === 'ZEC' ? zecUsd : 1 / zecUsd
  // Scale through a bigint-safe integer rate to avoid float drift on balances.
  const scaled = (from.units * BigInt(Math.round(rate * 1e6))) / 1_000_000n
  const adjusted =
    toDec >= fromDec
      ? scaled * 10n ** BigInt(toDec - fromDec)
      : scaled / 10n ** BigInt(fromDec - toDec)
  const gross = amount(toAsset, adjusted)
  // 0.20% with an API key, per the doc's fee table.
  return amount(toAsset, gross.units - bps(gross, 20).units)
}

/** What the live window tells the simulator about the book it is reading. */
export interface MockBook {
  /** Best ask for a buy, best bid for a sell: what a marketable order meets. */
  readonly touch: number
  /** What a market sweep of this size would average, which is not the touch. */
  readonly fill: number
}

export class NotMarketableError extends Error {
  override readonly name = 'NotMarketableError'
  constructor() {
    super(
      'That limit would rest on the book rather than fill, and resting orders ' +
        'are not simulated. Move the price through the spread, or use a market order.',
    )
  }
}

/**
 * The price a simulated order fills at.
 *
 * Two mistakes are easy here and both invent money:
 *
 *   - filling a MARKET order at its signed price books a loss the size of the
 *     slippage allowance, because that price is the worst the sweep may
 *     reach, not what it pays;
 *   - filling a LIMIT order at its limit books a profit whenever the limit is
 *     better than the market, because a resting order has not traded at all.
 *
 * So a market order takes the swept average, and a limit order fills only
 * when it is marketable, and then at the touch it crosses into.
 */
export function fillPrice(order: OrderRequest, book: MockBook | null): number {
  if (order.type === 'market') return book ? book.fill : Number(order.price)

  const limit = Number(order.price)
  if (!book) return limit
  const marketable = order.side === 'buy' ? limit >= book.touch : limit <= book.touch
  if (!marketable) throw new NotMarketableError()
  return book.touch
}

export function createMockAdapters(options: MockOptions = {}): Adapters & {
  /** Advance every deposited mock swap to its configured outcome. */
  settleSwaps(): void
  /** Move every deposited or expired leg to `refunded`. */
  refundSwaps(): void
  /**
   * Tell the simulator what book the window is reading.
   *
   * The mock has no book of its own, so the caller that does have one hands
   * it over. See `fillPrice` for why the touch and the swept average are two
   * different numbers and both are needed.
   */
  showBook(book: MockBook | null): void
  readonly calls: MockCalls
} {
  const zecUsd = options.zecUsd ?? 1230.92
  const now = options.now ?? (() => Date.now())
  const legs = new Map<string, SwapLeg>()
  let rotation = 0
  const calls: MockCalls = { gasSends: [], noirSends: [], leverage: [] }

  const near: NearIntentsAdapter = {
    async quote(request: QuoteRequest): Promise<SwapLeg> {
      const out = convert(request.from, request.toAsset, zecUsd)
      const leg: SwapLeg = {
        quoteId: nextId(),
        depositAddress:
          request.from.asset === 'ZEC'
            ? `t1mockdeposit${counter}`
            : (evmAddress(`0x${'de'.repeat(20)}`) as string),
        amountIn: request.from,
        // 50 bps of slippage tolerance below the quote.
        amountOutMin: amount(out.asset, out.units - bps(out, 50).units),
        deadline: now() + request.deadlineMs,
        refundTo: request.refundTo,
        recipient: request.recipient,
        status: 'quoted',
      }
      legs.set(leg.quoteId, leg)
      return leg
    },
    async status(leg) {
      return legs.get(leg.quoteId) ?? leg
    },
    async minimum(_asset, toAsset) {
      return toAsset === 'USDC' ? amount('ZEC', 1_000_000n) : amount('USDC', 5_000_000n)
    },
  }

  /** Mark whichever quoted leg is expecting funds at `to` as deposited. */
  function markDeposited(to: string): void {
    for (const [id, leg] of legs) {
      if (leg.depositAddress.toLowerCase() === to.toLowerCase() && leg.status === 'quoted') {
        legs.set(id, { ...leg, status: 'deposited' })
      }
    }
  }

  const noir: NoirWalletAdapter = {
    async isAvailable() {
      return true
    },
    async connect() {},
    async freshReceiveAddress() {
      // Unique across page loads, not just within one run. The ledger that
      // enforces `fresh_exit_address` lives in IndexedDB and outlives the
      // tab, so a counter restarting at 1 hands the next session an address
      // the last one already used — and the checker rightly refuses it.
      rotation += 1
      const mark = `${rotation}x${Math.random().toString(36).slice(2, 10)}`
      return `u1mockrotated${mark}${'q'.repeat(Math.max(0, 30 - mark.length))}` as ShieldedAddress
    },
    async send(to, value) {
      calls.noirSends.push({ to, units: value.units })
      markDeposited(to)
      return { txid: nextId() }
    },
    async balance() {
      return amount('ZEC', 50_00000000n)
    },
  }

  /**
   * Simulated fills, so the trading window is not a dead end.
   *
   * An order fills whole against the book it is told about and nets against
   * whatever is already open. Nothing here touches a real exchange, and the
   * UI says so next to every number it draws from this.
   */
  const open = new Map<string, { size: number; entry: number }>()
  let book: MockBook | null = null
  const leverage = new Map<string, number>()

  const lighter: LighterAdapter = {
    async depositAddress(from) {
      // Derived from the sender, as Lighter's intent address is, so the
      // mock is idempotent in the same way the real one is.
      // Lowercase, or viem reads the mixed case as a checksum and rejects it.
      return `0x${from.slice(2, 10)}${'d0'.repeat(16)}`.toLowerCase() as EvmAddress
    },

    async openAccount(_from, deposit) {
      void deposit
      return { accountIndex: 1001, apiKeyIndex: 0, apiPublicKey: `0x${'ab'.repeat(32)}` }
    },

    async setLeverage(_account, market, initialMarginFraction) {
      leverage.set(market, initialMarginFraction)
      calls.leverage.push({ market, initialMarginFraction })
      return { txHash: nextId() }
    },

    async placeOrder(_account: LighterAccount, order: OrderRequest) {
      const signed = (order.side === 'buy' ? 1 : -1) * Number(order.size)
      const price = fillPrice(order, book)
      const held = open.get(order.market) ?? { size: 0, entry: price }
      const size = held.size + signed
      if (Math.abs(size) < 1e-9) {
        open.delete(order.market)
      } else {
        // Averaging only when adding to the same side; a reduce keeps its entry.
        const adding = held.size === 0 || Math.sign(held.size) === Math.sign(signed)
        const entry = adding
          ? (Math.abs(held.size) * held.entry + Math.abs(signed) * price) / Math.abs(size)
          : held.entry
        open.set(order.market, { size, entry })
      }
      return { orderId: nextId() }
    },
    async positions(): Promise<readonly Position[]> {
      return [...open].map(([market, p]) => ({
        market,
        size: p.size.toFixed(3),
        entryPrice: p.entry.toFixed(3),
        // The mark is not known here; the UI prices it against the live book.
        unrealizedPnl: '0',
      }))
    },
    async closeAll() {
      open.clear()
    },
    async withdraw(_account, _to, value) {
      void value
      return { ref: nextId() }
    },
    async withdrawalStatus() {
      return options.withdrawalStatus ?? 'settled'
    },
  }

  const gas: GasAdapter = {
    async prepare() {
      return { delegationTx: hex(`0x${'11'.repeat(32)}`), permitTx: hex(`0x${'22'.repeat(32)}`) }
    },
    async send(_wallet, to, data, value) {
      calls.gasSends.push({ to, data, value })
      // The outbound leg is an ERC-20 transfer to the token contract, so the
      // deposit address is in the calldata, not in `to`.
      for (const [id, leg] of legs) {
        const encoded = leg.depositAddress.replace(/^0x/, '').toLowerCase()
        if (leg.status === 'quoted' && data.toLowerCase().includes(encoded)) {
          legs.set(id, { ...leg, status: 'deposited' })
        }
      }
      markDeposited(to)
      return hex(`0x${'33'.repeat(32)}`) as Hex
    },
    async estimate() {
      // A touch over a real Arbitrum call, including Circle's 10% surcharge.
      return amount('USDC', 30_000n)
    },
  }

  const network: NetworkAdapter = {
    kind: 'direct',
    isPrivate: true, // mocks never leave the process
    assurance: 'verified',
    async fetch() {
      throw new Error('mock network: no outbound requests')
    },
  }

  return {
    near,
    noir,
    lighter,
    gas,
    network,
    calls,
    showBook(next: MockBook | null) {
      book = next
    },
    refundSwaps() {
      for (const [id, leg] of legs) {
        if (leg.status === 'deposited' || leg.status === 'expired') {
          legs.set(id, { ...leg, status: 'refunded' })
        }
      }
    },
    settleSwaps() {
      for (const [id, leg] of legs) {
        if (leg.status === 'expired' && options.refundSwaps) {
          legs.set(id, { ...leg, status: 'refunded' })
          continue
        }
        if (leg.status !== 'deposited') continue
        if (options.refundSwaps) {
          legs.set(id, { ...leg, status: 'refunded' })
          continue
        }
        if (options.expireSwapIn && leg.amountIn.asset === 'ZEC') {
          legs.set(id, { ...leg, status: 'expired' })
          continue
        }
        const out = convert(leg.amountIn, leg.amountOutMin.asset as 'USDC' | 'ZEC', zecUsd)
        legs.set(id, { ...leg, status: 'settled', settledAmount: out })
      }
    },
  }
}

export const MOCK_SESSION_WALLET: EvmAddress = evmAddress(`0x${'5e'.repeat(20)}`)
