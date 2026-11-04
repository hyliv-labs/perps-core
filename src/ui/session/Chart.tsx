import { useEffect, useMemo, useState } from 'react'
import type { NetworkAdapter } from '@/adapters/types'
import type { Logger } from '@/core/log'
import {
  RESOLUTIONS,
  candleBucket,
  createMarketData,
  secondsUntilClose,
  withFormingCandle,
  type Candle,
  type Resolution,
} from '@/adapters/lighter/market'

/**
 * The price chart: real candles from Lighter's `/api/v1/candles`.
 *
 * Drawn by hand rather than pulled from a charting library, for one reason
 * that matters here: every third-party chart widget this product could embed
 * loads its own script and talks to its own servers, which is precisely the
 * thing the network adapter exists to prevent. A chart that quietly phoned
 * home would undo the checker.
 *
 * The geometry is in viewBox units and the labels are HTML beside the SVG,
 * so the drawing can stretch to any width without stretching any text.
 */

const BARS = 90
/**
 * How often the exchange series is re-read. The candle that is still open
 * does not wait for this: it follows the last trade, and the clock.
 */
const POLL_MS = 20_000
const W = 1000
const PRICE_H = 260
const VOLUME_H = 56
const GAP = 10
const H = PRICE_H + GAP + VOLUME_H

export function Chart({
  network,
  logger,
  marketId,
  priceDecimals,
  last,
  entry,
  given,
}: {
  network: NetworkAdapter | null
  logger: Logger
  marketId: number
  priceDecimals: number
  /** The live last price, so the marker agrees with the header. */
  last: number
  /** An open position's entry, drawn where a trader looks for it. */
  entry: number | null
  /** Dev preview and tests draw these instead of reading the network. */
  given?: readonly Candle[]
}) {
  const [resolution, setResolution] = useState<Resolution>('15m')
  const [candles, setCandles] = useState<readonly Candle[]>(given ?? [])
  const [failed, setFailed] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [hover, setHover] = useState<number | null>(null)

  const feed = useMemo(
    () => (network ? createMarketData({ network, logger }) : null),
    [network, logger],
  )
  useEffect(() => {
    if (given || !feed) return
    // A ref would be shared across mounts, so a remount revives the previous
    // run's cancelled read. This flag belongs to one run of the effect.
    let live = true
    const read = async () => {
      try {
        const next = await feed.candles(marketId, resolution, BARS)
        if (!live) return
        setCandles(next)
        setFailed(false)
      } catch {
        if (live) setFailed(true)
      }
    }
    void read()
    const timer = setInterval(() => void read(), POLL_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [feed, marketId, resolution, given])

  // The open candle closes on the clock, even in a second when no trade prints.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  const shown = useMemo(
    () => (given ? candles : withFormingCandle(candles, last, resolution, now)),
    [given, candles, last, resolution, now],
  )
  const hovered = hover !== null ? shown[hover] : undefined
  const forming = shown[shown.length - 1]
  const formingNow =
    !given &&
    forming !== undefined &&
    candleBucket(forming.at, resolution) === candleBucket(Math.floor(now / 1000), resolution)

  return (
    <section className="chart" aria-label="Price chart">
      <div className="chart-bar">
        <div className="seg chart-res" role="group" aria-label="Candle size">
          {RESOLUTIONS.map((r) => (
            <button
              key={r}
              type="button"
              className="seg-item"
              aria-pressed={resolution === r}
              onClick={() => setResolution(r)}
            >
              {r}
            </button>
          ))}
        </div>
        <Latest
          candle={hovered ?? forming}
          decimals={priceDecimals}
          resolution={resolution}
          countdown={hovered || !formingNow ? null : secondsUntilClose(resolution, now)}
        />
      </div>

      {shown.length < 2 ? (
        <p className="empty chart-empty">
          {failed ? 'The candles could not be read.' : 'Reading candles from Lighter…'}
        </p>
      ) : (
        <Plot
          candles={shown}
          decimals={priceDecimals}
          last={last}
          entry={entry}
          resolution={resolution}
          hover={hover}
          onHover={setHover}
        />
      )}
    </section>
  )
}

/** The candle under the pointer, or the one still forming: time, then O H L C. */
function Latest({
  candle,
  decimals,
  resolution,
  countdown,
}: {
  candle: Candle | undefined
  decimals: number
  resolution: Resolution
  /** Seconds left in the open candle. Absent while a past candle is shown. */
  countdown: number | null
}) {
  if (!candle) return null
  const up = candle.close >= candle.open
  return (
    <p className="chart-ohlc">
      <span>
        <span className="num">{formatCandleTime(candle.at, resolution)}</span>
        {countdown !== null && <span className="meta chart-clock">{formatLeft(countdown)}</span>}
      </span>
      {[
        ['O', candle.open],
        ['H', candle.high],
        ['L', candle.low],
        ['C', candle.close],
      ].map(([label, value]) => (
        <span key={label as string}>
          <span className="meta">{label}</span>
          <span className={`num ${up ? 'up' : 'down'}`}>
            {(value as number).toFixed(decimals)}
          </span>
        </span>
      ))}
      <span>
        <span className="meta">Vol</span>
        <span className="num">{compact(candle.volume)}</span>
      </span>
    </p>
  )
}

function Plot({
  candles,
  decimals,
  last,
  entry,
  resolution,
  hover,
  onHover,
}: {
  candles: readonly Candle[]
  decimals: number
  last: number
  entry: number | null
  resolution: Resolution
  hover: number | null
  onHover: (index: number | null) => void
}) {
  const scale = useMemo(() => build(candles, last, entry), [candles, last, entry])
  const step = W / candles.length
  // Leave a hair between candles, and never let one vanish at 90 bars.
  const body = Math.max(step * 0.62, 1.2)

  return (
    <div
      className="chart-plot"
      onPointerMove={(event) => {
        const box = event.currentTarget.querySelector('svg')?.getBoundingClientRect()
        if (!box || box.width <= 0) return
        const x = event.clientX - box.left
        const index = Math.min(
          candles.length - 1,
          Math.max(0, Math.floor((x / box.width) * candles.length)),
        )
        onHover(index)
      }}
      onPointerLeave={() => onHover(null)}
    >
      <svg
        className="chart-svg"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {scale.lines.map((y) => (
          <line key={y} className="chart-grid" x1="0" x2={W} y1={y} y2={y} />
        ))}

        {candles.map((k, i) => {
          const x = i * step + step / 2
          const up = k.close >= k.open
          const top = scale.y(Math.max(k.open, k.close))
          const bottom = scale.y(Math.min(k.open, k.close))
          return (
            <g key={k.at} className={up ? 'up' : 'down'}>
              <line className="chart-wick" x1={x} x2={x} y1={scale.y(k.high)} y2={scale.y(k.low)} />
              <rect
                className="chart-body"
                x={x - body / 2}
                y={top}
                width={body}
                height={Math.max(bottom - top, 1)}
              />
              <rect
                className="chart-vol"
                x={x - body / 2}
                y={H - scale.v(k.volume)}
                width={body}
                height={scale.v(k.volume)}
              />
            </g>
          )
        })}

        {hover !== null && (
          <line
            className="chart-cross"
            x1={hover * step + step / 2}
            x2={hover * step + step / 2}
            y1={0}
            y2={PRICE_H}
          />
        )}

        {/* Where the market is now, and where this session got in. */}
        <line className="chart-last" x1="0" x2={W} y1={scale.y(last)} y2={scale.y(last)} />
        {entry !== null && (
          <line className="chart-entry" x1="0" x2={W} y1={scale.y(entry)} y2={scale.y(entry)} />
        )}
      </svg>

      {/* Labels are HTML, so stretching the drawing never stretches text. */}
      <div className="chart-axis">
        {scale.ticks.map((p) => (
          <span key={p} className="num" style={{ top: `${(scale.y(p) / H) * 100}%` }}>
            {p.toFixed(decimals)}
          </span>
        ))}
        <span className="num chart-axis-last" style={{ top: `${(scale.y(last) / H) * 100}%` }}>
          {last.toFixed(decimals)}
        </span>
      </div>

      <div className="chart-times">
        {ticks(candles, resolution).map((t) => (
          <span key={t.at} style={{ left: `${t.at * 100}%` }}>
            {t.label}
          </span>
        ))}
      </div>
    </div>
  )
}

/* ----------------------------------------------------------------- scales */

function build(candles: readonly Candle[], last: number, entry: number | null) {
  let low = Math.min(...candles.map((k) => k.low), last)
  let high = Math.max(...candles.map((k) => k.high), last)
  // An entry far outside the window would otherwise flatten every candle.
  if (entry !== null && entry > low * 0.85 && entry < high * 1.15) {
    low = Math.min(low, entry)
    high = Math.max(high, entry)
  }
  const pad = (high - low) * 0.08 || high * 0.01 || 1
  low -= pad
  high += pad
  const span = high - low || 1

  const biggest = Math.max(...candles.map((k) => k.volume), 1)
  const y = (p: number) => ((high - p) / span) * PRICE_H
  const tickValues = [0, 0.25, 0.5, 0.75, 1].map((f) => high - span * f)

  return {
    y,
    v: (vol: number) => (vol / biggest) * VOLUME_H,
    ticks: tickValues,
    lines: tickValues.map(y),
  }
}

/** Four times across the bottom, spaced evenly through the candles shown. */
function ticks(candles: readonly Candle[], resolution: Resolution) {
  const out: { at: number; label: string }[] = []
  for (const f of [0, 0.33, 0.66, 0.99]) {
    const k = candles[Math.min(candles.length - 1, Math.floor(f * candles.length))]
    if (!k) continue
    out.push({ at: f, label: formatCandleTime(k.at, resolution) })
  }
  return out
}

const compact = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : n.toFixed(2)

function stamp(at: number): number {
  return at > 1e12 ? at : at * 1000
}

function formatCandleTime(at: number, resolution: Resolution): string {
  const when = new Date(stamp(at))
  if (resolution === '1d' || resolution === '4h') {
    return when.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
  }
  return when.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })
}

/** `4:12`, or `2h 05m` once the candle is longer than an hour. */
function formatLeft(seconds: number): string {
  const s = Math.max(0, seconds)
  if (s >= 3600) {
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    return `${h}h ${String(m).padStart(2, '0')}m`
  }
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}
