import type { Session, SessionState } from '@/core/session'
import type { NetworkAdapter } from '@/adapters/types'
import { verdictState } from '../NetworkPanel'

/**
 * The shell: a mark, a scope, and the state ladder.
 *
 * The ladder is this product's own structure rather than a menu. It is the
 * navigation and the signature element at once: eight named states, where
 * the session is now, and what it has left to pass through.
 */

export const ORDER: readonly SessionState[] = [
  'new',
  'swap_in_pending',
  'funded',
  'converted',
  'trading',
  'withdrawing',
  'swap_out_pending',
  'closed',
]

export const LABELS: Record<SessionState, string> = {
  new: 'Ready',
  swap_in_pending: 'Zcash in',
  funded: 'Funded',
  converted: 'Gas ready',
  trading: 'Trading',
  withdrawing: 'Withdrawing',
  swap_out_pending: 'Zcash out',
  closed: 'Closed',
  refunding: 'Refunding',
  failed: 'Stopped',
}

/** A trail of three dashes going cold. Drawn for the name, not a letter in a box. */
export function Mark() {
  return (
    <svg className="mark" width="26" height="12" viewBox="0 0 26 12" aria-hidden="true">
      <rect x="0" y="5" width="8" height="2" rx="1" fill="currentColor" />
      <rect x="11" y="5" width="6" height="2" rx="1" fill="currentColor" opacity="0.55" />
      <rect x="20" y="5" width="4" height="2" rx="1" fill="currentColor" opacity="0.25" />
    </svg>
  )
}

export function TopBar({
  network,
  keyIndex,
  demoOverride,
  onBack,
  onConnection,
  connectionOpen,
  refusals,
}: {
  network: NetworkAdapter | null
  keyIndex: number
  demoOverride: boolean
  onBack: (e: React.MouseEvent<HTMLAnchorElement>) => void
  /** Opens the connection panel. The bar is the one place on every screen. */
  onConnection: () => void
  connectionOpen: boolean
  /** How many live movements will refuse, so the mark is not buried. */
  refusals: number
}) {
  // The bar and the panel read the same value, so they cannot disagree.
  const state = network ? verdictState(network, demoOverride) : null
  return (
    <header className="bar">
      <a className="bar-brand" href="/" onClick={onBack}>
        <Mark />
        <span>Private Perps</span>
      </a>
      <div className="bar-scope">
        <span className="meta">Key</span>
        <span className="figure-sm">{keyIndex}</span>
        <span className="bar-sep" aria-hidden="true" />
        {/*
         * The connection is a control, not a label.
         *
         * It used to be a panel in the canvas, which the trading floor then
         * hid to win back its height — leaving someone who was already
         * trading on a clear connection with no way to reach Tor or Nym at
         * all. The bar is on every screen and costs no room, so it lives
         * here now and the canvas never has to choose.
         */}
        <button
          type="button"
          className="bar-connection"
          aria-expanded={connectionOpen}
          aria-haspopup="dialog"
          onClick={onConnection}
        >
          <span className="meta">Connection</span>
          <span className={`dot-${state ?? 'none'}`} aria-hidden="true" />
          <span className="figure-sm">
            {state === 'private'
              ? network!.kind
              : state === 'overridden'
                ? 'overridden'
                : state === 'open'
                  ? 'open'
                  : '—'}
          </span>
          {refusals > 0 && (
            <span className="bar-refusals">
              {refusals}
              <span className="visually-hidden"> movements will refuse</span>
            </span>
          )}
        </button>
      </div>
    </header>
  )
}

export function Ladder({
  session,
  network,
  demoOverride,
}: {
  session: Session | null
  network: NetworkAdapter | null
  demoOverride: boolean
}) {
  const state = session?.state ?? 'new'
  const reached = ORDER.indexOf(state)
  const offPath = state === 'refunding' || state === 'failed'

  return (
    <nav className="ladder" aria-label="Session progress">
      <p className="ladder-head">Session</p>
      <ol>
        {ORDER.map((s, i) => {
          const done = !offPath && reached > i
          const here = state === s
          return (
            <li key={s} data-here={here} data-done={done}>
              <span className="ladder-rule" aria-hidden="true" />
              {LABELS[s]}
              {here && <span className="visually-hidden"> (current)</span>}
            </li>
          )
        })}
        {offPath && (
          <li data-here="true" data-off="true">
            <span className="ladder-rule" aria-hidden="true" />
            {LABELS[state]}
          </li>
        )}
      </ol>

      {session && (
        <dl className="ladder-facts">
          <div>
            <dt>Funds are</dt>
            <dd>{custodyWords(session)}</dd>
          </div>
          <div>
            <dt>Key</dt>
            <dd className="num">{session.keyIndex}</dd>
          </div>
          {/* The trading floor hides the connection panel to win back its
              height, so the verdict is kept here, from the same source. */}
          {network && (
            <div>
              <dt>Connection</dt>
              <dd>
                <span
                  className={`dot-${verdictState(network, demoOverride)}`}
                  aria-hidden="true"
                />{' '}
                {connectionWords(network, demoOverride)}
              </dd>
            </div>
          )}
        </dl>
      )}
    </nav>
  )
}

/** The same three states the bar names, in words that fit a narrow column. */
function connectionWords(network: NetworkAdapter, demoOverride: boolean): string {
  switch (verdictState(network, demoOverride)) {
    case 'private':
      return network.assurance === 'verified' ? `${network.kind}, verified` : `${network.kind}, asserted`
    case 'overridden':
      return 'open, overridden'
    default:
      return 'not private'
  }
}

function custodyWords(session: Session): string {
  switch (session.custody) {
    case 'user_shielded':
      return 'in your wallet'
    case 'near_solver':
      return 'with the solver'
    case 'session_wallet':
      return 'in the session wallet'
    case 'lighter':
      return 'on Lighter'
    default:
      return 'being reconciled'
  }
}
