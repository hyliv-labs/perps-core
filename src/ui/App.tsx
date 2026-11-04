import { useEffect, useState } from 'react'
import { createSessionStore, openDatabase, type SessionStore } from '@/core/store'
import type { Vault } from '@/core/keys'
import { Unlock } from './Unlock'
import { SessionScreen } from './session/SessionScreen'
import { Landing } from './Landing'
import { chooseNetwork } from '@/adapters/network'
import type { NetworkAdapter } from '@/adapters/types'
import { useRoute, type Route } from './router'
import { PreviewScreen } from './session/Preview'
import { PayPanel } from './pay/PayPanel'
import { readConfig } from '@/core/config'

/**
 * The route shell: the landing page, the shielded payment screen, or the
 * session screen behind the vault.
 *
 * `/pay` sits outside the vault on purpose. It spends from the wallet
 * extension, not from a key this app holds, so there is nothing here for a
 * vault to protect and asking someone to make one first would be ceremony
 * for its own sake.
 */

export function App() {
  const [route, navigate] = useRoute()
  if (route === '/') return <Landing navigate={navigate} />
  if (route === '/pay') return <PayScreen navigate={navigate} />
  return <TradingApp navigate={navigate} />
}

function PayScreen({ navigate }: { navigate: (to: Route) => void }) {
  return (
    <main className="gate">
      <a className="gate-back" href="/" onClick={backTo(navigate)}>
        <span aria-hidden="true">&larr;</span> Back
      </a>
      <div className="gate-stage">
        <PayPanel network={readConfig().zcashNetwork} />
      </div>
    </main>
  )
}

function TradingApp({ navigate }: { navigate: (to: Route) => void }) {
  const [vault, setVault] = useState<Vault | null>(null)
  const [store, setStore] = useState<SessionStore | null>(null)
  const [network, setNetwork] = useState<NetworkAdapter | null>(null)
  const [demoOverride, setDemoOverride] = useState(false)

  useEffect(() => {
    let live = true
    void openDatabase().then((db) => {
      if (live) setStore(createSessionStore(db))
    })
    return () => {
      live = false
    }
  }, [])

  // What is true about this connection, read once on load. Nothing is
  // started and nothing third-party is called.
  useEffect(() => {
    let live = true
    void chooseNetwork().then((n) => {
      if (live) setNetwork(n)
    })
    return () => {
      live = false
    }
  }, [])

  // A development affordance: /app?preview=trading renders a screen with a
  // throwaway vault so it can be looked at without unlocking one. Guarded on
  // import.meta.env.DEV, so it cannot exist in a built app.
  const preview = import.meta.env.DEV
    ? new URLSearchParams(window.location.search).get('preview')
    : null

  if (preview && store) {
    return (
      <PreviewScreen
        store={store}
        network={network}
        state={preview}
        onBack={backTo(navigate)}
      />
    )
  }

  if (!store || !vault) {
    return (
      <main className="gate">
        <a className="gate-back" href="/" onClick={backTo(navigate)}>
          <span aria-hidden="true">&larr;</span> Back
        </a>
        <div className="gate-stage">
          {store ? (
            <Unlock store={store} onUnlocked={setVault} />
          ) : (
            <section className="gate-card" aria-busy="true" aria-label="Loading the vault">
              <div className="skeleton-row" />
              <div className="skeleton-row" />
              <div className="skeleton-row" />
            </section>
          )}
        </div>
      </main>
    )
  }

  return (
    <SessionScreen
      store={store}
      vault={vault}
      network={network}
      demoOverride={demoOverride}
      onNetwork={setNetwork}
      onDemoOverride={setDemoOverride}
      onBack={backTo(navigate)}
    />
  )
}

function backTo(navigate: (to: Route) => void) {
  return (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
    event.preventDefault()
    navigate('/')
  }
}
