import { useCallback, useState } from 'react'
import type { NetworkAdapter } from '@/adapters/types'
import { describeNetwork } from '@/adapters/network'
import { describeCheck, upgradeIfTor, type ExitCheck } from '@/adapters/network/verify'
// Type-only, so the eighteen megabytes stay in their own chunk. The module
// itself is imported where it is used, inside the click handler.
import type { MixnetState } from '@/adapters/network/mixnet'

/** Three states, never two: private, overridden, or open. */
export function verdictState(
  network: NetworkAdapter,
  demoOverride: boolean,
): 'private' | 'overridden' | 'open' {
  if (network.isPrivate) return 'private'
  return demoOverride ? 'overridden' : 'open'
}

/**
 * Where this connection stands, and the two ways to change it.
 *
 * The panel states the truth even when the truth is "nothing will move":
 * the checker blocks every movement while the connection is not private, so
 * telling the person otherwise would only make the refusal confusing when it
 * arrives.
 */
export function NetworkPanel({
  network,
  onNetwork,
  demoOverride,
  onDemoOverride,
  allowOverride = false,
  liveTest = false,
}: {
  network: NetworkAdapter | null
  onNetwork: (network: NetworkAdapter) => void
  demoOverride: boolean
  onDemoOverride: (on: boolean) => void
  /**
   * Whether the demo override may be offered at all.
   *
   * Off by default, and only the simulator turns it on. Against the real
   * adapters there is no such thing as "mock funds only", so the checkbox
   * would be an invitation to move real money over the clear network.
   */
  allowOverride?: boolean
  /** The override applies to real adapters, not to the mocks. */
  liveTest?: boolean
}) {
  const [check, setCheck] = useState<ExitCheck | null>(null)
  const [mixnet, setMixnet] = useState<MixnetState>('idle')
  const [busy, setBusy] = useState<null | 'check' | 'mixnet'>(null)
  const [error, setError] = useState<string | null>(null)

  const runCheck = useCallback(async () => {
    if (!network) return
    setBusy('check')
    setError(null)
    try {
      const result = await upgradeIfTor(network)
      setCheck(result.check)
      if (result.network !== network) onNetwork(result.network)
    } finally {
      setBusy(null)
    }
  }, [network, onNetwork])

  const startMixnet = useCallback(async () => {
    setBusy('mixnet')
    setError(null)
    try {
      const { createMixnetNetwork } = await import('@/adapters/network/mixnet')
      onNetwork(await createMixnetNetwork({ onState: setMixnet }))
    } catch (caught) {
      setMixnet('failed')
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(null)
    }
  }, [onNetwork])

  // An override nobody is allowed to make is not an override.
  const override = demoOverride && allowOverride

  if (!network) {
    return (
      <section className="net" aria-label="Connection">
        <div className="skeleton-row" />
      </section>
    )
  }

  return (
    <section className="net" aria-label="Connection">
      <div className="net-head">
        <span className="net-label">Connection</span>
        {/* An override is not a good state, so it does not get the good
            colour. Green here would read as "fine" for a disabled check. */}
        <span className="net-verdict" data-state={verdictState(network, override)}>
          {network.isPrivate
            ? network.assurance === 'verified'
              ? `${network.kind}, verified`
              : `${network.kind}, your word`
            : override
              ? liveTest
                ? 'open, overridden — real money, not private'
                : 'open, overridden for the demo'
              : 'not private'}
        </span>
      </div>

      <p className="net-say">
        {override && !network.isPrivate
          ? liveTest
            ? 'The checker has been told to allow movements, and these are the real adapters. Anything that moves from here is real and is not private.'
            : 'The checker has been told to allow movements. Only mock funds move while this is on.'
          : describeNetwork(network)}
      </p>

      {check && <p className="net-say">{describeCheck(check)}</p>}
      {mixnet === 'connecting' && (
        <p className="net-say">
          Bringing the mixnet up. A cold tunnel takes fifteen to thirty seconds.
        </p>
      )}

      <div className="actions">
        <button className="ghost" disabled={busy !== null} onClick={() => void runCheck()}>
          {busy === 'check' ? 'Checking…' : 'Check this connection'}
        </button>
        <button
          className="ghost"
          disabled={busy !== null || network.kind === 'nym'}
          onClick={() => void startMixnet()}
        >
          {busy === 'mixnet' ? 'Starting the mixnet…' : 'Use the Nym mixnet'}
        </button>
      </div>

      {!network.isPrivate && allowOverride && (
        <label className="check">
          <input
            type="checkbox"
            checked={demoOverride}
            onChange={(e) => onDemoOverride(e.target.checked)}
          />
          {/* The same switch means two different things, and saying the
              wrong one would be worse than saying nothing. Against mocks it
              costs nothing; against the real venues it spends real money
              over the clear network, and that is permanent. */}
          {liveTest
            ? 'Move real money anyway, with no privacy. Local end-to-end test only: the venues see this machine, both swap legs and the Lighter account are linkable to it for good.'
            : 'Ignore this for the demo. Mock funds only; never enable it against real money.'}
        </label>
      )}

      {error && <p className="error">{error}</p>}
    </section>
  )
}
