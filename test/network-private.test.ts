import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDirectNetwork, NetworkTimeoutError } from '@/adapters/network'
import {
  createMixnetNetwork,
  MixnetUnavailableError,
  type MixFetchModule,
} from '@/adapters/network/mixnet'
import {
  checkTorExit,
  createCheckedTorNetwork,
  describeCheck,
  upgradeIfTor,
} from '@/adapters/network/verify'

afterEach(() => vi.restoreAllMocks())

/** A stand-in for the WASM worker. */
function stubMixFetch(
  behaviour: {
    connect?: 'ok' | 'hang' | 'throw'
    respond?: 'ok' | 'hang'
  } = {},
): { module: MixFetchModule; calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = []
  const module: MixFetchModule = {
    async createMixFetch() {
      if (behaviour.connect === 'throw') throw new Error('no gateway')
      if (behaviour.connect === 'hang') await new Promise(() => {})
      return async (url: string, init?: RequestInit) => {
        calls.push({ url, ...(init ? { init } : {}) })
        if (behaviour.respond === 'hang') await new Promise(() => {})
        return new Response('{"ok":true}', { status: 200 })
      }
    },
    getTunnelState: () => ({ state: 'ready' }),
    disconnectMixTunnel: () => undefined,
  }
  return { module, calls }
}

describe('the mixnet transport', () => {
  it('is private, and says so because it measured rather than assumed', async () => {
    const { module } = stubMixFetch()
    const net = await createMixnetNetwork({ load: async () => module })
    expect(net.kind).toBe('nym')
    expect(net.isPrivate).toBe(true)
    expect(net.assurance).toBe('verified')
    expect(net.state()).toBe('ready')
  })

  it('reports the stages it goes through', async () => {
    const { module } = stubMixFetch()
    const seen: string[] = []
    await createMixnetNetwork({ load: async () => module, onState: (s) => seen.push(s) })
    expect(seen).toEqual(['connecting', 'ready'])
  })

  it('gives up on a tunnel that never comes up', async () => {
    const { module } = stubMixFetch({ connect: 'hang' })
    await expect(
      createMixnetNetwork({ load: async () => module, connectTimeoutMs: 15 }),
    ).rejects.toThrow(MixnetUnavailableError)
  })

  it('says plainly when the client will not load at all', async () => {
    await expect(
      createMixnetNetwork({
        load: async () => {
          throw new Error('wasm blocked')
        },
      }),
    ).rejects.toThrow(/could not be loaded/)
  })

  it('times out a request without an AbortController', async () => {
    // mixFetch does not support AbortController, so the deadline is a race.
    const { module } = stubMixFetch({ respond: 'hang' })
    const net = await createMixnetNetwork({ load: async () => module, timeoutMs: 15 })
    await expect(net.fetch('https://1click.example/v0/quote')).rejects.toThrow(
      NetworkTimeoutError,
    )
  })

  it('still sends the hardening the rest of the app relies on', async () => {
    const { module, calls } = stubMixFetch()
    const net = await createMixnetNetwork({ load: async () => module })
    await net.fetch('https://1click.example/v0/quote', { method: 'POST' })
    expect(calls[0]!.init?.credentials).toBe('omit')
    expect(calls[0]!.init?.referrerPolicy).toBe('no-referrer')
    expect(calls[0]!.init?.method).toBe('POST')
  })
})

describe('the connection check', () => {
  function netAnswering(body: unknown, status = 200) {
    return {
      ...createDirectNetwork(),
      fetch: async () => new Response(JSON.stringify(body), { status }),
    }
  }

  it('confirms Tor when the service says so', async () => {
    expect(await checkTorExit(netAnswering({ IsTor: true, IP: '1.2.3.4' }))).toEqual({
      result: 'tor',
    })
  })

  it('never lets the exit address out of the check', async () => {
    const check = await checkTorExit(netAnswering({ IsTor: true, IP: '203.0.113.9' }))
    // An exit IP written anywhere is the link this product exists to break.
    expect(JSON.stringify(check)).not.toContain('203.0.113.9')
  })

  it('reports not-tor plainly', async () => {
    expect(await checkTorExit(netAnswering({ IsTor: false, IP: '1.2.3.4' }))).toEqual({
      result: 'not-tor',
    })
  })

  it('treats an unreachable service as unknown, not as a pass', async () => {
    const net = {
      ...createDirectNetwork(),
      fetch: async () => {
        throw new Error('offline')
      },
    }
    const check = await checkTorExit(net)
    expect(check.result).toBe('unknown')
  })

  it('treats a strange answer as unknown', async () => {
    expect((await checkTorExit(netAnswering({ IsTor: 'yes' }))).result).toBe('unknown')
  })

  it('upgrades a direct connection once Tor is confirmed', async () => {
    const { network, check } = await upgradeIfTor(netAnswering({ IsTor: true }))
    expect(check.result).toBe('tor')
    expect(network.isPrivate).toBe(true)
    expect(network.assurance).toBe('verified')
  })

  it('leaves the connection alone when the check fails', async () => {
    const { network } = await upgradeIfTor(netAnswering({ IsTor: false }))
    // A failed check must never make the app look more private than it is.
    expect(network.isPrivate).toBe(false)
  })

  it('leaves the connection alone when the check is inconclusive', async () => {
    const net = {
      ...createDirectNetwork(),
      fetch: async () => {
        throw new Error('blocked')
      },
    }
    expect((await upgradeIfTor(net)).network.isPrivate).toBe(false)
  })

  it('keeps the fetch of the adapter it upgrades', async () => {
    let used = false
    const base = {
      ...createDirectNetwork(),
      fetch: async () => {
        used = true
        return new Response('{}')
      },
    }
    await createCheckedTorNetwork(base).fetch('https://example.com')
    expect(used).toBe(true)
  })

  it('tells the person what to do when it is not private', () => {
    expect(describeCheck({ result: 'not-tor' })).toMatch(/Tor browser window|mixnet/)
  })
})
