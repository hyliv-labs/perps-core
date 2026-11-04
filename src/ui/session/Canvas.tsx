import { useState } from 'react'
import type { Session } from '@/core/session'
import type { Finding } from '@/core/checker'
import type { Position } from '@/adapters/types'
import { type Amount, formatAmount, parseAmount } from '@/core/types'
import { LABELS } from './Shell'

/**
 * The canvas answers the screen's one question: what is this session doing,
 * and what has to happen next.
 *
 * Every figure here is computed from the session or from a stated constant.
 * Nothing is typed in twice, so two panels cannot disagree.
 */

/**
 * Live figures: Lighter's fast withdrawal costs 1 USDC, and its smallest
 * withdrawal is also 1 USDC — a different thing, and not a cost.
 *
 * 1Click takes 0.25% a leg, or 0.20% with a JWT. Which one applies is a
 * property of the configuration, so the table takes it rather than naming
 * the better one and being wrong whenever the key is absent.
 */
export const SWAP_FEE_BPS_WITH_JWT = 20
export const SWAP_FEE_BPS_PUBLIC = 25
const WITHDRAWAL_USDC = 1
const GAS_USDC = 1
/** Quoted by 1Click on 2026-10-26. Replaced by the real quote once asked. */
const ZEC_USD = 1230.92

export interface Estimate {
  readonly arrives: number
  readonly swapFees: number
  readonly total: number
}

/** What a session of this size costs, from the parts as shown. */
export function estimate(zec: number, feeBps: number = SWAP_FEE_BPS_PUBLIC): Estimate {
  const gross = zec * ZEC_USD
  const inFee = (gross * feeBps) / 10_000
  const afterIn = gross - inFee
  const outFee = (afterIn * feeBps) / 10_000
  const swapFees = round2(inFee) + round2(outFee)
  return {
    arrives: round2(afterIn),
    swapFees: round2(swapFees),
    // Summed from the rounded parts the screen shows, not from the raw total.
    total: round2(round2(swapFees) + WITHDRAWAL_USDC + GAS_USDC),
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100
const usd = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/* --------------------------------------------------------------- the gate */

export function Gate({ findings, blocked }: { findings: readonly Finding[]; blocked: boolean }) {
  if (!findings.length) return null
  return (
    <section className="gate" aria-label="Checker">
      <p className="gate-head">
        <span className="meta">Checker</span>
        <span className={blocked ? 'verdict-no' : 'verdict-warn'}>
          {blocked ? 'Blocking this movement' : 'Allowing, with a warning'}
        </span>
      </p>
      <ul>
        {findings.map((f) => (
          <li key={f.rule}>
            <span className={f.severity === 'block' ? 'tag-no' : 'tag-warn'}>
              {f.severity === 'block' ? 'Stop' : 'Warn'}
            </span>
            <span>
              {f.message}
              <span className="meta-line">{f.remedy}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

/* ------------------------------------------------------------- the states */

export function StartPanel({
  notional,
  onNotional,
  onStart,
  busy,
  feeBps = SWAP_FEE_BPS_PUBLIC,
  gasIn = 'usdc',
}: {
  notional: string
  onNotional: (v: string) => void
  onStart: () => void
  busy: boolean
  /** 20 with a 1Click JWT, 25 without. */
  feeBps?: number
  /** Which coin gas actually comes out of, on this assembly. */
  gasIn?: 'usdc' | 'eth'
}) {
  const zec = Number(notional)
  const valid = Number.isFinite(zec) && zec > 0
  const e = valid ? estimate(zec, feeBps) : null

  return (
    <>
      <div className="field-row">
        <label htmlFor="amount">Amount to trade</label>
        <div className="input-unit">
          <input
            id="amount"
            value={notional}
            onChange={(e2) => onNotional(e2.target.value)}
            inputMode="decimal"
            aria-describedby="amount-help"
          />
          <span>ZEC</span>
        </div>
        <p className="meta" id="amount-help">
          It arrives as USDC on Arbitrum and leaves as Zcash again.
        </p>
      </div>

      <table className="figures">
        <caption className="visually-hidden">What this session costs</caption>
        <tbody>
          <tr>
            <th scope="row">Arrives to trade with</th>
            <td className="num">{e ? `${usd(e.arrives)} USDC` : '—'}</td>
          </tr>
          <tr>
            <th scope="row">Swap fees, both legs at {(feeBps / 100).toFixed(2)}%</th>
            <td className="num">{e ? `${usd(e.swapFees)} USDC` : '—'}</td>
          </tr>
          <tr>
            <th scope="row">Fast withdrawal</th>
            <td className="num">{usd(WITHDRAWAL_USDC)} USDC</td>
          </tr>
          <tr>
            {/* Naming the coin matters: in ETH it is not taken out of the
                figures above, it is money the wallet must already hold. */}
            <th scope="row">{gasIn === 'eth' ? 'Gas, paid in ETH' : 'Gas, paid in USDC'}</th>
            <td className="num">
              about {usd(GAS_USDC)} {gasIn === 'eth' ? 'USDC of ETH' : 'USDC'}
            </td>
          </tr>
          <tr className="figures-total">
            <th scope="row">Cost of the round trip</th>
            <td className="num">{e ? `${usd(e.total)} USDC` : '—'}</td>
          </tr>
        </tbody>
      </table>
      <p className="meta">
        The solver&rsquo;s spread on Zcash is not in this figure. It has not been measured
        yet, so putting a number on it would be inventing one.
      </p>

      <div className="actions">
        <button disabled={busy || !valid} onClick={onStart}>
          {busy ? 'Starting…' : 'Start session'}
        </button>
      </div>
    </>
  )
}

export function SwapPanel({
  session,
  leg,
  onPoll,
  busy,
}: {
  session: Session
  leg: 'in' | 'out'
  onPoll: () => void
  busy: boolean
}) {
  const swap = leg === 'in' ? session.swapIn : session.swapOut
  if (!swap) return <p className="meta">No quote yet.</p>
  const minutes = Math.max(0, Math.round((swap.deadline - Date.now()) / 60_000))

  return (
    <>
      <dl className="pairs">
        <div>
          <dt>Send to</dt>
          <dd className="mono break">{swap.depositAddress}</dd>
        </div>
        <div>
          <dt>Amount</dt>
          <dd className="num">{formatAmount(swap.amountIn)} {swap.amountIn.asset}</dd>
        </div>
        <div>
          <dt>At least</dt>
          <dd className="num">{formatAmount(swap.amountOutMin)} {swap.amountOutMin.asset}</dd>
        </div>
        <div>
          <dt>{leg === 'in' ? 'Refunds to your wallet in' : 'Refunds to the session wallet in'}</dt>
          <dd className="num">{minutes} min</dd>
        </div>
      </dl>
      <p className="meta">
        {leg === 'in'
          ? 'If it does not arrive in time the solver sends it back to your shielded address. Nothing is lost but the fee.'
          : 'If it lapses the USDC comes back to the session wallet and the exit is tried again.'}
      </p>
      <div className="actions">
        <button className="quiet" disabled={busy} onClick={onPoll}>
          {busy ? 'Checking…' : 'Check for it'}
        </button>
      </div>
    </>
  )
}

export function StepPanel({
  say,
  action,
  onAct,
  busy,
}: {
  say: string
  action: string
  onAct: () => void
  busy: boolean
}) {
  return (
    <>
      <p className="say">{say}</p>
      <div className="actions">
        <button disabled={busy} onClick={onAct}>
          {busy ? 'Working…' : action}
        </button>
      </div>
    </>
  )
}

/* -------------------------------------------------------------- trading */

export interface MarketRow {
  readonly symbol: string
  readonly marketId: number
  readonly minBase: string
  readonly minQuote: string
}

export function TradePanel({
  markets,
  positions,
  balance,
  onOrder,
  onEnd,
  busy,
}: {
  markets: readonly MarketRow[]
  positions: readonly Position[]
  balance: Amount | null
  onOrder: (order: { market: string; side: 'buy' | 'sell'; size: string }) => void
  onEnd: () => void
  busy: boolean
}) {
  const [market, setMarket] = useState(markets[0]?.symbol ?? '')
  const [side, setSide] = useState<'buy' | 'sell'>('buy')
  const [size, setSize] = useState('')
  const chosen = markets.find((m) => m.symbol === market)
  const tooSmall = chosen !== undefined && size !== '' && Number(size) < Number(chosen.minBase)

  return (
    <div className="trade">
      <section>
        <p className="panel-label">
          Balance
          <span className="num figure">
            {balance ? `${formatAmount(balance)} USDC` : '—'}
          </span>
        </p>

        <div className="field-row">
          <label htmlFor="market">Market</label>
          <select id="market" value={market} onChange={(e) => setMarket(e.target.value)}>
            {markets.map((m) => (
              <option key={m.symbol} value={m.symbol}>
                {m.symbol}
              </option>
            ))}
          </select>
        </div>

        <div className="field-row">
          <span id="side-label">Side</span>
          <div className="seg" role="group" aria-labelledby="side-label">
            <button
              type="button"
              className="seg-item"
              aria-pressed={side === 'buy'}
              onClick={() => setSide('buy')}
            >
              Long
            </button>
            <button
              type="button"
              className="seg-item"
              aria-pressed={side === 'sell'}
              onClick={() => setSide('sell')}
            >
              Short
            </button>
          </div>
        </div>

        <div className="field-row">
          <label htmlFor="size">Size</label>
          <div className="input-unit">
            <input
              id="size"
              value={size}
              onChange={(e) => setSize(e.target.value)}
              inputMode="decimal"
              aria-invalid={tooSmall}
              aria-describedby="size-help"
            />
            <span>{market}</span>
          </div>
          <p className="meta" id="size-help">
            {chosen ? `Lighter's smallest order is ${chosen.minBase} ${chosen.symbol}.` : ''}
          </p>
          {tooSmall && <p className="say-no">Below the minimum, so Lighter would refuse it.</p>}
        </div>

        <div className="actions">
          <button
            disabled={busy || !size || tooSmall}
            onClick={() => onOrder({ market, side, size })}
          >
            {busy ? 'Placing…' : `Place ${side === 'buy' ? 'long' : 'short'}`}
          </button>
          <button className="quiet" disabled={busy} onClick={onEnd}>
            End session
          </button>
        </div>
        <p className="meta">Lighter charges nothing to make or take.</p>
      </section>

      <section>
        <p className="panel-label">Open positions</p>
        {positions.length === 0 ? (
          <p className="empty">No positions open. The session is funded and waiting.</p>
        ) : (
          <table className="rows">
            <thead>
              <tr>
                <th scope="col">Market</th>
                <th scope="col" className="num">Size</th>
                <th scope="col" className="num">Entry</th>
                <th scope="col" className="num">Unrealised</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => {
                const pnl = Number(p.unrealizedPnl)
                return (
                  <tr key={p.market}>
                    <td>{p.market}</td>
                    <td className="num">{p.size}</td>
                    <td className="num">{p.entryPrice}</td>
                    {/* Grey on zero: a colour there would read as a direction. */}
                    <td className={`num ${pnl > 0 ? 'up' : pnl < 0 ? 'down' : ''}`}>
                      {pnl > 0 ? '+' : ''}
                      {p.unrealizedPnl}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}

export function ExitPanel({
  session,
  onCheck,
  onExit,
  busy,
}: {
  session: Session
  onCheck: () => void
  onExit: () => void
  busy: boolean
}) {
  const armed = session.exitNotBefore !== null
  const left = armed ? Math.max(0, Math.ceil((session.exitNotBefore! - Date.now()) / 60_000)) : null
  const open = armed && left === 0

  return (
    <>
      {!armed ? (
        <>
          <p className="say">
            Positions are closed and the withdrawal is on its way back to the session
            wallet. The exit delay starts when it lands, not when it was asked for.
          </p>
          <div className="actions">
            <button className="quiet" disabled={busy} onClick={onCheck}>
              {busy ? 'Checking…' : 'Check the withdrawal'}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="panel-label">
            Exit opens in
            <span className="num figure">{left} min</span>
          </p>
          <p className="say">
            The wait is deliberate. Leaving the moment the money lands would pair the two
            legs by timing alone, so the checker refuses until it has passed.
          </p>
          <div className="actions">
            <button disabled={busy || !open} onClick={onExit}>
              {open ? 'Swap out to Zcash' : 'Waiting'}
            </button>
          </div>
        </>
      )}
    </>
  )
}

export function ClosedPanel({ session }: { session: Session }) {
  const back = session.swapOut?.settledAmount
  const went = session.notional
  return (
    <>
      <dl className="pairs">
        <div>
          <dt>Went in</dt>
          <dd className="num">{formatAmount(went)} ZEC</dd>
        </div>
        <div>
          <dt>Came back</dt>
          <dd className="num">{back ? `${formatAmount(back)} ZEC` : '—'}</dd>
        </div>
        <div>
          <dt>Key {session.keyIndex}</dt>
          <dd>retired, and never used again</dd>
        </div>
        <div>
          <dt>Dust left behind</dt>
          <dd>never swept, on purpose</dd>
        </div>
      </dl>
      <p className="meta">
        Collecting the residue later would join this session to the next one, so it stays
        where it is.
      </p>
    </>
  )
}

export function titleFor(session: Session | null): string {
  return session ? LABELS[session.state] : 'Ready'
}

export { parseAmount }
