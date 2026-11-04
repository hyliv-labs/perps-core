import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SessionStore } from '@/core/store'
import type { SessionState } from '@/core/session'
import type { NetworkAdapter } from '@/adapters/types'
import { generateRecoveryPhrase, openWithPhrase, type Vault } from '@/core/keys'
import { createMockAdapters } from '@/adapters/mock'
import { SessionScreen } from './SessionScreen'

/**
 * The states a preview may be driven to.
 *
 * The last two need the exit delay to have passed — ten to ninety minutes,
 * chosen at random. The preview reaches them by moving the clock the
 * orchestrator and checker read, not by skipping the rule: the rule still
 * runs, and still refuses when the clock says it should.
 */
const STATES = [
  'new',
  'swap_in_pending',
  'funded',
  'converted',
  'trading',
  'withdrawing',
  'swap_out_pending',
  'closed',
] as const satisfies readonly SessionState[]

/**
 * A development-only way to look at the session screen.
 *
 * The screen sits behind a vault, which makes it impossible to photograph
 * for a design review without unlocking one by hand. This opens a throwaway
 * vault so the screen can be seen. It is imported only where
 * `import.meta.env.DEV` guards it, so it is absent from a built app.
 */
export function PreviewScreen({
  store,
  network,
  state,
  onBack,
}: {
  store: SessionStore
  network: NetworkAdapter | null
  state: string
  onBack: (e: React.MouseEvent<HTMLAnchorElement>) => void
}) {
  const [vault, setVault] = useState<Vault | null>(null)
  /** How far ahead of the wall clock this preview is running. */
  const [skew, setSkew] = useState(0)
  // The ref is the clock, not a mirror of the state. A skew that only landed
  // on the next render would arrive after the step that asked for it.
  const skewRef = useRef(0)

  // A stable identity, so changing the skew does not rebuild the orchestrator
  // underneath a session that is halfway through being driven.
  const clock = useCallback(() => Date.now() + skewRef.current, [])

  /**
   * The simulator, built here and nowhere else.
   *
   * This file is the only thing that imports the mocks, and it is only
   * reached in a development build — so a production bundle has no fake
   * venue in it at all, and no switch that could put one in front of real
   * money.
   */
  const mocks = useMemo(() => createMockAdapters({ now: clock }), [clock])
  const skipTo = useCallback((notBefore: number) => {
    const needed = notBefore - (Date.now() + skewRef.current) + 1_000
    if (needed <= 0) return
    skewRef.current += needed
    setSkew(skewRef.current)
  }, [])

  useEffect(() => {
    // Straight from a phrase, with no lock around it. Locking and then
    // unlocking ran PBKDF2-SHA512 twice at 600,000 iterations — about a
    // second of the main thread before the screen could ask for anything,
    // to protect a vault that is thrown away when the tab closes.
    setVault(openWithPhrase(generateRecoveryPhrase()))
  }, [])

  if (!vault) return <div className="app" />
  // `?preview=trading` walks a throwaway session up to that state, so every
  // panel can be photographed and not only the one the screen opens on.
  const target = STATES.find((s) => s === state)
  return (
    <SessionScreen
      store={store}
      vault={vault}
      network={network}
      demoOverride
      onBack={onBack}
      clock={clock}
      onSkip={skipTo}
      onNetwork={() => {}}
      onDemoOverride={() => {}}
      stubAdapters={mocks}
      stub={mocks}
      settings={
        <SkipControl
          skew={skew}
          onSkip={() => {
            skewRef.current += 10 * 60_000
            setSkew(skewRef.current)
          }}
        />
      }
      {...(target ? { driveTo: target } : {})}
    >
    </SessionScreen>
  )
}

/**
 * The preview's clock, and the one honest way to test a ten-minute wait.
 *
 * It is dev-only, like the rest of this file, and it says how far ahead it
 * has moved so nobody mistakes a shifted clock for a passed delay.
 */
function SkipControl({ skew, onSkip }: { skew: number; onSkip: () => void }) {
  return (
    <section className="net" aria-label="Preview clock">
      <div className="net-head">
        <span className="net-label">Preview clock</span>
        <span className="net-verdict" data-state="overridden">
          {skew === 0 ? 'real time' : `${Math.round(skew / 60_000)} min ahead`}
        </span>
      </div>
      <p className="net-say">
        The exit delay is ten to ninety minutes. This moves the clock the checker
        reads, so the rule still runs and still refuses until the time it is
        shown has passed.
      </p>
      <div className="actions">
        <button className="ghost" onClick={onSkip}>
          Move on ten minutes
        </button>
      </div>
    </section>
  )
}
