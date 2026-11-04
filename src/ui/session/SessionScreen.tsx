import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Session, SessionState } from '@/core/session'
import type { Finding } from '@/core/checker'
import type { Adapters, NetworkAdapter, Position } from '@/adapters/types'
import type { Vault } from '@/core/keys'
import type { LighterAccount } from '@/core/session'
import type { SessionStore } from '@/core/store'
import { cannotRoundTrip, createRealAdapters, notReady, type RealAdapters } from '@/adapters/real'
import { configGaps, pickRpc, readConfig, type AppConfig } from '@/core/config'
import { askRefundAddress, createBrowserPrompts } from './prompts'
import { createLogger, consoleSink } from '@/core/log'
import { CheckerBlockedError, createOrchestrator, nextKeyIndex } from '@/orchestrator/orchestrator'
import { type Amount, type ShieldedAddress, parseAmount } from '@/core/types'
import { Ladder, TopBar } from './Shell'
import { Popover } from './Popover'
import { NetworkPanel } from '../NetworkPanel'
import { TradeWindow } from './Trade'
import {
  ClosedPanel,
  ExitPanel,
  Gate,
  SWAP_FEE_BPS_PUBLIC,
  SWAP_FEE_BPS_WITH_JWT,
  StartPanel,
  StepPanel,
  SwapPanel,
  titleFor,
} from './Canvas'

/**
 * The session screen.
 *
 * One question: what is this session doing, and what has to happen next.
 * The canvas shows only the current step's work; the ladder on the left
 * carries where that step sits among the eight.
 */

const DEMO_REFUND = `u1${'r'.repeat(40)}` as ShieldedAddress

export function SessionScreen({
  store,
  vault,
  network,
  demoOverride,
  onNetwork,
  onDemoOverride,
  settings,
  onBack,
  driveTo,
  clock,
  onSkip,
  stubAdapters,
  stub,
  children,
}: {
  store: SessionStore
  vault: Vault
  network: NetworkAdapter | null
  demoOverride: boolean
  onBack: (e: React.MouseEvent<HTMLAnchorElement>) => void
  /** Changing the connection, from wherever the session happens to be. */
  onNetwork: (network: NetworkAdapter) => void
  onDemoOverride: (on: boolean) => void
  /** Anything else that belongs in the same panel, such as the adapter switch. */
  settings?: React.ReactNode
  /** Dev preview only: run the session forward to this state on mount. */
  driveTo?: SessionState
  /**
   * Dev preview only: the clock the orchestrator, the checker and the mocks
   * all read.
   *
   * Shifting it is not the same as skipping a rule. `exit_delay_elapsed`
   * still runs and still refuses; it simply sees a later time, which is the
   * only honest way to test a ten-minute wait without waiting ten minutes.
   */
  clock?: () => number
  /** Dev preview only: asked to move the clock past an exit that is pending. */
  onSkip?: (notBefore: number) => void
  /**
   * The preview's hand on the simulator: settle a swap, refund one, or tell
   * it what book the window is reading. Absent in a built app, because
   * there is no simulator in one.
   */
  stub?: {
    settleSwaps(): void
    refundSwaps(): void
    showBook(book: { touch: number; fill: number } | null): void
  }
  /**
   * Adapters to use instead of the real ones.
   *
   * Only the development preview passes this. A built app has no mock to
   * pass: the module is not in the bundle, so there is no switch anywhere
   * that could quietly put fake numbers in front of real money.
   */
  stubAdapters?: Adapters
  children?: React.ReactNode
}) {
  const [session, setSession] = useState<Session | null>(null)
  const [findings, setFindings] = useState<readonly Finding[]>([])
  const [blocked, setBlocked] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [notional, setNotional] = useState('1')
  const [positions, setPositions] = useState<readonly Position[]>([])
  /**
   * What leverage each market is already set to, so it is sent only on a
   * change. Keyed by market, because Lighter stores it per market.
   */
  const leverageSent = useRef(new Map<string, number>())

  const logger = useMemo(() => createLogger(consoleSink, { app: 'coldtrail' }), [])
  const config: AppConfig = useMemo(readConfig, [])

  /**
   * The connection as the checker will see it, override included.
   *
   * The override only applies when the simulator is driving. It was written
   * when every session ran on mocks and "ignore this for the demo" could not
   * cost anything; once the real adapters became the default, the same
   * checkbox would have let real ZEC move over the clear network — the one
   * thing the checker exists to prevent. It is a demo affordance, so it is
   * confined to the demo.
   */
  /*
   * ...and the one case where it applies to real money: a local end-to-end
   * run. `unsafeLiveTest` is dev-only and folded out of every build, so this
   * cannot reach a deployed page. See `AppConfig.unsafeLiveTest`.
   */
  const canOverride = Boolean(stubAdapters) || config.unsafeLiveTest
  const effectiveNetwork = useMemo(() => {
    if (!network) return null
    return canOverride && demoOverride && !network.isPrivate
      ? ({ ...network, isPrivate: true, assurance: 'asserted' } as NetworkAdapter)
      : network
  }, [network, demoOverride, canOverride])

  /**
   * The real adapters, built for this session's own key.
   *
   * Per session rather than per app, because the gas adapter signs with the
   * session key and there is no such thing as an app-wide one. Before a
   * session exists the next index is used, which is the key it will get.
   */
  /*
   * The same index `create` will use, not an approximation of it.
   *
   * `vault.nextIndex()` alone is a lower bound: after a reload the ledger
   * can hold a higher one, and `create` takes the max. Showing the wallet
   * for the lower index while the session is opened at the higher one means
   * the ETH someone sent to pay for gas is in a wallet nothing will open.
   */
  const [nextIndex, setNextIndex] = useState<number | null>(null)
  useEffect(() => {
    let alive = true
    void nextKeyIndex(store, vault).then((i) => {
      if (alive) setNextIndex(i)
    })
    return () => {
      alive = false
    }
    // Recomputed after each session change, which is when the ledger moves.
  }, [store, vault, session?.id])
  const keyIndex = session?.keyIndex ?? nextIndex ?? vault.nextIndex()
  const [real, setReal] = useState<RealAdapters | null>(null)
  const [liveError, setLiveError] = useState<string | null>(null)
  const [connectionOpen, setConnectionOpen] = useState(false)

  useEffect(() => {
    const rpcUrl = pickRpc(config.rpcUrls, keyIndex)
    if (stubAdapters || !effectiveNetwork || !rpcUrl) {
      setReal(null)
      return
    }
    let alive = true
    const key = vault.deriveSessionKey(keyIndex)
    setLiveError(null)
    void createRealAdapters({
      network: effectiveNetwork,
      logger,
      account: key.account,
      rpcUrl,
      noirPrompts: createBrowserPrompts(config.zcashNetwork),
      zcashNetwork: config.zcashNetwork,
      /*
       * The Lighter API key, derived on demand from the same vault and the
       * same index as the session's EVM key — but on its own branch, so the
       * 7.7 MB third-party signer never sees a key that can move funds on
       * Arbitrum. Deriving it per call means it is wiped straight after.
       */
      lighterApiKey: () => vault.deriveLighterKey(keyIndex),
      ...(config.oneClickJwt ? { oneClickJwt: config.oneClickJwt } : {}),
      ...(config.bundlerUrl ? { bundlerUrl: config.bundlerUrl } : {}),
      ...(config.paymasterAddress ? { paymasterAddress: config.paymasterAddress } : {}),
      ...(config.delegateAddress ? { delegateAddress: config.delegateAddress } : {}),
      ...(clock ? { now: clock } : {}),
    })
      .then((built) => {
        if (alive) setReal(built)
        else key.retire()
      })
      .catch((caught: unknown) => {
        if (!alive) return
        key.retire()
        setLiveError(caught instanceof Error ? caught.message : String(caught))
      })
    return () => {
      alive = false
      // The old adapters are being discarded, so the key they hold goes too.
      key.retire()
    }
  }, [stubAdapters, effectiveNetwork, config, logger, vault, keyIndex, clock])

  /**
   * What the session actually runs on.
   *
   * The preview's stubs when it supplies them, the real adapters otherwise.
   * There is no third case and no fallback: an app that silently dropped
   * back to fakes when a venue was unreachable would be the worst of both.
   */
  const adapters: Adapters | null = useMemo(() => {
    if (stubAdapters) {
      return effectiveNetwork ? { ...stubAdapters, network: effectiveNetwork } : stubAdapters
    }
    return real?.adapters ?? null
  }, [stubAdapters, real, effectiveNetwork])

  /**
   * No adapters, no orchestrator.
   *
   * Nothing can move before the venues are reachable, and there is nothing
   * to fall back to: the panel below says what is missing and the work area
   * stays empty until it is fixed.
   */
  const orchestrator = useMemo(
    () =>
      adapters
        ? createOrchestrator({ adapters, store, vault, logger, ...(clock ? { now: clock } : {}) })
        : null,
    [adapters, store, vault, logger, clock],
  )

  useEffect(() => {
    if (!orchestrator) return
    void orchestrator.resume().then((open) => {
      if (open[0]) setSession(open[0])
    })
  }, [orchestrator])

  /**
   * Walk a throwaway session up to a state so that state can be photographed.
   *
   * It drives the real orchestrator through the real machine against the
   * mocks, so a preview cannot show a screen the product cannot reach.
   */
  const driven = useRef<SessionState | null>(null)
  useEffect(() => {
    // Vite folds this to `false` in a build, so the whole walk-forward
    // harness is eliminated rather than shipped as unreachable code.
    if (!import.meta.env.DEV) return
    if (!driveTo || !orchestrator) return
    // One session per page load. StrictMode runs this effect twice, and two
    // sessions racing means the second one's exit address collides with the
    // first's in the linkability ledger — which `fresh_exit_address` then
    // refuses, correctly, for a reason that has nothing to do with the test.
    if (driven.current === driveTo) return
    driven.current = driveTo
    void (async () => {
      const usdc = (s: Session) => s.swapIn?.settledAmount ?? parseAmount('USDC', '0')
      let s = await orchestrator.create(parseAmount('ZEC', '1'))
      const steps: readonly [SessionState, () => Promise<Session>][] = [
        ['new', async () => orchestrator.fund(s.id, DEMO_REFUND)],
        ['swap_in_pending', async () => (stub?.settleSwaps(), orchestrator.pollSwap(s.id, 'in'))],
        ['funded', async () => orchestrator.setupGas(s.id)],
        ['converted', async () => orchestrator.openLighter(s.id, usdc(s))],
        ['trading', async () => orchestrator.endTrading(s.id, usdc(s))],
        [
          'withdrawing',
          async () => {
            const settled = await orchestrator.pollWithdrawal(s.id, usdc(s))
            // The exit delay is real and still enforced; the preview moves
            // the clock past it rather than pretending the rule is not there.
            if (settled.state === 'withdrawing' && settled.exitNotBefore) {
              onSkip?.(settled.exitNotBefore)
              return settled
            }
            return settled
          },
        ],
        ['withdrawing', async () => orchestrator.exit(s.id, usdc(s))],
        [
          'swap_out_pending',
          async () => (stub?.settleSwaps(), orchestrator.pollSwap(s.id, 'out')),
        ],
      ]
      for (const [from, step] of steps) {
        if (s.state === driveTo) break
        if (s.state !== from) break
        s = await step()
        setSession(s)
      }
    })().catch((caught) => {
      setError(caught instanceof Error ? caught.message : String(caught))
    })
    // No cleanup: a cancelled drive plus a guarded remount means nobody
    // drives at all. This is a one-shot dev harness, so it simply finishes.
  }, [driveTo, orchestrator, stub, onSkip])

  const run = useCallback(
    async (what: string, action: () => Promise<Session>) => {
      setBusy(true)
      setError(null)
      setFindings([])
      setBlocked(false)
      try {
        setSession(await action())
      } catch (caught) {
        if (caught instanceof CheckerBlockedError) {
          setFindings(caught.report.findings)
          setBlocked(true)
          setError(null)
        } else {
          setError(caught instanceof Error ? caught.message : String(caught))
        }
      } finally {
        setBusy(false)
      }
    },
    [],
  )

  /** The mocks settle on demand; a real adapter would be polled. */
  const settle = () => {
    stub?.settleSwaps()
    return session
  }

  /**
   * Place an order and read the position back.
   *
   * It goes through the adapter rather than being held in the screen, so the
   * day the real signer is configured this path is already the right one.
   */
  const place = useCallback(
    async (
      account: LighterAccount | null,
      order: {
        market: string
        side: 'buy' | 'sell'
        size: string
        price: string
        expectedFill: string
        touch: string
        imf: number
        type: 'limit' | 'market'
      },
    ) => {
      if (!account) {
        setError('No Lighter account on this session yet.')
        return
      }
      // The same rule the checker applies to every other movement. An order
      // is a message to an exchange about this session, so it does not get
      // to leave over a connection nothing else may leave over.
      if (!adapters || (adapters.network && !adapters.network.isPrivate)) {
        setError('This connection is not private, so no order will be sent.')
        return
      }

      setBusy(true)
      setError(null)
      try {
        // Only the simulator needs this; a real fill comes back from Lighter.
        stub?.showBook({ touch: Number(order.touch), fill: Number(order.expectedFill) })

        // Leverage is its own transaction and must land first, or the order
        // is sized against whatever the account was last set to.
        if (leverageSent.current.get(order.market) !== order.imf) {
          await adapters.lighter.setLeverage(account, order.market, order.imf, 'isolated')
          leverageSent.current.set(order.market, order.imf)
        }

        await adapters.lighter.placeOrder(account, {
          market: order.market,
          side: order.side,
          size: order.size,
          type: order.type,
          price: order.price,
          reduceOnly: false,
        })
        setPositions(await adapters.lighter.positions(account))
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught))
      } finally {
        setBusy(false)
      }
    },
    [adapters, stub],
  )

  /**
   * Why nothing can start yet, in the order someone would fix them.
   *
   * This is gated on completing a round trip, not on building an
   * orchestrator. An orchestrator that can take ZEC in but cannot sign the
   * withdrawal is worse than none: it strands real money in a wallet whose
   * only recovery links the session. So Start waits until the way out exists
   * too, and says which part of it does not.
   */
  const blockers: readonly string[] = useMemo(() => {
    if (stubAdapters) return []
    if (!network) return ['Still reading what this connection is.']
    const why: string[] = []
    if (!effectiveNetwork?.isPrivate) {
      why.push(
        config.unsafeLiveTest
          ? 'This connection is not private, so the checker will refuse every movement. ' +
            'Start the Nym mixnet from the connection panel, or — since this dev server has ' +
            'VITE_UNSAFE_LIVE_TEST=1 — tick the override there to run the real end-to-end ' +
            'path without it, knowing the venues will see this machine.'
          : 'This connection is not private, so the checker will refuse every movement. ' +
            'Start the Nym mixnet from the connection panel, or serve this page from an onion address.',
      )
    }
    if (config.rpcUrls.length === 0) {
      why.push(
        'No Arbitrum RPC is set. The session has to send a transfer on Arbitrum, so some node ' +
          'has to be asked; the call goes through the private connection, so the provider sees ' +
          'an exit rather than you. There is no default because one baked in would let a single ' +
          'company see which addresses every user of this app asks about together. Set ' +
          'VITE_ARBITRUM_RPC_URLS in .env.local — a comma-separated list, so each session uses ' +
          'a different one — and restart the dev server, which reads it once at startup.',
      )
      return why
    }
    if (liveError) return [...why, liveError]
    if (real) why.push(...cannotRoundTrip(real.capabilities))
    return why
  }, [stubAdapters, network, effectiveNetwork, config, liveError, real])

  /**
   * What will still happen, that someone should know before pressing Start.
   *
   * The complement of `blockers`: everything the report calls missing that
   * is nonetheless survivable. These must be shown rather than swallowed,
   * because two of them need an action taken *first* — funding the session
   * wallet with ETH, and having a shielded wallet open to send by hand —
   * and neither is possible once the session is already running.
   */
  const warnings: readonly string[] = useMemo(() => {
    if (stubAdapters || !real) return []
    const fatal = new Set(cannotRoundTrip(real.capabilities))
    const soft = notReady(real.capabilities).filter((why) => !fatal.has(why))
    // The ETH path needs the address, and the address is only useful early.
    return real.capabilities.gasIsPrivate.ok
      ? soft
      : [...soft, real.capabilities.payGas.why]
  }, [stubAdapters, real])

  const funded: Amount | null = session?.swapIn?.settledAmount ?? null
  // One answer for the whole screen: an override that cannot apply must not
  // colour the dot, the ladder or the finding line as though it had.
  const shownOverride = demoOverride && canOverride
  const finding = findingLine(session, findings, blocked, network, shownOverride, clock)

  return (
    <div className="app">
      <TopBar
        network={network}
        keyIndex={session?.keyIndex ?? vault.nextIndex()}
        demoOverride={shownOverride}
        onBack={onBack}
        onConnection={() => setConnectionOpen((open) => !open)}
        connectionOpen={connectionOpen}
        refusals={real ? notReady(real.capabilities).length : 0}
      />

      {connectionOpen && (
        <Popover onClose={() => setConnectionOpen(false)} label="Connection">
          <NetworkPanel
            network={network}
            onNetwork={onNetwork}
            demoOverride={demoOverride}
            onDemoOverride={onDemoOverride}
            allowOverride={canOverride}
            liveTest={!stubAdapters && config.unsafeLiveTest}
          />
          {settings}
          {!stubAdapters && (
            <LivePanel
              real={real}
              error={liveError}
              missingRpc={config.rpcUrls.length === 0}
              endpoints={config.rpcUrls.length}
              gaps={configGaps(config)}
            />
          )}
        </Popover>
      )}

      <div className="app-body">
        <Ladder session={session} network={network} demoOverride={shownOverride} />

        {/* The trading floor needs three columns; the other states do not. */}
        <main
          className={`canvas${session?.state === 'trading' ? ' canvas-wide' : ''}`}
          id="main"
          tabIndex={-1}
        >
          <div className="canvas-head">
            <h1>{titleFor(session)}</h1>
            {finding && <p className="finding-line">{finding}</p>}
          </div>

          {children}

          {!orchestrator || (blockers.length > 0 && !session) ? (
            <BlockedPanel
              blockers={blockers}
              waiting={!stubAdapters && config.rpcUrls.length > 0 && !liveError && !real}
              onConnection={() => setConnectionOpen(true)}
            />
          ) : (
          <section className="work">
            {!session && warnings.length > 0 && (
              <section className="live-panel">
                <h3>Before you start</h3>
                <p>
                  Nothing here stops the session, and each one costs something you
                  should choose rather than discover.
                </p>
                <ul className="live-gaps">
                  {warnings.map((why) => (
                    <li key={why}>{why}</li>
                  ))}
                </ul>
              </section>
            )}

            {!session && (
              <StartPanel
                notional={notional}
                onNotional={setNotional}
                busy={busy}
                feeBps={config.oneClickJwt ? SWAP_FEE_BPS_WITH_JWT : SWAP_FEE_BPS_PUBLIC}
                gasIn={real && !real.capabilities.gasIsPrivate.ok ? 'eth' : 'usdc'}
                onStart={() =>
                  void run('Starting', () =>
                    orchestrator.create(parseAmount('ZEC', notional)),
                  )
                }
              />
            )}

            {session?.state === 'new' && (
              <StepPanel
                say="A key has been derived for this session and a fresh shielded address read for its exit. Nothing has moved yet."
                action="Send the Zcash"
                busy={busy}
                onAct={() =>
                  void run('Funding', async () =>
                    // The placeholder belongs to the demo and nowhere else:
                    // on the live path a refund has to reach an address the
                    // user actually holds.
                    orchestrator.fund(
                      session.id,
                      stubAdapters ? DEMO_REFUND : await askRefundAddress(config.zcashNetwork),
                    ),
                  )
                }
              />
            )}

            {(session?.state === 'swap_in_pending' || session?.state === 'swap_out_pending') && (
              <SwapPanel
                session={session}
                leg={session.state === 'swap_in_pending' ? 'in' : 'out'}
                busy={busy}
                onPoll={() => {
                  settle()
                  void run('Checking', () =>
                    orchestrator.pollSwap(
                      session.id,
                      session.state === 'swap_out_pending' ? 'out' : 'in',
                    ),
                  )
                }}
              />
            )}

            {session?.state === 'funded' && (
              <StepPanel
                say={
                  real && !real.capabilities.gasIsPrivate.ok
                    ? `The USDC is in a wallet that has never been used before. Gas is being paid in ETH, so this checks ${real.sessionWallet} holds some. If it does not, send it about a dollar of ETH and press again — the USDC stays where it is meanwhile.`
                    : 'The USDC is in a wallet that has never been used before. Next it delegates so its gas can be paid in USDC, which saves it ever holding ETH.'
                }
                action="Set up gas"
                busy={busy}
                onAct={() => void run('Gas', () => orchestrator.setupGas(session.id))}
              />
            )}

            {session?.state === 'converted' && (
              <StepPanel
                say={
                  real && !real.capabilities.gasIsPrivate.ok
                    ? 'Gas is payable. Opening the Lighter account registers this session key, and nothing else about you.'
                    : 'Gas is payable in USDC. Opening the Lighter account registers this session key, and nothing else about you.'
                }
                action="Open the Lighter account"
                busy={busy}
                onAct={() =>
                  void run('Opening', () =>
                    orchestrator.openLighter(session.id, funded ?? parseAmount('USDC', '0')),
                  )
                }
              />
            )}

            {session?.state === 'trading' && (
              <TradeWindow
                network={network}
                logger={logger}
                positions={positions}
                balance={funded}
                busy={busy}
                // Fills come from the simulator only when the simulator is
                // driving. Hard-coding this meant a live window would have
                // labelled real fills as simulated, which is the same lie as
                // the reverse and only slightly less expensive.
                simulated={Boolean(stubAdapters)}
                onOrder={(order) => void place(session.lighter, order)}
                onEnd={() =>
                  void run('Ending', () =>
                    orchestrator.endTrading(session.id, funded ?? parseAmount('USDC', '0')),
                  )
                }
              />
            )}

            {session?.state === 'withdrawing' && (
              <ExitPanel
                session={session}
                busy={busy}
                onCheck={() =>
                  void run('Checking', () =>
                    orchestrator.pollWithdrawal(session.id, funded ?? parseAmount('USDC', '0')),
                  )
                }
                onExit={() =>
                  void run('Exiting', () =>
                    orchestrator.exit(session.id, funded ?? parseAmount('USDC', '0')),
                  )
                }
              />
            )}

            {session?.state === 'refunding' && (
              <StepPanel
                say="The swap ran out of time, so the solver is sending it back. Nothing is lost but the fee."
                action="Check for the refund"
                busy={busy}
                onAct={() => {
                  stub?.refundSwaps()
                  void run('Checking', () => orchestrator.pollSwap(session.id, 'in'))
                }}
              />
            )}

            {session?.state === 'closed' && <ClosedPanel session={session} />}

            {session?.state === 'failed' && (
              <p className="say-no">
                {session.failure?.message ?? 'This session stopped.'}{' '}
                {session.failure?.retryable ? 'It can be retried.' : ''}
              </p>
            )}
          </section>
          )}

          <Gate findings={findings} blocked={blocked} />
          {error && <p className="say-no">{error}</p>}
        </main>
      </div>
    </div>
  )
}

/**
 * Why there is no next step, said where the next step would have been.
 *
 * The screen used to point at the connection panel in the bar, which is
 * behind a button and closed by default: someone who had just brought the
 * mixnet up correctly was told only that something, somewhere, was missing.
 * The reasons belong here, in full, next to the button that fixes them.
 */
function BlockedPanel({
  blockers,
  waiting,
  onConnection,
}: {
  blockers: readonly string[]
  waiting: boolean
  onConnection: () => void
}) {
  if (waiting && blockers.length === 0) {
    return (
      <section className="work">
        <div className="skeleton-row" />
      </section>
    )
  }
  return (
    <section className="work" aria-label="Not ready">
      <p className="say">
        {/* Counted as refusals rather than as fixes: one missing signer shows
            up twice here, as the order and as the withdrawal, and promising
            two repairs for one cause would be its own small lie. */}
        {blockers.length === 1
          ? 'One movement would be refused, so no session can start yet.'
          : `${blockers.length} movements would be refused, so no session can start yet.`}{' '}
        A session that can take Zcash in but cannot sign its way out would strand the
        money, so nothing begins until the exit exists too.
      </p>
      <ul className="live-gaps">
        {blockers.map((why) => (
          <li key={why}>{why}</li>
        ))}
      </ul>
      <div className="actions">
        <button className="ghost" onClick={onConnection}>
          Open the connection panel
        </button>
      </div>
    </section>
  )
}

/**
 * What a live run can and cannot do, said before anything is attempted.
 *
 * The capability report comes from the assembly itself, so this cannot
 * drift from what the adapters will actually do when asked.
 */
function LivePanel({
  real,
  error,
  missingRpc,
  endpoints,
  gaps,
}: {
  real: RealAdapters | null
  error: string | null
  missingRpc: boolean
  /** How many RPCs the rotation has to work with. One is not a rotation. */
  endpoints: number
  gaps: readonly string[]
}) {
  if (missingRpc) {
    return (
      <section className="net" aria-label="Live adapters">
        <div className="net-head">
          <span className="net-label">Live</span>
          <span className="net-verdict">not configured</span>
        </div>
        <p className="net-say">
          No Arbitrum RPC is set. Calls to it go through this connection, so the provider
          sees an exit and not you — but it does see which addresses are asked about
          together, which is why nothing is baked in. Set VITE_ARBITRUM_RPC_URLS to a
          comma-separated list and each session takes a different one, so no provider sees
          more than its share.
        </p>
      </section>
    )
  }

  if (error) {
    return (
      <section className="net" aria-label="Live adapters">
        <div className="net-head">
          <span className="net-label">Live</span>
          <span className="net-verdict">could not start</span>
        </div>
        <p className="net-say">{error}</p>
      </section>
    )
  }

  if (!real) {
    return (
      <section className="net" aria-label="Live adapters">
        <div className="skeleton-row" />
      </section>
    )
  }

  const blocked = notReady(real.capabilities)
  return (
    <section className="net" aria-label="Live adapters">
      <div className="net-head">
        <span className="net-label">Live adapters</span>
        <span
          className="net-verdict"
          data-state={blocked.length === 0 ? 'private' : 'overridden'}
        >
          {blocked.length === 0
            ? 'every movement is wired'
            : `${blocked.length} of six movements will refuse`}
        </span>
      </div>
      <p className="net-say">
        Quotes and market reads are live. The Zcash send uses the{' '}
        {real.noirKind === 'extension' ? 'Noir Wallet extension' : 'manual path'}.{' '}
        {endpoints > 1
          ? `Chain reads rotate across ${endpoints} RPCs, one per session.`
          : 'One RPC is configured, so every session asks the same provider; a second entry in VITE_ARBITRUM_RPC_URLS stops it linking them.'}
      </p>
      {blocked.length > 0 && (
        <ul className="live-gaps">
          {blocked.map((why) => (
            <li key={why}>{why}</li>
          ))}
        </ul>
      )}
      {gaps.length > 0 && <p className="meta">Unset: {gaps.join('; ')}.</p>}
    </section>
  )
}

/** The one finding: whatever most needs attention, next to what it drives. */
function findingLine(
  session: Session | null,
  findings: readonly Finding[],
  blocked: boolean,
  network: NetworkAdapter | null,
  demoOverride: boolean,
  clock: (() => number) | undefined,
): string | null {
  const now = clock ? clock() : Date.now()
  const block = findings.find((f) => f.severity === 'block')
  if (blocked && block) return block.message
  if (network && !network.isPrivate && !demoOverride) {
    return 'This connection is not private, so nothing will be allowed to move.'
  }
  if (session?.state === 'withdrawing' && session.exitNotBefore) {
    const left = Math.max(0, Math.ceil((session.exitNotBefore - now) / 60_000))
    return left > 0 ? `The exit opens in ${left} minutes.` : 'The exit is open.'
  }
  if (session?.state === 'swap_in_pending' && session.swapIn) {
    const mins = Math.max(0, Math.round((session.swapIn.deadline - now) / 60_000))
    return `Waiting on the solver. It refunds itself in ${mins} minutes.`
  }
  return null
}
