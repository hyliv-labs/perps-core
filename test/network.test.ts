import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NetworkAdapter } from '@/adapters/types'
import {
  NetworkTimeoutError,
  NotOnionError,
  chooseNetwork,
  createDirectNetwork,
  createOnionNetwork,
  createProxyNetwork,
  describeNetwork,
  isOnion,
} from '@/adapters/network'

afterEach(() => vi.restoreAllMocks())

function captureFetch(status = 200) {
  const calls: { url: string; init: RequestInit }[] = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response('{}', { status })
  })
  return calls
}

describe('network layer', () => {
  describe('what it claims', () => {
    it('is honest that a direct connection protects nothing', () => {
      expect(createDirectNetwork().isPrivate).toBe(false)
    })

    it('claims Tor only when the page really is on an onion address', () => {
      expect(createOnionNetwork({ hostname: 'abc.onion' }).isPrivate).toBe(true)
      // Claiming Tor on an ordinary origin would be a lie the checker trusts.
      expect(() => createOnionNetwork({ hostname: 'example.com' })).toThrow(NotOnionError)
    })

    it('treats an unasserted proxy as no protection', () => {
      const net = createProxyNetwork({
        endpoint: 'http://127.0.0.1:8118',
        kind: 'tor',
        asserted: false,
      })
      expect(net.isPrivate).toBe(false)
    })

    it('recognises onion hosts and nothing else', () => {
      expect(isOnion('x.onion')).toBe(true)
      expect(isOnion('onion.example.com')).toBe(false)
    })
  })

  describe('what every request carries', () => {
    it('drops cookies, the referrer and the cache on every call', async () => {
      const calls = captureFetch()
      await createDirectNetwork().fetch('https://example.com/x')
      const init = calls[0]!.init
      expect(init.credentials).toBe('omit')
      expect(init.referrerPolicy).toBe('no-referrer')
      expect(init.cache).toBe('no-store')
      // A redirect to another origin would leak the destination.
      expect(init.redirect).toBe('error')
    })

    it('gives up rather than hanging', async () => {
      vi.stubGlobal('fetch', (_u: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        }),
      )
      const net = createDirectNetwork({ timeoutMs: 10 })
      await expect(net.fetch('https://example.com/quote/t1deposit')).rejects.toThrow(
        NetworkTimeoutError,
      )
    })

    it('keeps the deposit address out of the timeout message', async () => {
      vi.stubGlobal('fetch', (_u: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        }),
      )
      const net = createDirectNetwork({ timeoutMs: 10 })
      const error = (await net
        .fetch('https://1click.example/v0/status?depositAddress=t1secret')
        .then(() => null)
        .catch((e: unknown) => e)) as Error
      expect(error.message).not.toContain('t1secret')
      expect(error.message).toContain('https://1click.example')
    })

    it('hands the target to the forwarder instead of connecting to it', async () => {
      const calls = captureFetch()
      const net = createProxyNetwork({
        endpoint: 'http://127.0.0.1:8118',
        kind: 'tor',
        asserted: true,
      })
      await net.fetch('https://1click.example/v0/quote')
      // The browser must not resolve or reach the destination itself.
      expect(calls[0]!.url).toBe(
        'http://127.0.0.1:8118/https%3A%2F%2F1click.example%2Fv0%2Fquote',
      )
    })
  })

  describe('choosing', () => {
    it('takes the onion origin when there is one', async () => {
      const net = await chooseNetwork({ hostname: 'abc.onion' })
      expect(net.kind).toBe('tor')
      expect(net.isPrivate).toBe(true)
    })

    it('falls back to direct rather than guessing upwards', async () => {
      const net = await chooseNetwork({ hostname: 'example.com' })
      expect(net.isPrivate).toBe(false)
    })

    it('ignores a proxy the user has not vouched for', async () => {
      captureFetch()
      const net = await chooseNetwork({
        hostname: 'example.com',
        proxy: { endpoint: 'http://127.0.0.1:8118', kind: 'tor', asserted: false },
      })
      expect(net.kind).toBe('direct')
    })

    it('uses a vouched-for proxy that answers', async () => {
      captureFetch()
      const net = await chooseNetwork({
        hostname: 'example.com',
        proxy: { endpoint: 'http://127.0.0.1:8118', kind: 'nym', asserted: true },
      })
      expect(net.kind).toBe('nym')
      expect(net.isPrivate).toBe(true)
    })

    it('does not use a vouched-for proxy that is not running', async () => {
      vi.stubGlobal('fetch', async () => {
        throw new Error('connection refused')
      })
      const net = await chooseNetwork({
        hostname: 'example.com',
        proxy: { endpoint: 'http://127.0.0.1:8118', kind: 'tor', asserted: true },
      })
      expect(net.kind).toBe('direct')
    })
  })

  describe('what the user is told', () => {
    it('says plainly that nothing will move on a direct connection', () => {
      expect(describeNetwork(createDirectNetwork())).toMatch(/Nothing will move/)
    })

    it('does not overstate a proxy it cannot see behind', () => {
      const net = createProxyNetwork({ endpoint: 'http://127.0.0.1:1', kind: 'tor', asserted: true })
      expect(describeNetwork(net)).toMatch(/your word for it/)
    })

    it('does not call a verified mixnet Tor', () => {
      // The description branched on the assurance alone, so bringing the Nym
      // mixnet up told the person their page was served over Tor. Two
      // different networks, one sentence, and the wrong one.
      const nym: NetworkAdapter = {
        kind: 'nym',
        isPrivate: true,
        assurance: 'verified',
        fetch: () => Promise.reject(new Error('not called')),
      }
      expect(describeNetwork(nym)).toMatch(/Nym mixnet/)
      expect(describeNetwork(nym)).not.toMatch(/Tor/)
    })
  })
})
