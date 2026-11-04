import { describe, expect, it } from 'vitest'
import {
  aggregate,
  imfFromLeverage,
  leverageFromImf,
  liquidationPrice,
  makeBook,
  maxLeverage,
  minimumSize,
  parseTicker,
  parseSpark,
  secondsUntilClose,
  withFormingCandle,
  parseTrades,
  rankMarkets,
  slippageBound,
  sweep,
  type RawDetails,
} from '@/adapters/lighter/market'
import { fixtureMarkets, fixtureSnapshot, FIXTURE_CAPTURED_AT } from '@/adapters/lighter/fixture'
import { createMockAdapters, fillPrice, NotMarketableError } from '@/adapters/mock'
import type { OrderRequest } from '@/adapters/types'

/**
 * These check the arithmetic the trading window shows, against a book
 * captured from the live API on 2026-10-27.
 */

const DETAILS: RawDetails = {
  symbol: 'ZEC',
  market_id: 90,
  status: 'active',
  daily_trades_count: 43548,
  mark_price: '1239.520',
  index_price: '1240.056',
  last_trade_price: 1239.174,
  daily_price_change: 0.3767447022048192,
  daily_price_high: 1267.828,
  daily_price_low: 1210.8,
  daily_base_token_volume: 30434.331,
  daily_quote_token_volume: 37536651.736039,
  open_interest: 11295.353,
  open_interest_usd: '28001631.901120',
  min_base_amount: '0.004',
  min_quote_amount: '10.000000',
  supported_size_decimals: 3,
  supported_price_decimals: 3,
  taker_fee: '0.0000',
  maker_fee: '0.0000',
  default_initial_margin_fraction: 666,
  min_initial_margin_fraction: 500,
  maintenance_margin_fraction: 300,
}

const ticker = parseTicker(DETAILS)

describe('the order book', () => {
  it('collapses repeated prices into one level', () => {
    // orderBookOrders returns a row per resting ORDER, and the live book had
    // 1239.708 twice. Drawing the raw rows would show a book that is not there.
    const levels = aggregate(
      [
        { price: '1239.708', remaining_base_amount: '0.400' },
        { price: '1239.708', remaining_base_amount: '0.600' },
        { price: '1239.627', remaining_base_amount: '0.807' },
      ],
      'ask',
      5,
    )
    expect(levels).toHaveLength(2)
    expect(levels[0]).toMatchObject({ price: 1239.627, size: 0.807 })
    expect(levels[1]).toMatchObject({ price: 1239.708, size: 1 })
  })

  it('sorts each side itself rather than trusting the response', () => {
    const scrambled = [
      { price: '100', remaining_base_amount: '1' },
      { price: '102', remaining_base_amount: '1' },
      { price: '101', remaining_base_amount: '1' },
    ]
    expect(aggregate(scrambled, 'ask', 5).map((l) => l.price)).toEqual([100, 101, 102])
    expect(aggregate(scrambled, 'bid', 5).map((l) => l.price)).toEqual([102, 101, 100])
  })

  it('accumulates depth downward from the touch', () => {
    const levels = aggregate(
      [
        { price: '100', remaining_base_amount: '1' },
        { price: '101', remaining_base_amount: '2' },
        { price: '102', remaining_base_amount: '3' },
      ],
      'ask',
      5,
    )
    expect(levels.map((l) => l.total)).toEqual([1, 3, 6])
  })

  it('drops rows with no size left', () => {
    expect(aggregate([{ price: '100', remaining_base_amount: '0' }], 'ask', 5)).toEqual([])
  })

  it('reads the spread from the two touches', () => {
    const book = makeBook(
      aggregate([{ price: '1239.627', remaining_base_amount: '1' }], 'ask', 5),
      aggregate([{ price: '1239.594', remaining_base_amount: '1' }], 'bid', 5),
    )
    expect(book.spread).toBeCloseTo(0.033, 6)
    expect(book.mid).toBeCloseTo(1239.6105, 6)
  })
})

describe('the tape', () => {
  it('reads the taker’s side, not the maker’s', () => {
    // is_maker_ask means the resting order was the ask, so the taker bought.
    const trades = parseTrades(
      [
        { price: '1239', size: '0.1', timestamp: 1, is_maker_ask: true },
        { price: '1238', size: '0.2', timestamp: 2, is_maker_ask: false },
      ],
      10,
    )
    expect(trades.map((t) => t.side)).toEqual(['buy', 'sell'])
  })
})

describe('the minimum order', () => {
  it('takes the quote floor when it binds, not the base floor alone', () => {
    // 10 USDC / 1239.627 = 0.00807 ZEC, rounded up to 0.009 at 3dp, which is
    // more than twice min_base_amount. Checking only the base floor lets
    // through orders Lighter refuses.
    expect(minimumSize(ticker, 1239.627)).toBeCloseTo(0.009, 6)
    expect(minimumSize(ticker, 1239.627)).toBeGreaterThan(ticker.minBase)
  })

  it('falls back to the base floor when the price is cheap enough', () => {
    // At 5000 USDC a coin, 10 USDC is 0.002, below the 0.004 base floor.
    expect(minimumSize(ticker, 5000)).toBeCloseTo(0.004, 6)
  })

  it('never divides by a price it does not have', () => {
    expect(minimumSize(ticker, 0)).toBe(ticker.minBase)
    expect(minimumSize(ticker, Number.NaN)).toBe(ticker.minBase)
  })

  it('rounds the floor up, so the suggested size is always accepted', () => {
    const floor = minimumSize(ticker, 1239.627)
    expect(floor * 1239.627).toBeGreaterThanOrEqual(ticker.minQuote)
  })
})

describe('leverage', () => {
  it('reads the margin fraction against lighter-go’s tick of 10,000', () => {
    expect(leverageFromImf(500)).toBe(20)
    expect(leverageFromImf(666)).toBeCloseTo(15.015, 3)
    expect(maxLeverage(ticker)).toBe(20)
  })

  it('never asks for more leverage than the market allows', () => {
    expect(imfFromLeverage(20, ticker)).toBe(500)
    expect(imfFromLeverage(1000, ticker)).toBe(ticker.minImf)
    expect(imfFromLeverage(1, ticker)).toBe(10_000)
  })
})

describe('liquidation', () => {
  it('puts a long below the entry and a short above it', () => {
    const long = liquidationPrice(1240, 10, 'buy', ticker)
    const short = liquidationPrice(1240, 10, 'sell', ticker)
    // 1/10 - 300/10000 = 7% of the entry.
    expect(long).toBeCloseTo(1240 * 0.93, 6)
    expect(short).toBeCloseTo(1240 * 1.07, 6)
  })

  it('refuses to quote a level where maintenance already exceeds margin', () => {
    // At 40x the 3% maintenance margin is already past the 2.5% posted.
    expect(liquidationPrice(1240, 40, 'buy', ticker)).toBeNull()
    expect(liquidationPrice(0, 10, 'buy', ticker)).toBeNull()
  })
})

describe('sweeping the book', () => {
  const book = makeBook(
    aggregate(
      [
        { price: '100', remaining_base_amount: '1' },
        { price: '101', remaining_base_amount: '1' },
        { price: '102', remaining_base_amount: '1' },
      ],
      'ask',
      5,
    ),
    aggregate(
      [
        { price: '99', remaining_base_amount: '1' },
        { price: '98', remaining_base_amount: '1' },
      ],
      'bid',
      5,
    ),
  )

  it('quotes the weighted price the book actually gives', () => {
    const filled = sweep(book, 'buy', 2)
    expect(filled?.averagePrice).toBeCloseTo(100.5, 6)
    expect(filled?.worstPrice).toBe(101)
    expect(filled?.fillable).toBe(true)
    // 0.5 above a 100 touch is 50 basis points.
    expect(filled?.impactBps).toBeCloseTo(50, 1)
  })

  it('reports impact as positive on both sides', () => {
    // Selling into bids walks the price down, which is still cost, not gain.
    const filled = sweep(book, 'sell', 2)
    expect(filled?.averagePrice).toBeCloseTo(98.5, 6)
    expect(filled?.impactBps).toBeGreaterThan(0)
  })

  it('says the book is too thin instead of extrapolating a price', () => {
    const filled = sweep(book, 'buy', 10)
    expect(filled?.fillable).toBe(false)
  })

  it('has nothing to say about an empty book or a zero size', () => {
    expect(sweep(makeBook([], []), 'buy', 1)).toBeNull()
    expect(sweep(book, 'buy', 0)).toBeNull()
  })
})

describe('the signed price', () => {
  it('never signs a zero, which lighter-go refuses as MinOrderPrice', () => {
    expect(Number(slippageBound(0.0001, 'sell', 5000, 3))).toBeGreaterThan(0)
  })

  it('bounds a buy above the touch and a sell below it', () => {
    expect(Number(slippageBound(1000, 'buy', 50, 3))).toBeCloseTo(1005, 3)
    expect(Number(slippageBound(1000, 'sell', 50, 3))).toBeCloseTo(995, 3)
  })

  it('rounds outward, so rounding never tightens the bound shown', () => {
    // 1239.627 + 0.5% = 1245.825135, which must not round down to 1245.825.
    expect(slippageBound(1239.627, 'buy', 50, 3)).toBe('1245.826')
    expect(slippageBound(1239.627, 'sell', 50, 3)).toBe('1233.428')
  })
})

describe('the recorded snapshot', () => {
  const snap = fixtureSnapshot()

  it('is labelled as a record, so it cannot pass for a live price', () => {
    expect(snap.stale).toBe(true)
    expect(FIXTURE_CAPTURED_AT).toBe('2026-10-27')
  })

  it('carries a book that crosses nowhere', () => {
    const bestAsk = snap.book.asks[0]!.price
    const bestBid = snap.book.bids[0]!.price
    expect(bestAsk).toBeGreaterThan(bestBid)
    expect(snap.book.spread).toBeGreaterThan(0)
  })

  it('is the ZEC perp, with the fees Lighter actually charges', () => {
    expect(snap.ticker.symbol).toBe('ZEC')
    expect(snap.ticker.marketId).toBe(90)
    expect(snap.ticker.takerFee).toBe(0)
    expect(snap.ticker.makerFee).toBe(0)
  })

  it('has enough depth to quote the sizes a session can afford', () => {
    // A 1 ZEC session is about 1,240 USDC, so single-digit ZEC at 20x.
    expect(sweep(snap.book, 'buy', 5)?.fillable).toBe(true)
  })
})

describe('simulated fills', () => {
  const order = (over: Partial<OrderRequest> = {}): OrderRequest => ({
    market: 'ZEC',
    side: 'buy',
    size: '1',
    type: 'market',
    price: '1250',
    reduceOnly: false,
    ...over,
  })

  it('fills a market order at the swept average, not at its slippage bound', () => {
    // 1250 is the worst the sweep may reach. Filling there books an instant
    // loss the size of the allowance, which is not what a market order does.
    expect(fillPrice(order(), { touch: 1240, fill: 1240.6 })).toBe(1240.6)
  })

  it('fills a marketable limit at the touch it crosses into', () => {
    expect(
      fillPrice(order({ type: 'limit', price: '1245' }), { touch: 1240, fill: 1240 }),
    ).toBe(1240)
  })

  it('refuses a limit that would rest rather than inventing a better price', () => {
    // A buy at 1230 against a 1240 ask has not traded; filling it at 1230
    // would be profit out of nothing.
    expect(() =>
      fillPrice(order({ type: 'limit', price: '1230' }), { touch: 1240, fill: 1240 }),
    ).toThrow(NotMarketableError)
    expect(() =>
      fillPrice(order({ type: 'limit', side: 'sell', price: '1250' }), { touch: 1240, fill: 1240 }),
    ).toThrow(NotMarketableError)
  })

  it('falls back to the order’s own price when it has been told no book', () => {
    expect(fillPrice(order(), null)).toBe(1250)
  })
})

describe('the mock venue', () => {
  const ACCOUNT = { accountIndex: 1, apiKeyIndex: 0, apiPublicKey: '0xab' }

  it('sends the leverage before the order, and only when it changes', async () => {
    const mocks = createMockAdapters()
    mocks.showBook({ touch: 1240, fill: 1240 })
    const buy = {
      market: 'ZEC',
      side: 'buy' as const,
      size: '1',
      type: 'market' as const,
      price: '1250',
      reduceOnly: false,
    }
    await mocks.lighter.setLeverage(ACCOUNT, 'ZEC', 500, 'isolated')
    await mocks.lighter.placeOrder(ACCOUNT, buy)
    expect(mocks.calls.leverage).toEqual([{ market: 'ZEC', initialMarginFraction: 500 }])
  })

  it('nets a close against the open position instead of stacking a second one', async () => {
    const mocks = createMockAdapters()
    mocks.showBook({ touch: 1240, fill: 1240 })
    const leg = (side: 'buy' | 'sell') => ({
      market: 'ZEC',
      side,
      size: '1',
      type: 'market' as const,
      price: side === 'buy' ? '1250' : '1230',
      reduceOnly: false,
    })
    await mocks.lighter.placeOrder(ACCOUNT, leg('buy'))
    expect(await mocks.lighter.positions(ACCOUNT)).toHaveLength(1)
    await mocks.lighter.placeOrder(ACCOUNT, leg('sell'))
    expect(await mocks.lighter.positions(ACCOUNT)).toEqual([])
  })

  it('averages the entry when adding to a side', async () => {
    const mocks = createMockAdapters()
    const buy = {
      market: 'ZEC',
      side: 'buy' as const,
      size: '1',
      type: 'market' as const,
      price: '9999',
      reduceOnly: false,
    }
    mocks.showBook({ touch: 1200, fill: 1200 })
    await mocks.lighter.placeOrder(ACCOUNT, buy)
    mocks.showBook({ touch: 1400, fill: 1400 })
    await mocks.lighter.placeOrder(ACCOUNT, buy)
    expect(Number((await mocks.lighter.positions(ACCOUNT))[0]!.entryPrice)).toBeCloseTo(1300, 6)
  })
})

describe('the market strip', () => {
  const market = (symbol: string, id: number, volume: number, status = 'active') =>
    ({ ...DETAILS, symbol, market_id: id, status, daily_quote_token_volume: volume }) as RawDetails

  it('ranks by the day’s quote volume, busiest first', () => {
    const ranked = rankMarkets(
      [market('SOL', 2, 56e6), market('BTC', 1, 863e6), market('ETH', 0, 445e6)],
      3,
    )
    expect(ranked.map((m) => m.symbol)).toEqual(['BTC', 'ETH', 'SOL'])
  })

  it('leaves out a market Lighter has not got running', () => {
    const ranked = rankMarkets([market('BTC', 1, 863e6), market('OLD', 7, 900e6, 'inactive')], 5)
    expect(ranked.map((m) => m.symbol)).toEqual(['BTC'])
  })

  it('keeps ZEC on the strip even on a quiet day', () => {
    // A product whose whole point is entering and leaving in Zcash cannot
    // have its own market fall off the picker when volume dips.
    const quiet = [
      market('BTC', 1, 863e6),
      market('ETH', 0, 445e6),
      market('SOL', 2, 56e6),
      market('ZEC', 90, 12),
    ]
    const ranked = rankMarkets(quiet, 3)
    expect(ranked).toHaveLength(3)
    expect(ranked[0]?.symbol).toBe('ZEC')
    expect(ranked.map((m) => m.symbol)).toContain('BTC')
  })

  it('does not push ZEC twice when it ranks on its own', () => {
    const ranked = rankMarkets([market('ZEC', 90, 900e6), market('BTC', 1, 863e6)], 2)
    expect(ranked.map((m) => m.symbol)).toEqual(['ZEC', 'BTC'])
  })
})

describe('the forming candle', () => {
  const bar = (at: number, close: number, high = close, low = close) => ({
    at,
    open: close,
    high,
    low,
    close,
    volume: 1,
  })

  it('moves the open candle with the last trade', () => {
    const next = withFormingCandle([bar(0, 10, 12, 9), bar(60, 11)], 14, '1m', 90_000)
    expect(next).toHaveLength(2)
    expect(next[1]).toMatchObject({ at: 60, open: 11, high: 14, low: 11, close: 14, volume: 1 })
  })

  it('opens the next candle when the interval elapses, and drops the oldest', () => {
    const next = withFormingCandle([bar(0, 10), bar(60, 12, 13, 10)], 12, '1m', 120_000)
    expect(next.map((k) => k.at)).toEqual([60, 120])
    expect(next[1]).toMatchObject({ open: 12, high: 12, low: 12, close: 12, volume: 0 })
  })

  it('does not invent a candle when there is no last price', () => {
    const history = [bar(60, 11)]
    expect(withFormingCandle(history, 0, '1m', 90_000)).toEqual(history)
  })

  it('counts a full interval at the open of a bucket', () => {
    expect(secondsUntilClose('1m', 90_000)).toBe(30)
    expect(secondsUntilClose('1m', 120_000)).toBe(60)
  })
})

describe('sparklines', () => {
  it('reads closes in time order, whatever order they arrive in', () => {
    const closes = parseSpark([
      { t: 300, o: 1, h: 1, l: 1, c: 3, v: 1 },
      { t: 100, o: 1, h: 1, l: 1, c: 1, v: 1 },
      { t: 200, o: 1, h: 1, l: 1, c: 2, v: 1 },
    ])
    expect(closes).toEqual([1, 2, 3])
  })

  it('drops a candle with no price rather than drawing a line to zero', () => {
    const closes = parseSpark([
      { t: 100, o: 1, h: 1, l: 1, c: 1200, v: 1 },
      { t: 200, o: 0, h: 0, l: 0, c: 0, v: 0 },
    ])
    expect(closes).toEqual([1200])
  })
})

describe('the recorded strip', () => {
  const cards = fixtureMarkets()

  it('carries nine markets, ZEC among them', () => {
    expect(cards).toHaveLength(9)
    expect(cards.map((c) => c.symbol)).toContain('ZEC')
  })

  it('has a full day of real closes for each one', () => {
    for (const card of cards) {
      expect(card.spark.length).toBe(24)
      expect(Math.min(...card.spark)).toBeGreaterThan(0)
    }
  })

  it('hands out a copy, so a caller cannot mutate the record', () => {
    expect(fixtureMarkets()[0]?.spark).not.toBe(cards[0]?.spark)
  })
})

describe('the mock wallet’s rotated addresses', () => {
  it('never repeats, even across a fresh set of adapters', async () => {
    // The linkability ledger lives in IndexedDB and outlives the tab. A
    // rotation counter restarting at 1 hands the next session an address the
    // last one already used, and `fresh_exit_address` then blocks the exit
    // for a reason that has nothing to do with the session being tested.
    const seen = new Set<string>()
    for (let run = 0; run < 3; run += 1) {
      const mocks = createMockAdapters()
      for (let i = 0; i < 4; i += 1) seen.add(await mocks.noir.freshReceiveAddress())
    }
    expect(seen.size).toBe(12)
  })

  it('still answers a unified address the checker will accept', async () => {
    const address = await createMockAdapters().noir.freshReceiveAddress()
    expect(address.startsWith('u1')).toBe(true)
    expect(address.length).toBeGreaterThanOrEqual(32)
  })
})
