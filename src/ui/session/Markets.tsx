import type { MarketCard } from '@/adapters/lighter/market'

/**
 * The market strip: the busiest nine perps on Lighter, and the picker.
 *
 * It sits where a price chart would on an ordinary exchange. A chart of one
 * market tells you where that market has been; this tells you where nine have
 * been AND lets you choose between them, in the same space. Lighter's candles
 * are real OHLCV, so each line is drawn from hourly closes rather than
 * suggested by a shape.
 *
 * One row, not a page of cards. A browse page can spend 300px on this; a
 * trading screen cannot, because every pixel here pushes the order ticket
 * towards the bottom of the window.
 */
export function MarketStrip({
  markets,
  selected,
  live,
  onSelect,
  busy,
}: {
  markets: readonly MarketCard[]
  selected: number
  /**
   * The selected market's price from the fast loop.
   *
   * The strip refreshes every thirty seconds and the book every four, so
   * without this the card and the header beneath it show the same market at
   * two different prices. One of them would be wrong, and a reader has no
   * way to tell which.
   */
  live: { last: number; changePct: number } | null
  onSelect: (marketId: number) => void
  busy: boolean
}) {
  if (markets.length === 0) {
    return (
      <div className="strip" aria-hidden="true">
        {Array.from({ length: 9 }, (_, i) => (
          <div key={i} className="strip-card strip-waiting" />
        ))}
      </div>
    )
  }

  return (
    <div className="strip" role="radiogroup" aria-label="Market">
      {markets.map((card) => {
        const here = card.marketId === selected
        const m = here && live ? { ...card, ...live } : card
        // Grey at a flat day: a colour on zero would read as a direction.
        const dir = m.changePct > 0 ? 'up' : m.changePct < 0 ? 'down' : ''
        return (
          <button
            key={m.marketId}
            type="button"
            className="strip-card"
            role="radio"
            aria-checked={here}
            disabled={busy && !here}
            onClick={() => onSelect(m.marketId)}
          >
            <span className="strip-head">
              <span className="strip-symbol">{m.symbol}</span>
              {/* A seeded card has no price yet, and says so rather than
                  showing the recorded one as though it were current. */}
              <span className={`strip-change num ${dir}`}>
                {m.last > 0 ? `${m.changePct > 0 ? '+' : ''}${m.changePct.toFixed(2)}%` : ''}
              </span>
            </span>
            <span className="strip-last num">{m.last > 0 ? price(m.last) : '—'}</span>
            <Spark points={m.spark} dir={dir} />
          </button>
        )
      })}
    </div>
  )
}

/**
 * A day of hourly closes.
 *
 * Scaled to its own range rather than to zero, because every one of these
 * lines would otherwise be flat: a 1% day on a 79,000 price is invisible
 * against a zero baseline. The figure above it carries the absolute level,
 * so the line is free to carry only the shape.
 */
function Spark({ points, dir }: { points: readonly number[]; dir: string }) {
  const W = 132
  const H = 26
  if (points.length < 2) return <span className="strip-spark-none" aria-hidden="true" />

  const low = Math.min(...points)
  const high = Math.max(...points)
  const span = high - low || 1
  const step = W / (points.length - 1)
  const at = (p: number, i: number) => `${(i * step).toFixed(2)},${(H - ((p - low) / span) * (H - 2) - 1).toFixed(2)}`

  const line = points.map(at).join(' ')
  const area = `0,${H} ${line} ${W},${H}`

  return (
    <svg
      className={`strip-spark ${dir}`}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <polygon points={area} />
      <polyline points={line} />
    </svg>
  )
}

/** Lighter's markets run from fractions of a cent to eighty thousand dollars. */
function price(n: number): string {
  const dp = n >= 1000 ? 2 : n >= 1 ? 3 : 5
  return n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })
}
