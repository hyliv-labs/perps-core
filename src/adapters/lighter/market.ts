/**
 * Lighter market data for one perp market.
 *
 * Verified against the live API on 2026-10-27 from a browser origin:
 *
 *   GET /api/v1/orderBookDetails?market_id=90 -> 200, ACAO: *
 *   GET /api/v1/orderBookOrders?market_id=90  -> 200, ACAO: *
 *   GET /api/v1/recentTrades?market_id=90     -> 200, ACAO: *
 *   GET /api/v1/funding-rates                 -> 200, ACAO: *
 *   GET /api/v1/candlesticks                  -> 403, so there is no chart
 *
 * CORS allows a static page to read all four, so the window needs no backend.
 * Every read goes through the NetworkAdapter, so the checker still owns the
 * question of whether anything may leave this machine.
 *
 * `orderBookOrders` returns one row per resting ORDER, not per price level,
 * and the same price appears more than once. Aggregating is not a nicety;
 * drawing the raw rows would show a book that does not exist.
 */

import type { NetworkAdapter } from '../types'
import type { Logger } from '@/core/log'
import { LIGHTER_API, LighterError } from './http'

/** The one market this product trades: ZEC perpetual, quoted in USDC. */
export const ZEC_MARKET_ID = 90

/**
 * Initial margin fractions are expressed against this tick, so leverage is
 * `MARGIN_FRACTION_TICK / imf`. Confirmed in lighter-go
 * types/txtypes/constants.go at the pinned commit: `MarginFractionTick = 10_000`.
 */
export const MARGIN_FRACTION_TICK = 10_000

export interface Ticker {
  readonly symbol: string
  readonly marketId: number
  readonly status: string
  readonly dailyTrades: number
  readonly last: number
  readonly mark: number
  readonly index: number
  /** Already a percentage: 0.377 means +0.38% over the day. */
  readonly changePct: number
  readonly high: number
  readonly low: number
  readonly baseVolume: number
  readonly quoteVolume: number
  readonly openInterest: number
  readonly openInterestUsd: number
  readonly minBase: number
  readonly minQuote: number
  readonly sizeDecimals: number
  readonly priceDecimals: number
  readonly takerFee: number
  readonly makerFee: number
  readonly defaultImf: number
  readonly minImf: number
  readonly maintenanceImf: number
}

export interface Level {
  readonly price: number
  readonly size: number
  /** Cumulative size from the top of the book down to this level. */
  readonly total: number
}

export interface Book {
  /** Ascending from the best ask. */
  readonly asks: readonly Level[]
  /** Descending from the best bid. */
  readonly bids: readonly Level[]
  readonly spread: number
  readonly mid: number
}

export interface Trade {
  readonly price: number
  readonly size: number
  readonly at: number
  /** The taker's side. `is_maker_ask` means the resting order was the ask. */
  readonly side: 'buy' | 'sell'
}

/** One card in the market strip: enough to pick a market, nothing more. */
export interface MarketCard {
  readonly symbol: string
  readonly marketId: number
  readonly last: number
  readonly changePct: number
  readonly quoteVolume: number
  /** Hourly closes over the last day, oldest first. Empty until they arrive. */
  readonly spark: readonly number[]
}

export interface MarketSnapshot {
  readonly ticker: Ticker
  readonly book: Book
  readonly trades: readonly Trade[]
  /** Lighter's own rate. The endpoint publishes no interval, so none is shown. */
  readonly fundingRate: number | null
  readonly at: number
  /** True when this came from the pinned fixture rather than the live API. */
  readonly stale: boolean
}

/* ------------------------------------------------------------------ parse */

export interface RawDetails {
  symbol: string
  market_id: number
  status: string
  daily_trades_count: number
  mark_price: string
  index_price: string
  last_trade_price: number
  daily_price_change: number
  daily_price_high: number
  daily_price_low: number
  daily_base_token_volume: number
  daily_quote_token_volume: number
  open_interest: number
  open_interest_usd: string
  min_base_amount: string
  min_quote_amount: string
  supported_size_decimals: number
  supported_price_decimals: number
  taker_fee: string
  maker_fee: string
  default_initial_margin_fraction: number
  min_initial_margin_fraction: number
  maintenance_margin_fraction: number
}

export function parseTicker(raw: RawDetails): Ticker {
  return {
    symbol: raw.symbol,
    marketId: raw.market_id,
    status: raw.status,
    dailyTrades: Number(raw.daily_trades_count),
    last: Number(raw.last_trade_price),
    mark: Number(raw.mark_price),
    index: Number(raw.index_price),
    changePct: Number(raw.daily_price_change),
    high: Number(raw.daily_price_high),
    low: Number(raw.daily_price_low),
    baseVolume: Number(raw.daily_base_token_volume),
    quoteVolume: Number(raw.daily_quote_token_volume),
    openInterest: Number(raw.open_interest),
    openInterestUsd: Number(raw.open_interest_usd),
    minBase: Number(raw.min_base_amount),
    minQuote: Number(raw.min_quote_amount),
    sizeDecimals: raw.supported_size_decimals,
    priceDecimals: raw.supported_price_decimals,
    takerFee: Number(raw.taker_fee),
    makerFee: Number(raw.maker_fee),
    defaultImf: raw.default_initial_margin_fraction,
    minImf: raw.min_initial_margin_fraction,
    maintenanceImf: raw.maintenance_margin_fraction,
  }
}

export interface RawOrder {
  price: string
  remaining_base_amount: string
}

/** `/api/v1/candles`, whose keys are one letter each. `c` is the close. */
export interface RawCandle {
  t: number
  o: number
  h: number
  l: number
  c: number
  v: number
}

/** The resolutions Lighter's `/api/v1/candles` answers. All six verified live. */
export const RESOLUTIONS = ['1m', '5m', '15m', '1h', '4h', '1d'] as const
export type Resolution = (typeof RESOLUTIONS)[number]

/** Seconds per candle, for asking for the right span. */
export const RESOLUTION_SECONDS: Record<Resolution, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '4h': 14_400,
  '1d': 86_400,
}

export interface Candle {
  readonly at: number
  readonly open: number
  readonly high: number
  readonly low: number
  readonly close: number
  readonly volume: number
}

/** The bucket a timestamp belongs to, in seconds. Lighter stamps candles at the open. */
export function candleBucket(atSeconds: number, resolution: Resolution): number {
  const step = RESOLUTION_SECONDS[resolution]
  const at = atSeconds > 1e12 ? Math.floor(atSeconds / 1000) : Math.floor(atSeconds)
  return Math.floor(at / step) * step
}

/** Seconds left in the candle that is open at `nowMs`. A fresh bucket reads as a full interval. */
export function secondsUntilClose(resolution: Resolution, nowMs: number): number {
  const step = RESOLUTION_SECONDS[resolution]
  const elapsed = Math.floor(nowMs / 1000) % step
  return elapsed === 0 ? step : step - elapsed
}

/**
 * History plus the candle that is still forming.
 *
 * The exchange candle is a snapshot. Between reads the last trade moves the
 * close, and stretches the high or the low, and when the clock crosses into
 * the next bucket a new candle opens. The series stays the same length, so
 * the oldest bar leaves as the new one arrives.
 */
export function withFormingCandle(
  history: readonly Candle[],
  last: number,
  resolution: Resolution,
  nowMs: number,
): Candle[] {
  if (history.length === 0 || !Number.isFinite(last) || last <= 0) return [...history]
  const openAt = candleBucket(Math.floor(nowMs / 1000), resolution)
  const closed = history[history.length - 1]!
  const closedAt = candleBucket(closed.at, resolution)

  if (openAt < closedAt) return [...history]
  if (openAt === closedAt) {
    return [
      ...history.slice(0, -1),
      {
        ...closed,
        at: closedAt,
        close: last,
        high: Math.max(closed.high, last),
        low: Math.min(closed.low, last),
      },
    ]
  }
  const opened: Candle = { at: openAt, open: last, high: last, low: last, close: last, volume: 0 }
  // One bar of history is kept, so the chart still has a candle to compare with.
  return history.length === 1 ? [...history, opened] : [...history.slice(1), opened]
}

export function parseCandles(raw: readonly RawCandle[], limit: number): Candle[] {
  return raw
    .filter((k) => Number(k.c) > 0 && Number(k.h) > 0)
    .sort((a, b) => a.t - b.t)
    .slice(-limit)
    .map((k) => ({
      at: Number(k.t),
      open: Number(k.o),
      high: Number(k.h),
      low: Number(k.l),
      close: Number(k.c),
      volume: Number(k.v),
    }))
}

/**
 * Funding settles every hour.
 *
 * Verified on 2026-10-27: `/api/v1/fundings` returns entries exactly 3600
 * seconds apart, which is what lets this name an interval at all. The
 * `funding-rates` endpoint on its own publishes none.
 */
export const FUNDING_SECONDS = 3600

/** Milliseconds until funding settles next, which is the top of the hour. */
export function untilFunding(now = Date.now()): number {
  const period = FUNDING_SECONDS * 1000
  return period - (now % period)
}

export function parseSpark(raw: readonly RawCandle[]): number[] {
  return raw
    .slice()
    .sort((a, b) => a.t - b.t)
    .map((k) => Number(k.c))
    .filter((n) => Number.isFinite(n) && n > 0)
}

/**
 * The markets worth putting on the strip: the busiest, by the day's quote
 * volume.
 *
 * ZEC is kept whatever its rank. It sat sixth on 2026-10-27, but a product
 * whose whole point is entering and leaving in Zcash cannot have its own
 * market drop off the picker on a quiet day.
 */
export function rankMarkets(
  details: readonly RawDetails[],
  count: number,
  keep = 'ZEC',
): MarketCard[] {
  const card = (d: RawDetails): MarketCard => ({
    symbol: d.symbol,
    marketId: d.market_id,
    last: Number(d.last_trade_price),
    changePct: Number(d.daily_price_change),
    quoteVolume: Number(d.daily_quote_token_volume),
    spark: [],
  })

  const active = details.filter((d) => d.status === 'active').map(card)
  active.sort((a, b) => b.quoteVolume - a.quoteVolume)

  const top = active.slice(0, count)
  if (top.some((m) => m.symbol === keep)) return top

  const kept = active.find((m) => m.symbol === keep)
  // Pushed to the front, not appended: it is the one this product is for.
  return kept ? [kept, ...top.slice(0, count - 1)] : top
}

/**
 * Collapse resting orders into price levels.
 *
 * The API's own order is trusted for neither side: asks are sorted ascending
 * and bids descending here, so a change at Lighter's end cannot silently
 * invert the book.
 */
export function aggregate(raw: readonly RawOrder[], side: 'ask' | 'bid', depth: number): Level[] {
  const sizes = new Map<number, number>()
  for (const row of raw) {
    const price = Number(row.price)
    const size = Number(row.remaining_base_amount)
    if (!Number.isFinite(price) || !Number.isFinite(size) || size <= 0) continue
    sizes.set(price, (sizes.get(price) ?? 0) + size)
  }
  const prices = [...sizes.keys()].sort((a, b) => (side === 'ask' ? a - b : b - a))
  const levels: Level[] = []
  let total = 0
  for (const price of prices.slice(0, depth)) {
    const size = sizes.get(price) ?? 0
    total = round(total + size, 6)
    levels.push({ price, size: round(size, 6), total })
  }
  return levels
}

export interface RawTrade {
  price: string
  size: string
  timestamp: number
  is_maker_ask: boolean
}

export function parseTrades(raw: readonly RawTrade[], limit: number): Trade[] {
  return raw.slice(0, limit).map((t) => ({
    price: Number(t.price),
    size: Number(t.size),
    at: Number(t.timestamp),
    // The maker was the ask, so the taker lifted it: a buy.
    side: t.is_maker_ask ? ('buy' as const) : ('sell' as const),
  }))
}

/* ------------------------------------------------------------------- math */

const round = (n: number, dp: number) => {
  const f = 10 ** dp
  return Math.round(n * f) / f
}

const ceilTo = (n: number, dp: number) => {
  const f = 10 ** dp
  return Math.ceil(n * f - 1e-9) / f
}

/**
 * The smallest order Lighter will take, which is NOT `min_base_amount` alone.
 *
 * Both floors apply: 0.004 ZEC and 10 USDC of notional. At 1,240 USDC the
 * quote floor binds at about 0.009 ZEC, more than twice the base floor, so
 * checking only the base floor lets through orders the exchange refuses.
 */
export function minimumSize(ticker: Ticker, price: number): number {
  if (!Number.isFinite(price) || price <= 0) return ticker.minBase
  return Math.max(ticker.minBase, ceilTo(ticker.minQuote / price, ticker.sizeDecimals))
}

export function leverageFromImf(imf: number): number {
  return imf > 0 ? MARGIN_FRACTION_TICK / imf : 1
}

export function imfFromLeverage(leverage: number, ticker: Ticker): number {
  const raw = Math.round(MARGIN_FRACTION_TICK / Math.max(leverage, 1))
  return Math.min(MARGIN_FRACTION_TICK, Math.max(ticker.minImf, raw))
}

export function maxLeverage(ticker: Ticker): number {
  return Math.floor(leverageFromImf(ticker.minImf))
}

export interface Sweep {
  /** Volume-weighted price the book can actually fill this size at. */
  readonly averagePrice: number
  /** The deepest level touched, before any slippage allowance. */
  readonly worstPrice: number
  /** How far the average sits from the touch, in basis points. */
  readonly impactBps: number
  /** False when the visible book is not deep enough for this size. */
  readonly fillable: boolean
}

/**
 * Walk the book for a size, so the ticket quotes the price the book gives
 * rather than the top of it.
 *
 * Only the levels fetched are visible, so a size past them reports
 * `fillable: false` instead of extrapolating a price out of nothing.
 */
export function sweep(book: Book, side: 'buy' | 'sell', size: number): Sweep | null {
  const levels = side === 'buy' ? book.asks : book.bids
  const touch = levels[0]
  if (!touch || !Number.isFinite(size) || size <= 0) return null

  let left = size
  let cost = 0
  let worst = touch.price
  for (const level of levels) {
    const take = Math.min(left, level.size)
    cost += take * level.price
    worst = level.price
    left -= take
    if (left <= 1e-12) break
  }
  const filled = size - Math.max(left, 0)
  if (filled <= 0) return null

  const averagePrice = cost / filled
  const impact = ((averagePrice - touch.price) / touch.price) * (side === 'buy' ? 1 : -1)
  return {
    averagePrice,
    worstPrice: worst,
    impactBps: round(impact * 10_000, 2),
    fillable: left <= 1e-12,
  }
}

/**
 * The price a market order is signed with.
 *
 * Lighter's signer rejects a price below 1 (`MinOrderPrice`, lighter-go
 * constants.go), and the Python SDK names this field `avg_execution_price`:
 * it is the worst price the immediate-or-cancel order may sweep to, not a
 * placeholder. Sending zero would have every market order refused.
 */
export function slippageBound(
  reference: number,
  side: 'buy' | 'sell',
  bps: number,
  priceDecimals: number,
): string {
  const moved = reference * (1 + (side === 'buy' ? bps : -bps) / 10_000)
  const f = 10 ** priceDecimals
  // Round outward, so rounding never tightens the bound below what was shown.
  const units = side === 'buy' ? Math.ceil(moved * f) : Math.floor(moved * f)
  return (Math.max(units, 1) / f).toFixed(priceDecimals)
}

/**
 * Where an isolated position of this leverage gets liquidated.
 *
 * Maintenance margin only. Funding and the fees of the closing trade are not
 * in it, so the real level is slightly nearer than this. Shown as "about".
 */
export function liquidationPrice(
  entry: number,
  leverage: number,
  side: 'buy' | 'sell',
  ticker: Ticker,
): number | null {
  if (!Number.isFinite(entry) || entry <= 0 || leverage <= 0) return null
  const mmf = ticker.maintenanceImf / MARGIN_FRACTION_TICK
  const move = 1 / leverage - mmf
  if (move <= 0) return null
  return side === 'buy' ? entry * (1 - move) : entry * (1 + move)
}

/* ------------------------------------------------------------------ reads */

export interface MarketDataOptions {
  readonly network: NetworkAdapter
  readonly logger: Logger
  readonly apiUrl?: string
  readonly marketId?: number
  readonly depth?: number
  readonly tape?: number
}

/** How many hours of closes a sparkline draws. */
export const SPARK_HOURS = 24

export function createMarketData(options: MarketDataOptions) {
  const api = options.apiUrl ?? LIGHTER_API
  const depth = options.depth ?? 9
  const tape = options.tape ?? 14

  /** The one market's details, used by both the card and the snapshot. */
  async function detailsFor(marketId: number): Promise<RawDetails> {
    const body = await get<{ order_book_details?: RawDetails[] }>(
      `/api/v1/orderBookDetails?market_id=${marketId}`,
    )
    const raw = body.order_book_details?.[0]
    if (!raw) throw new LighterError(404, `no Lighter market with id ${marketId}`)
    return raw
  }

  async function rawCandles(
    marketId: number,
    resolution: Resolution,
    bars: number,
  ): Promise<RawCandle[]> {
    const now = Math.floor(Date.now() / 1000)
    const span = RESOLUTION_SECONDS[resolution] * bars
    const body = await get<{ c?: RawCandle[] }>(
      `/api/v1/candles?market_id=${marketId}&resolution=${resolution}` +
        `&start_timestamp=${now - span}&end_timestamp=${now}` +
        `&count_back=${bars}&set_timestamp_to_end=false`,
    )
    return body.c ?? []
  }

  async function get<T>(path: string): Promise<T> {
    const response = await options.network.fetch(`${api}${path}`)
    const text = await response.text()
    if (!response.ok) throw new LighterError(response.status, text)
    return JSON.parse(text) as T
  }

  return {
    /**
     * Rank every market once, to decide what goes on the strip.
     *
     * This is the one heavy read in the app: 241 markets, about 400kB, and
     * the endpoint does not gzip. It runs once when the screen opens, never
     * on the polling loop — the strip is then refreshed market by market at
     * under 2kB each, which matters a great deal over a mixnet.
     */
    async rank(count: number): Promise<MarketCard[]> {
      const body = await get<{ order_book_details?: RawDetails[] }>('/api/v1/orderBookDetails')
      const all = body.order_book_details ?? []
      if (all.length === 0) throw new LighterError(502, 'Lighter listed no markets')
      options.logger.debug('lighter ranked', { markets: all.length, count })
      return rankMarkets(all, count)
    },

    /** One market's prices, for refreshing a card without the other 240. */
    async card(marketId: number): Promise<Omit<MarketCard, 'spark'>> {
      const raw = await detailsFor(marketId)
      return {
        symbol: raw.symbol,
        marketId: raw.market_id,
        last: Number(raw.last_trade_price),
        changePct: Number(raw.daily_price_change),
        quoteVolume: Number(raw.daily_quote_token_volume),
      }
    },

    /** Hourly closes for a sparkline. Correct path: `candles`, not `candlesticks`. */
    async spark(marketId: number, hours = SPARK_HOURS): Promise<number[]> {
      return parseSpark(await rawCandles(marketId, '1h', hours))
    },

    /**
     * Candles for the chart.
     *
     * Lighter ignores `count_back` on the short resolutions and answers with
     * whatever the window holds — 500 for a day of minutes — so the window is
     * asked for by resolution and the result trimmed here.
     */
    async candles(marketId: number, resolution: Resolution, bars: number): Promise<Candle[]> {
      return parseCandles(await rawCandles(marketId, resolution, bars), bars)
    },

    /**
     * One snapshot, four reads.
     *
     * They are fetched together rather than in sequence so the book and the
     * tape describe very nearly the same moment. A failure in any one fails
     * the snapshot: half a trading window is worse than none, because the
     * half that is stale does not look stale.
     */
    async snapshot(marketId = ZEC_MARKET_ID): Promise<MarketSnapshot> {
      const [raw, orders, trades, funding] = await Promise.all([
        detailsFor(marketId),
        get<{ asks?: RawOrder[]; bids?: RawOrder[] }>(
          `/api/v1/orderBookOrders?market_id=${marketId}&limit=60`,
        ),
        get<{ trades?: RawTrade[] }>(`/api/v1/recentTrades?market_id=${marketId}&limit=${tape}`),
        get<{ funding_rates?: { market_id: number; exchange: string; rate: number }[] }>(
          '/api/v1/funding-rates',
        ),
      ])

      const asks = aggregate(orders.asks ?? [], 'ask', depth)
      const bids = aggregate(orders.bids ?? [], 'bid', depth)
      const own = funding.funding_rates?.find(
        (r) => r.market_id === marketId && r.exchange === 'lighter',
      )

      options.logger.debug('lighter snapshot', { marketId, asks: asks.length, bids: bids.length })

      return {
        ticker: parseTicker(raw),
        book: makeBook(asks, bids),
        trades: parseTrades(trades.trades ?? [], tape),
        fundingRate: own ? own.rate : null,
        at: Date.now(),
        stale: false,
      }
    },
  }
}

export function makeBook(asks: readonly Level[], bids: readonly Level[]): Book {
  const bestAsk = asks[0]?.price ?? 0
  const bestBid = bids[0]?.price ?? 0
  const both = bestAsk > 0 && bestBid > 0
  return {
    asks,
    bids,
    spread: both ? round(bestAsk - bestBid, 6) : 0,
    mid: both ? round((bestAsk + bestBid) / 2, 6) : bestAsk || bestBid,
  }
}
