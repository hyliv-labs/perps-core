/**
 * Does every venue answer through the mixnet?
 *
 * The checker refuses to move money unless the connection is private, and
 * the Nym mixnet is the only arrangement that makes a plain browser page
 * private by itself. But a private connection the venues refuse to talk to
 * is no use either: CDNs in front of these APIs routinely challenge traffic
 * arriving from an anonymising exit, and a Nym gateway is one.
 *
 * Every reachability check this project has on record was made over
 * clearnet from localhost. None of them says anything about what happens
 * through a mixnet gateway. The difference matters at exactly the wrong
 * moment: the first venue call of a real session happens with shielded ZEC
 * already in flight against a deadline we did not set.
 *
 * So this asks all four, through the real transport, before anything is
 * funded. It is read-only — a dry quote, a public order book, a chain id
 * and the bundler's entry points. Nothing here can move money, which is
 * the point: it is the last thing that can fail cheaply.
 */

import { useCallback, useState } from 'react'
import type { NetworkAdapter } from '@/adapters/types'
import { createDirectNetwork, describeNetwork } from '@/adapters/network'
import { ONECLICK_API } from '@/adapters/near1click/http'
import { LIGHTER_API } from '@/adapters/lighter/http'
import type { MixnetState } from '@/adapters/network/mixnet'
import { readConfig } from '@/core/config'

type Outcome = 'pending' | 'running' | 'pass' | 'fail'

interface Check {
  readonly id: string
  readonly label: string
  /** Why a failure here matters, in terms of the session that would follow. */
  readonly stakes: string
  readonly outcome: Outcome
  readonly detail: string
}

const ZEC = 'nep141:zec.omft.near'
const USDC = 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near'

const INITIAL: readonly Check[] = [
  {
    id: 'oneclick',
    label: '1Click — dry quote, ZEC to USDC',
    stakes: 'Without this there is no entry leg and no exit leg.',
    outcome: 'pending',
    detail: '',
  },
  {
    id: 'lighter',
    label: 'Lighter — public order books',
    stakes: 'Without this the venue cannot be read, so nothing can be traded or priced.',
    outcome: 'pending',
    detail: '',
  },
  {
    id: 'rpc',
    label: 'Arbitrum RPC — eth_chainId',
    stakes: 'Without this no balance can be read and no transfer built.',
    outcome: 'pending',
    detail: '',
  },
  {
    id: 'bundler',
    label: 'Bundler — eth_supportedEntryPoints',
    stakes: 'Without this gas cannot be paid in USDC, and the session wallet holds no ETH.',
    outcome: 'pending',
    detail: '',
  },
]

async function rpcCall(
  network: NetworkAdapter,
  url: string,
  method: string,
): Promise<{ ok: boolean; detail: string }> {
  const response = await network.fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }),
  })
  const text = await response.text()
  if (!response.ok) return { ok: false, detail: `${response.status} ${text.slice(0, 120)}` }
  try {
    const parsed = JSON.parse(text) as { result?: unknown; error?: unknown }
    if (parsed.error) return { ok: false, detail: JSON.stringify(parsed.error).slice(0, 160) }
    return { ok: true, detail: JSON.stringify(parsed.result).slice(0, 160) }
  } catch {
    return { ok: false, detail: `unparseable: ${text.slice(0, 120)}` }
  }
}

export function VenueGate() {
  const config = readConfig()
  const [checks, setChecks] = useState<readonly Check[]>(INITIAL)
  const [mixnet, setMixnet] = useState<MixnetState>('idle')
  const [transport, setTransport] = useState<string>('not started')
  const [busy, setBusy] = useState(false)
  const [fatal, setFatal] = useState<string | null>(null)

  const update = useCallback((id: string, outcome: Outcome, detail: string) => {
    setChecks((current) =>
      current.map((c) => (c.id === id ? { ...c, outcome, detail } : c)),
    )
  }, [])

  const run = useCallback(
    async (useMixnet: boolean) => {
      setBusy(true)
      setFatal(null)
      setChecks(INITIAL)

      let network: NetworkAdapter
      try {
        if (useMixnet) {
          setMixnet('connecting')
          // Imported here so the eighteen megabytes stay in their own chunk.
          const { createMixnetNetwork } = await import('@/adapters/network/mixnet')
          network = await createMixnetNetwork({ onState: setMixnet })
        } else {
          network = createDirectNetwork()
        }
      } catch (caught) {
        setMixnet('failed')
        setFatal(caught instanceof Error ? caught.message : String(caught))
        setBusy(false)
        return
      }
      setTransport(describeNetwork(network))

      // 1Click. `dry: true` prices the swap without creating a deposit
      // address, so this cannot start anything.
      update('oneclick', 'running', '')
      try {
        const response = await network.fetch(`${ONECLICK_API}/v0/quote`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(config.oneClickJwt ? { authorization: `Bearer ${config.oneClickJwt}` } : {}),
          },
          body: JSON.stringify({
            dry: true,
            swapType: 'EXACT_INPUT',
            slippageTolerance: 100,
            depositType: 'ORIGIN_CHAIN',
            refundType: 'ORIGIN_CHAIN',
            recipientType: 'DESTINATION_CHAIN',
            confidentiality: 'basic',
            originAsset: ZEC,
            destinationAsset: USDC,
            amount: '1000000',
            refundTo: config.zcashNetwork === 'test' ? 'utest1' : 'u1',
            recipient: '0x1111111111111111111111111111111111111111',
            deadline: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
          }),
        })
        const text = await response.text()
        // A 400 here still proves reachability: the request left, a solver
        // read it and objected to the address. A CDN challenge does not
        // look like this — it is a 403 with an HTML body.
        const reachable = response.status === 201 || response.status === 400
        update(
          'oneclick',
          reachable ? 'pass' : 'fail',
          `${response.status} ${text.slice(0, 140)}`,
        )
      } catch (caught) {
        update('oneclick', 'fail', caught instanceof Error ? caught.message : String(caught))
      }

      update('lighter', 'running', '')
      try {
        const response = await network.fetch(
          `${LIGHTER_API}/api/v1/orderBooks`,
          { method: 'GET' },
        )
        const text = await response.text()
        let markets = ''
        try {
          const parsed = JSON.parse(text) as { order_books?: unknown[] }
          markets = `${parsed.order_books?.length ?? 0} markets`
        } catch {
          markets = text.slice(0, 120)
        }
        update('lighter', response.ok ? 'pass' : 'fail', `${response.status} ${markets}`)
      } catch (caught) {
        update('lighter', 'fail', caught instanceof Error ? caught.message : String(caught))
      }

      update('rpc', 'running', '')
      const rpc = config.rpcUrls[0]
      if (!rpc) {
        update('rpc', 'fail', 'VITE_ARBITRUM_RPC_URLS is empty')
      } else {
        try {
          const { ok, detail } = await rpcCall(network, rpc, 'eth_chainId')
          update('rpc', ok && detail.includes('0xa4b1') ? 'pass' : 'fail', detail)
        } catch (caught) {
          update('rpc', 'fail', caught instanceof Error ? caught.message : String(caught))
        }
      }

      update('bundler', 'running', '')
      if (!config.bundlerUrl) {
        update('bundler', 'fail', 'VITE_BUNDLER_URL is empty, so gas cannot be paid in USDC')
      } else {
        try {
          const { ok, detail } = await rpcCall(
            network,
            config.bundlerUrl,
            'eth_supportedEntryPoints',
          )
          // EntryPoint v0.8 is the one the 7702 delegate is built for.
          const v08 = detail.toLowerCase().includes('0x4337084d9e255ff0702461cf8895ce9e3b5ff108')
          update(
            'bundler',
            ok && v08 ? 'pass' : 'fail',
            ok && !v08 ? `reachable, but EntryPoint v0.8 is absent: ${detail}` : detail,
          )
        } catch (caught) {
          update('bundler', 'fail', caught instanceof Error ? caught.message : String(caught))
        }
      }

      setBusy(false)
    },
    [config, update],
  )

  const passed = checks.filter((c) => c.outcome === 'pass').length
  const failed = checks.filter((c) => c.outcome === 'fail').length
  const done = passed + failed === checks.length

  return (
    <section className="gate-panel">
      <h1>Venue gate</h1>
      <p className="gate-lede">
        Every venue this session depends on, asked through the transport the
        session will actually use. Read-only: a dry quote, a public order
        book, a chain id and the bundler&rsquo;s entry points. Nothing here
        can move money.
      </p>

      <div className="gate-actions">
        <button type="button" onClick={() => void run(true)} disabled={busy}>
          {busy && mixnet === 'connecting'
            ? 'Bringing the mixnet up…'
            : busy
              ? 'Asking…'
              : 'Run through the Nym mixnet'}
        </button>
        <button type="button" onClick={() => void run(false)} disabled={busy}>
          Run over the clear network
        </button>
      </div>

      {mixnet === 'connecting' && (
        <p className="gate-note">
          A cold tunnel takes fifteen to thirty seconds. This is paid once per
          session, which is why the real app warms it before anyone is waiting
          on a quote.
        </p>
      )}
      <p className="gate-note">transport: {transport}</p>
      {fatal && <p className="gate-error">The transport did not start: {fatal}</p>}

      <ol className="gate-list">
        {checks.map((c) => (
          <li key={c.id} data-outcome={c.outcome}>
            <strong>{c.label}</strong>
            <span className="gate-outcome">{c.outcome}</span>
            <p className="gate-stakes">{c.stakes}</p>
            {c.detail && <pre className="gate-detail">{c.detail}</pre>}
          </li>
        ))}
      </ol>

      {done && (
        <p className={failed === 0 ? 'gate-verdict pass' : 'gate-verdict fail'}>
          {failed === 0
            ? 'All four answered. The venues accept this transport, so a session can be funded.'
            : `${failed} of ${checks.length} did not answer. Funding now would put money in flight against a venue that cannot be reached.`}
        </p>
      )}
    </section>
  )
}
