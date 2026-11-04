import { useEffect, useMemo, useState } from 'react'
import type { NetworkAdapter, Position } from '@/adapters/types'
import type { Logger } from '@/core/log'
import { type Amount, formatAmount } from '@/core/types'
import { Chart } from './Chart'
import { MarketStrip } from './Markets'
import {
  createMarketData,
  ZEC_MARKET_ID,
  type Candle,
  type MarketCard,
  imfFromLeverage,
  liquidationPrice,
  maxLeverage,
  minimumSize,
  slippageBound,
  untilFunding,
  sweep,
  type Book,
  type MarketSnapshot,
  type Ticker,
} from '@/adapters/lighter/market'
import { FIXTURE_CAPTURED_AT, fixtureMarkets, fixtureSnapshot } from '@/adapters/lighter/fixture'

/**
 * The trading window: Lighter's nine busiest perps, ZEC first.
 *
 * The strip across the top is both the picture and the picker. It stands
 * where a price chart stands on an ordinary exchange, and it earns that room
 * by doing two jobs at once: a day of real hourly closes for each market, and
 * the control that chooses which one the book and the ticket below describe.
 *
 * ZEC keeps its place on the strip whatever its volume rank, because it is
 * the market this product exists for: the session enters and leaves in
 * shielded Zcash. Trading something else leaves a basis to carry home, which
 * is the trader's call to make and not the screen's to prevent.
 *
 * Every figure comes from Lighter's own API. Orders are simulated until the
 * signer runs against a funded account, and the window says so rather than
 * letting a live price lend credibility to a mock fill.
 */

const DEFAULT_SLIPPAGE_BPS = 50
const POLL_DIRECT_MS = 4_000
/** Nym pays a latency cost per request, so it is polled far less often. */
const POLL_MIXNET_MS = 20_000
/** The strip's prices: nine reads, so a slower clock than the book's. */
const POLL_STRIP_MS = 30_000
/** Hourly candles do not change within the hour. */
const POLL_SPARK_MS = 300_000
/** How long the strip waits so the chart and the book get the wire first. */
const STRIP_DELAY_MS = 600
/** And how long after that the 400kB ranking read goes. */
const RANK_DELAY_MS = 1_500
/** How many markets the strip carries. Nine fits one row at desktop width. */
export const STRIP_MARKETS = 9

export interface TradeProps {
  readonly network: NetworkAdapter | null
  readonly logger: Logger
  readonly balance: Amount | null
  readonly positions: readonly Position[]
  readonly busy: boolean
  readonly simulated: boolean
  onOrder(order: {
    /** Which market, now that the strip can change it. */
    market: string
    side: 'buy' | 'sell'
    size: string
    /** What is signed: the limit, or the worst price a market sweep may reach. */
    price: string
    /** What the book would actually give, which is not the same number. */
    expectedFill: string
    /** The best price on this side, which is what a limit must cross to fill. */
    touch: string
    /** The margin fraction to set before the order, not a leverage multiple. */
    imf: number
    type: 'limit' | 'market'
  }): void
  onEnd(): void
  /** Dev preview and tests draw these instead of reading the network. */
  readonly snapshot?: MarketSnapshot
  readonly markets?: readonly MarketCard[]
  readonly candles?: readonly Candle[]
}

export function TradeWindow(props: TradeProps) {
  const [chosen, setChosen] = useState(ZEC_MARKET_ID)
  const live = useMarket(props.network, props.logger, chosen, props.snapshot, props.markets)
  const market = props.snapshot ?? live.snapshot

  return (
    <div className="tw">
      <MarketStrip
        markets={live.markets}
        selected={chosen}
        live={market ? { last: market.ticker.last, changePct: market.ticker.changePct } : null}
        onSelect={setChosen}
        busy={props.busy}
      />
      {/* Above the floor, not in it. As a child of the grid the header
          became a fourth column and pushed the ticket onto a second row,
          six hundred pixels below where it belongs. */}
      {market && (
        <Header
          ticker={market.ticker}
          funding={market.fundingRate}
          stale={market.stale}
          failing={live.error}
        />
      )}

      {/* The chart asks for its candles the moment the screen opens.
          Rendering it inside Window made it wait for the book first, which
          put the one slow, visible thing last in a queue of twenty. */}
      <div className="tw-floor">
        <Chart
          network={props.network}
          logger={props.logger}
          marketId={chosen}
          priceDecimals={market?.ticker.priceDecimals ?? 3}
          last={market?.ticker.last ?? 0}
          entry={entryOf(props.positions)}
          {...(props.candles ? { given: props.candles } : {})}
        />
        {market ? (
          <Window
            {...props}
            key={market.ticker.marketId}
            market={market}
            failing={live.error}
            onSelect={setChosen}
          />
        ) : (
          <p className="empty tw-waiting">
            {live.error ?? 'Reading the book from Lighter…'}
          </p>
        )}
      </div>
    </div>
  )
}

function Window({
  network,
  logger,
  candles,
  market,
  balance,
  positions,
  busy,
  simulated,
  onOrder,
  onEnd,
  failing,
}: TradeProps & {
  market: MarketSnapshot
  failing: string | null
  onSelect: (marketId: number) => void
}) {
  const { ticker, book } = market
  const [type, setType] = useState<'market' | 'limit'>('market')
  const [side, setSide] = useState<'buy' | 'sell'>('buy')
  const [size, setSize] = useState('')
  const [limit, setLimit] = useState('')
  const [leverage, setLeverage] = useState(2)
  const [depthTab, setDepthTab] = useState<'book' | 'trades'>('book')

  const cap = maxLeverage(ticker)
  const collateral = balance ? Number(formatAmount(balance)) : 0
  const touch = (side === 'buy' ? book.asks[0]?.price : book.bids[0]?.price) ?? ticker.mark
  const reference = type === 'limit' && Number(limit) > 0 ? Number(limit) : touch

  const wanted = Number(size)
  const valid = Number.isFinite(wanted) && wanted > 0
  const floor = minimumSize(ticker, reference)
  // A limit order does not sweep the book, so it is not quoted against one.
  const filled = valid && type === 'market' ? sweep(book, side, wanted) : null

  const entry = type === 'limit' ? reference : (filled?.averagePrice ?? reference)
  const notional = valid ? wanted * entry : 0
  const liquidation = valid ? liquidationPrice(entry, leverage, side, ticker) : null

  /**
   * Margin is checked on the position this order LEAVES, not on the order.
   *
   * Charging every order its own margin would let Max be clicked twice for
   * twice the size, and would then refuse a sell that reduces a long — an
   * order that frees margin rather than spending it.
   */
  const held = positions.reduce((t, p) => t + Number(p.size), 0)
  const resulting = held + (side === 'buy' ? 1 : -1) * (valid ? wanted : 0)
  const marginUsed = (Math.abs(resulting) * entry) / leverage
  /** What the collateral would still carry after what is already open. */
  const free = Math.max(0, collateral - (Math.abs(held) * entry) / leverage)

  /** The size that brings the resulting position to exactly the collateral. */
  const most = (() => {
    if (reference <= 0 || collateral <= 0) return 0
    const room = (price: number) => {
      const cap = (collateral * leverage) / price
      return Math.max(0, side === 'buy' ? cap - held : cap + held)
    }
    const atTouch = room(reference)
    if (type === 'limit' || atTouch <= 0) return atTouch
    // Re-sized at what that size would really average, which only shrinks it.
    return room(sweep(book, side, atTouch)?.averagePrice ?? reference)
  })()

  // The price actually signed: the limit, or the bound a market sweep may reach.
  const signedPrice =
    type === 'limit'
      ? reference.toFixed(ticker.priceDecimals)
      : slippageBound(
          filled?.worstPrice ?? touch,
          side,
          DEFAULT_SLIPPAGE_BPS,
          ticker.priceDecimals,
        )

  const problem = market.stale
    ? 'This is a recorded book, not a live one, so no order can be priced against it.'
    : failing
    ? 'The last read of the book failed, so this one may be out of date. Nothing will be sent against it.'
    : orderProblem({
        valid,
        size: wanted,
        floor,
        ticker,
        filled,
        marginUsed,
        collateral,
        type,
        limit,
        touch,
        side,
      })

  void failing
  return (
    <>
      <>
        {/* Book and tape share a column as tabs, the way an exchange does:
            they answer the same question at two speeds, and only one is
            being read at a time. */}
        <div className="tw-middle">
          <div className="tw-tabs" role="group" aria-label="Book or trades">
            {(['book', 'trades'] as const).map((t) => (
              <button
                key={t}
                type="button"
                className="tw-tab"
                aria-pressed={depthTab === t}
                onClick={() => setDepthTab(t)}
              >
                {t === 'book' ? 'Order book' : 'Trades'}
              </button>
            ))}
          </div>
          {depthTab === 'book' ? (
            <BookPanel book={book} ticker={ticker} />
          ) : (
            <Tape trades={market.trades} ticker={ticker} />
          )}
        </div>

        {/* The ticket, in the order an exchange puts it: side, then type,
            then what you have, then what you are asking for, then what it
            will cost. */}
        <section className="tw-ticket" aria-label="Order">
          <div className="seg tw-sides" role="group" aria-label="Side">
            <button
              type="button"
              className="seg-item"
              data-side="buy"
              aria-pressed={side === 'buy'}
              onClick={() => setSide('buy')}
            >
              Buy / Long
            </button>
            <button
              type="button"
              className="seg-item"
              data-side="sell"
              aria-pressed={side === 'sell'}
              onClick={() => setSide('sell')}
            >
              Sell / Short
            </button>
          </div>

          <div className="tw-tabs" role="group" aria-label="Order type">
            {(['market', 'limit'] as const).map((t) => (
              <button
                key={t}
                type="button"
                className="tw-tab"
                aria-pressed={type === t}
                onClick={() => setType(t)}
              >
                {t === 'market' ? 'Market' : 'Limit'}
              </button>
            ))}
          </div>

          <dl className="tw-have">
            <div>
              <dt>Available to trade</dt>
              <dd className="num">{usd(free)} USDC</dd>
            </div>
            <div>
              <dt>Position</dt>
              <dd className={`num ${held > 0 ? 'up' : held < 0 ? 'down' : ''}`}>
                {held === 0 ? '—' : `${held > 0 ? '+' : ''}${held.toFixed(ticker.sizeDecimals)}`}
              </dd>
            </div>
          </dl>

          {type === 'limit' && (
            <div className="tw-input">
              <label htmlFor="tw-limit">Limit price</label>
              <div className="input-unit">
                <input
                  id="tw-limit"
                  value={limit}
                  placeholder={touch.toFixed(ticker.priceDecimals)}
                  onChange={(e) => setLimit(e.target.value)}
                  inputMode="decimal"
                />
                {/* The mid, which is what a maker usually wants to start from. */}
                <button
                  type="button"
                  className="tw-mid"
                  onClick={() => setLimit(book.mid.toFixed(ticker.priceDecimals))}
                >
                  Mid
                </button>
              </div>
            </div>
          )}

          <div className="tw-input">
            <label htmlFor="tw-size">Amount</label>
            <div className="input-unit">
              <input
                id="tw-size"
                value={size}
                placeholder="0.000"
                onChange={(e) => setSize(e.target.value)}
                inputMode="decimal"
                aria-invalid={problem !== null}
                aria-describedby="tw-size-help"
              />
              <span>{ticker.symbol}</span>
            </div>
          </div>

          <Fractions most={most} decimals={ticker.sizeDecimals} onPick={setSize} />

          <div className="tw-input">
            <label htmlFor="tw-lev">
              Leverage <span className="num tw-lev-value">{leverage}×</span>
              <span className="meta"> · isolated, to {cap}×</span>
            </label>
            <input
              id="tw-lev"
              className="tw-range"
              type="range"
              min={1}
              max={cap}
              step={1}
              value={leverage}
              onChange={(e) => setLeverage(Number(e.target.value))}
            />
          </div>

          <div className="actions">
            <button
              className={`tw-send ${side}`}
              disabled={busy || problem !== null || !valid}
              onClick={() =>
                onOrder({
                  market: ticker.symbol,
                  side,
                  size,
                  price: signedPrice,
                  expectedFill: entry.toFixed(ticker.priceDecimals),
                  touch: touch.toFixed(ticker.priceDecimals),
                  imf: imfFromLeverage(leverage, ticker),
                  type,
                })
              }
            >
              {busy ? 'Placing…' : `${side === 'buy' ? 'Buy / Long' : 'Sell / Short'} ${ticker.symbol}`}
            </button>
            <button className="quiet" disabled={busy} onClick={onEnd}>
              Close out and exit
            </button>
          </div>

          {/* Below the actions, so a refusal never pushes the button away. */}
          {problem && <p className="say-no">{problem}</p>}

          <dl className="tw-costs">
            <div>
              <dt>Order size</dt>
              <dd className="num">{valid ? `${wanted.toFixed(ticker.sizeDecimals)} ${ticker.symbol}` : '—'}</dd>
            </div>
            <div>
              <dt>Order value</dt>
              <dd className="num">{valid ? `${usd(notional)} USDC` : '—'}</dd>
            </div>
            {type === 'market' && (
              <div>
                <dt>
                  Fills at about
                  {filled && <span className="meta"> · {filled.impactBps.toFixed(2)} bp in</span>}
                </dt>
                <dd className="num">
                  {valid && filled ? filled.averagePrice.toFixed(ticker.priceDecimals) : '—'}
                </dd>
              </div>
            )}
            <div>
              <dt>
                {type === 'limit' ? 'Limit price' : `Worst price, ${DEFAULT_SLIPPAGE_BPS / 100}% bound`}
              </dt>
              <dd className="num">{valid ? signedPrice : '—'}</dd>
            </div>
            <div>
              <dt>Est. liquidation</dt>
              <dd className="num">{liquidation ? liquidation.toFixed(ticker.priceDecimals) : '—'}</dd>
            </div>
            <div>
              {/* With something already open this is the margin the account
                  would be carrying afterwards, not the order's own share. */}
              <dt>{held !== 0 ? 'Position margin, after this' : 'Position margin'}</dt>
              <dd className="num">{valid ? `${usd(marginUsed)} USDC` : '—'}</dd>
            </div>
            <div>
              <dt>Fees</dt>
              <dd className="num">
                Taker {ticker.takerFee.toFixed(2)}% · Maker {ticker.makerFee.toFixed(2)}%
              </dd>
            </div>
          </dl>

          <p className="meta" id="tw-size-help">
            Smallest now {floor.toFixed(ticker.sizeDecimals)} {ticker.symbol} —{' '}
            {floor > ticker.minBase
              ? `Lighter's ${ticker.minQuote} USDC floor, not its ${ticker.minBase} ${ticker.symbol} one`
              : `Lighter's ${ticker.minBase} ${ticker.symbol} floor`}
            .{simulated && ' Orders here are simulated: no signer has touched a funded account yet.'}
          </p>
        </section>

        <div className="tw-below">
          <Positions positions={positions} ticker={ticker} book={book} simulated={simulated} />
        </div>
      </>
    </>
  )
}

/** An open position's entry, for the line the chart draws at it. */
function entryOf(positions: readonly Position[]): number | null {
  const open = positions.find((p) => Number(p.size) !== 0)
  return open ? Number(open.entryPrice) || null : null
}

/* ----------------------------------------------------------------- header */

function Header({
  ticker,
  funding,
  stale,
  failing,
}: {
  ticker: Ticker
  funding: number | null
  stale: boolean
  failing: string | null
}) {
  // A countdown that only moved when the book was polled would sit still for
  // four seconds at a time and then jump.
  useTick(1000)
  // Grey at a flat day: a colour on zero would read as a direction.
  const dir = ticker.changePct > 0 ? 'up' : ticker.changePct < 0 ? 'down' : ''
  return (
    <header className="tw-head">
      <div className="tw-pair">
        <p className="tw-symbol">
          {ticker.symbol}&#8209;USDC <span className="meta">perpetual · Lighter</span>
        </p>
        <p className="tw-last">
          <span className="num">{ticker.last.toFixed(ticker.priceDecimals)}</span>
          {/* Colour on the change, which is a direction; never on the price. */}
          <span className={`num tw-change ${dir}`}>
            {ticker.changePct > 0 ? '+' : ''}
            {ticker.changePct.toFixed(2)}%
          </span>
        </p>
      </div>

      <dl className="tw-stats">
        <Stat label="Mark" value={ticker.mark.toFixed(ticker.priceDecimals)} />
        <Stat label="Index" value={ticker.index.toFixed(ticker.priceDecimals)} />
        <Stat
          label="1h funding"
          value={funding === null ? '—' : `${funding > 0 ? '+' : ''}${(funding * 100).toFixed(4)}%`}
        />
        <Stat label="Next funding" value={countdown(untilFunding())} />
        <Stat label="24h high" value={ticker.high.toFixed(ticker.priceDecimals)} />
        <Stat label="24h low" value={ticker.low.toFixed(ticker.priceDecimals)} />
        <Stat label="24h volume" value={`${compact(ticker.quoteVolume)} USDC`} />
        <Stat label="Open interest" value={`${compact(ticker.openInterestUsd)} USDC`} />
      </dl>

      <p className="meta tw-note">
        {stale
          ? `A recorded book, captured ${FIXTURE_CAPTURED_AT}. Not live prices.`
          : failing
            ? `Last good read is being shown; the live read failed: ${failing}`
            : 'Live from Lighter.'}
      </p>
    </header>
  )
}

/** Re-render on a clock, for the one figure that is a clock. */
function useTick(every: number) {
  const [, bump] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => bump((n) => n + 1), every)
    return () => clearInterval(timer)
  }, [every])
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className="num">{value}</dd>
    </div>
  )
}

/* ------------------------------------------------------------------- book */

function BookPanel({ book, ticker }: { book: Book; ticker: Ticker }) {
  const deepest = Math.max(
    book.asks[book.asks.length - 1]?.total ?? 0,
    book.bids[book.bids.length - 1]?.total ?? 0,
    1e-9,
  )

  return (
    <section className="tw-book" aria-label="Order book">
      <table className="tw-levels" aria-label="Asks">
        <caption className="visually-hidden">Asks, best first</caption>
        <thead>
          <tr>
            <th className="tw-depth" aria-hidden="true" />
            <th scope="col" className="tw-price">Price</th>
            <th scope="col">Size, {ticker.symbol}</th>
            <th scope="col">Total</th>
          </tr>
        </thead>
        <tbody>
          {[...book.asks].reverse().map((l) => (
            <Row key={`a${l.price}`} level={l} deepest={deepest} ticker={ticker} side="ask" />
          ))}
        </tbody>
      </table>

      <p className="tw-spread">
        <span className="num">{book.mid.toFixed(ticker.priceDecimals)}</span>
        <span className="meta">
          spread {book.spread.toFixed(ticker.priceDecimals)} ·{' '}
          {((book.spread / book.mid) * 10_000).toFixed(1)} bp
        </span>
      </p>

      <table className="tw-levels" aria-label="Bids">
        <caption className="visually-hidden">Bids, best first</caption>
        <tbody>
          {book.bids.map((l) => (
            <Row key={`b${l.price}`} level={l} deepest={deepest} ticker={ticker} side="bid" />
          ))}
        </tbody>
      </table>
    </section>
  )
}

function Row({
  level,
  deepest,
  ticker,
  side,
}: {
  level: { price: number; size: number; total: number }
  deepest: number
  ticker: Ticker
  side: 'ask' | 'bid'
}) {
  return (
    <tr data-side={side}>
      {/* The depth bar is the data, drawn to scale against the deepest level. */}
      <td className="tw-depth">
        <span style={{ width: `${Math.min(100, (level.total / deepest) * 100)}%` }} />
      </td>
      <td className={`num tw-price ${side === 'ask' ? 'down' : 'up'}`}>
        {level.price.toFixed(ticker.priceDecimals)}
      </td>
      <td className="num">{level.size.toFixed(ticker.sizeDecimals)}</td>
      <td className="num meta">{level.total.toFixed(ticker.sizeDecimals)}</td>
    </tr>
  )
}

/* -------------------------------------------------------------- positions */

function Positions({
  positions,
  ticker,
  book,
  simulated,
}: {
  positions: readonly Position[]
  ticker: Ticker
  book: Book
  simulated: boolean
}) {
  return (
    <section aria-label="Positions">
      <p className="panel-label">
        Position
        {simulated && <span className="meta">simulated</span>}
      </p>
      {positions.length === 0 ? (
        <p className="empty">Flat. The session is funded and nothing is open.</p>
      ) : (
        <table className="rows">
          <thead>
            <tr>
              <th scope="col">Side</th>
              <th scope="col" className="num">Size</th>
              <th scope="col" className="num">Value</th>
              <th scope="col" className="num">Entry</th>
              <th scope="col" className="num">Mark</th>
              <th scope="col" className="num">Liquidation</th>
              <th scope="col" className="num">Unrealised</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((p) => {
              const size = Number(p.size)
              const entry = Number(p.entryPrice)
              // Lighter's own figure when it reports one; otherwise marked
              // against the live book, which is all the simulator can give.
              const reported = Number(p.unrealizedPnl)
              const exit = (size > 0 ? book.bids[0]?.price : book.asks[0]?.price) ?? ticker.mark
              const pnl = reported !== 0 ? reported : (exit - entry) * size
              return (
                <tr key={p.market}>
                  <td>{size > 0 ? 'Long' : 'Short'}</td>
                  <td className="num">{Math.abs(size).toFixed(ticker.sizeDecimals)}</td>
                  <td className="num">{usd(Math.abs(size) * ticker.mark)}</td>
                  <td className="num">{entry.toFixed(ticker.priceDecimals)}</td>
                  <td className="num">{ticker.mark.toFixed(ticker.priceDecimals)}</td>
                  <td className="num">
                    {p.liquidationPrice ? Number(p.liquidationPrice).toFixed(ticker.priceDecimals) : '—'}
                  </td>
                  {/* Grey at zero: a colour there would read as a direction. */}
                  <td className={`num ${pnl > 0 ? 'up' : pnl < 0 ? 'down' : ''}`}>
                    {pnl > 0 ? '+' : ''}
                    {usd(pnl)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </section>
  )
}

function Tape({
  trades,
  ticker,
}: {
  trades: readonly { price: number; size: number; at: number; side: 'buy' | 'sell' }[]
  ticker: Ticker
}) {
  return (
    <section aria-label="Recent trades">
      <p className="panel-label">
        <span className="meta">Taker side</span>
        <span className="meta">{ticker.dailyTrades.toLocaleString('en-US')} in 24h</span>
      </p>
      <table className="rows tw-tape">
        <thead>
          <tr>
            <th scope="col">Price</th>
            <th scope="col" className="num">Size</th>
            <th scope="col" className="num">Time</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t, i) => (
            <tr key={`${t.at}-${i}`}>
              <td className={`num ${t.side === 'buy' ? 'up' : 'down'}`}>
                {t.price.toFixed(ticker.priceDecimals)}
              </td>
              <td className="num">{t.size.toFixed(ticker.sizeDecimals)}</td>
              <td className="num meta">{clock(t.at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

/* ------------------------------------------------------------------ parts */

function Fractions({
  most,
  decimals,
  onPick,
}: {
  /** The largest size the free margin carries at the price it would fill at. */
  most: number
  decimals: number
  onPick: (size: string) => void
}) {
  return (
    <div className="tw-fractions" role="group" aria-label="Fraction of the balance">
      {[0.25, 0.5, 0.75, 1].map((f) => (
        <button
          key={f}
          type="button"
          className="seg-item"
          disabled={most <= 0}
          onClick={() => onPick(floorTo(most * f, decimals).toFixed(decimals))}
        >
          {f === 1 ? 'Max' : `${f * 100}%`}
        </button>
      ))}
    </div>
  )
}

/** The one reason this order cannot go, said plainly. */
function orderProblem(a: {
  valid: boolean
  size: number
  floor: number
  ticker: Ticker
  filled: ReturnType<typeof sweep>
  marginUsed: number
  collateral: number
  type: 'market' | 'limit'
  limit: string
  touch: number
  side: 'buy' | 'sell'
}): string | null {
  if (a.type === 'limit' && (!a.limit || Number(a.limit) <= 0)) {
    return 'A limit order needs a price. Lighter refuses an order priced at zero.'
  }
  if (a.type === 'limit') {
    // Said before the click, not after it: the touch is already on screen.
    const price = Number(a.limit)
    const marketable = a.side === 'buy' ? price >= a.touch : price <= a.touch
    if (!marketable) {
      return `That would rest on the book rather than fill, and resting orders are not simulated. ${a.side === 'buy' ? 'Bid at or above' : 'Offer at or below'} ${a.touch.toFixed(a.ticker.priceDecimals)}.`
    }
  }
  if (!a.valid) return null
  if (a.size < a.floor) {
    return `Below ${a.floor.toFixed(a.ticker.sizeDecimals)} ${a.ticker.symbol}, so Lighter would refuse it: both its ${a.ticker.minBase} ${a.ticker.symbol} and its ${a.ticker.minQuote} USDC floors apply.`
  }
  if (a.filled && !a.filled.fillable) {
    return 'The visible book is not deep enough for this size, so the fill cannot be quoted.'
  }
  if (a.collateral > 0 && a.marginUsed > a.collateral) {
    return `That would leave a position needing ${usd(a.marginUsed)} USDC of margin, and the session holds ${usd(a.collateral)}.`
  }
  return null
}

/* --------------------------------------------------------------- the feed */

interface Feed {
  readonly snapshot: MarketSnapshot | null
  readonly markets: readonly MarketCard[]
  readonly error: string | null
}

/**
 * Poll the market over the session's own network adapter.
 *
 * REST rather than a WebSocket, because mixFetch carries no socket: a window
 * that only worked on the clear network would be the wrong window for this
 * product. The mixnet is polled far more slowly for the same reason.
 *
 * Three cadences, because the three things cost very different amounts:
 *
 *   - the selected market, often: four small reads, the book among them;
 *   - the strip's nine prices, rarely: nine reads of under 2kB each, rather
 *     than the one 400kB call that would fetch all 241 ungzipped;
 *   - the sparklines, rarest: hourly candles do not change within the hour.
 *
 * The ranking itself is read once when the screen opens and never again.
 *
 * A failed read keeps the last good snapshot and reports the failure, rather
 * than blanking a book someone may be reading.
 */
export function useMarket(
  network: NetworkAdapter | null,
  logger: Logger,
  marketId: number,
  given: MarketSnapshot | undefined,
  givenMarkets: readonly MarketCard[] | undefined,
): Feed {
  const [snapshot, setSnapshot] = useState<MarketSnapshot | null>(null)
  const [markets, setMarkets] = useState<readonly MarketCard[]>([])
  const [error, setError] = useState<string | null>(null)

  const feed = useMemo(
    () => (network ? createMarketData({ network, logger }) : null),
    [network, logger],
  )

  /* The selected market, on the fast loop. */
  useEffect(() => {
    if (given || !feed || !network) return
    // A ref would be shared across mounts, so a remount revives the previous
    // run's cancelled read. This flag belongs to one run of the effect.
    let live = true
    const every = network.kind === 'nym' ? POLL_MIXNET_MS : POLL_DIRECT_MS

    const read = async () => {
      try {
        const next = await feed.snapshot(marketId)
        if (!live) return
        setSnapshot(next)
        setError(null)
      } catch (caught) {
        if (!live) return
        setError(caught instanceof Error ? caught.message : String(caught))
        // Nothing read yet, so show the record rather than an empty window.
        setSnapshot((held) => held ?? fixtureSnapshot())
      }
    }

    void read()
    const timer = setInterval(() => void read(), every)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [feed, network, given, marketId])

  /* The strip: ranked once, then prices and sparklines on their own clocks. */
  useEffect(() => {
    if (givenMarkets || !feed || !network) return
    let live = true
    const slow = network.kind === 'nym' ? POLL_STRIP_MS * 3 : POLL_STRIP_MS

    const prices = async (cards: readonly MarketCard[]) => {
      const fresh = await Promise.all(
        cards.map(async (card) => {
          try {
            return { ...card, ...(await feed.card(card.marketId)) }
          } catch {
            // One card failing is not a reason to blank the other eight.
            return card
          }
        }),
      )
      if (live) setMarkets(fresh)
    }

    const sparks = async (cards: readonly MarketCard[]) => {
      const drawn = await Promise.all(
        cards.map(async (card) => {
          try {
            return { ...card, spark: await feed.spark(card.marketId) }
          } catch {
            return card
          }
        }),
      )
      if (live) setMarkets(drawn)
    }

    let priceTimer: ReturnType<typeof setInterval> | undefined
    let sparkTimer: ReturnType<typeof setInterval> | undefined

    /**
     * Draw the strip from the record first, then correct it.
     *
     * Ranking means reading all 241 markets — about 400kB, ungzipped — and
     * the sparklines follow it. Waiting for both leaves nine empty boxes
     * where the picture is supposed to be, for seconds at a time on a
     * mixnet. So the recorded nine are drawn at once and their live prices
     * fetched straight away; the ranking runs alongside and swaps the list
     * only if it has actually changed.
     *
     * The seeded cards show no price until a live one arrives. A recorded
     * shape is honest as a shape; a recorded price passed off as the
     * current one is not.
     */
    const seed = fixtureMarkets().map((m) => ({ ...m, last: 0, changePct: 0 }))
    setMarkets(seed)

    const follow = (cards: readonly MarketCard[]) => {
      priceTimer = setInterval(() => void prices(cards), slow)
      sparkTimer = setInterval(() => void sparks(cards), POLL_SPARK_MS)
    }

    /*
     * Let the chart and the book go first.
     *
     * The strip wants nine card reads and a 400kB ranking read. Fired at
     * mount they race the two things somebody is actually waiting to see,
     * and the chart — the slowest and most visible of them — ends up last in
     * a queue of twenty. The strip already has its shape from the record, so
     * it can afford to be second.
     */
    const warmup = setTimeout(() => void prices(seed), STRIP_DELAY_MS)
    const ranking = setTimeout(() => void correct(), STRIP_DELAY_MS + RANK_DELAY_MS)

    const correct = async () => {
      try {
        const ranked = await feed.rank(STRIP_MARKETS)
        if (!live) return
        const same =
          ranked.length === seed.length &&
          ranked.every((m, i) => m.marketId === seed[i]?.marketId)
        if (!same) {
          setMarkets(ranked)
          void prices(ranked)
        }
        // Live sparklines last of all: the recorded ones are the same shape
        // of the same day, and nine candle reads are not worth the queue.
        void sparks(same ? seed : ranked)
        follow(same ? seed : ranked)
      } catch (caught) {
        logger.debug('lighter ranking failed', {
          why: caught instanceof Error ? caught.message : String(caught),
        })
        // The strip is a picker, not the trade. The record still picks.
        if (live) follow(seed)
      }
    }

    return () => {
      live = false
      clearTimeout(warmup)
      clearTimeout(ranking)
      if (priceTimer) clearInterval(priceTimer)
      if (sparkTimer) clearInterval(sparkTimer)
    }
  }, [feed, network, givenMarkets, logger])

  return { snapshot, markets: givenMarkets ?? markets, error }
}

/* ----------------------------------------------------------------- format */

const usd = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const compact = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : n.toFixed(0)

const floorTo = (n: number, dp: number) => {
  const f = 10 ** dp
  return Math.floor(n * f) / f
}

const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString('en-GB', { hour12: false })

/** mm:ss until the next hourly funding settles. */
const countdown = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 1000))
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}
