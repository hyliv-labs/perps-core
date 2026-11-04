import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { pickRpc, readConfig } from '@/core/config'

/**
 * Which RPC a session talks to.
 *
 * The reason this is not `Math.random()`: the promise made to the user is
 * that no single provider sees two of their session wallets. A random pick
 * breaks that promise one time in n, and re-rolls whenever the adapters are
 * rebuilt — on a Tor-to-Nym switch, say — scattering one session across
 * several providers for no gain. Key indices are consecutive, so taking them
 * modulo the list gives every run of n sessions n distinct endpoints.
 */

const THREE = ['https://a.example', 'https://b.example', 'https://c.example'] as const

describe('pickRpc', () => {
  it('gives n consecutive sessions n different providers', () => {
    const picked = [0, 1, 2].map((i) => pickRpc(THREE, i))
    expect(new Set(picked).size).toBe(3)
  })

  it('is stable, so rebuilding the adapters does not move the session', () => {
    expect(pickRpc(THREE, 7)).toBe(pickRpc(THREE, 7))
  })

  it('wraps past the end of the list', () => {
    expect(pickRpc(THREE, 3)).toBe(pickRpc(THREE, 0))
    expect(pickRpc(THREE, 4)).toBe(pickRpc(THREE, 1))
  })

  it('still picks something for an index that should never happen', () => {
    // A negative or fractional index is a bug elsewhere, but answering
    // `undefined` would read as "no RPC configured" and block the session
    // for a reason that has nothing to do with the configuration.
    expect(pickRpc(THREE, -1)).toBe(THREE[1])
    expect(pickRpc(THREE, 2.7)).toBe(THREE[2])
  })

  it('works with a single entry, which is not a rotation but is valid', () => {
    expect(pickRpc(['https://only.example'], 99)).toBe('https://only.example')
  })

  it('says there is nothing rather than inventing a default', () => {
    expect(pickRpc([], 0)).toBeUndefined()
  })
})

describe('which Zcash network the build is on', () => {
  it('is mainnet unless the variable says exactly "test"', () => {
    /*
     * Mainnet is the default because it is the product, and because the
     * failure modes are asymmetric: a mainnet build that believed it was on
     * testnet would accept testnet addresses for real money, while a testnet
     * build that believed it was on mainnet merely refuses everything.
     */
    const set = (import.meta.env as Record<string, string | undefined>).VITE_ZCASH_NETWORK
    expect(readConfig().zcashNetwork).toBe(set === 'test' ? 'test' : 'main')
  })

  it('reports an unrecognised value as a gap instead of guessing', () => {
    /*
     * "testnet" is the word most people would reach for, and silently
     * running on mainnet because of it is the exact accident this prevents.
     * The source is checked because the gap depends on the raw variable
     * rather than on the parsed config, which has already collapsed every
     * unrecognised value to "main".
     */
    const source = readFileSync('src/core/config.ts', 'utf8')
    expect(source).toContain("network !== 'main' && network !== 'test'")
    expect(source).toContain('VITE_ZCASH_NETWORK is "')
  })
})

describe('the live-test escape hatch', () => {
  /*
   * It turns the privacy gate into a warning so the real end-to-end path
   * can be run locally. That is a reasonable thing to want and an
   * unthinkable thing to ship, so the only guarantee worth testing is that
   * it cannot be shipped — not what it does when it is on.
   */

  it('is on only for exactly "1", not for any truthy string', () => {
    /*
     * Asserted against the environment rather than against `false`: a
     * developer running the live test has it set in `.env.local`, which
     * Vite loads for vitest too, and a test that failed for them would be
     * deleted rather than fixed.
     */
    const set = (import.meta.env as Record<string, string | undefined>).VITE_UNSAFE_LIVE_TEST
    expect(readConfig().unsafeLiveTest).toBe(set === '1')
    // "true", "yes" and "0" all leave it off.
    expect(['true', 'yes', '0', '', undefined].includes(set as string)).toBe(
      !readConfig().unsafeLiveTest,
    )
  })

  it('is conditioned on import.meta.env.DEV, which a build folds away', () => {
    /*
     * A source check, and it earns its keep: the safety property is one
     * conjunct in one expression. Dropping it would leave every test here
     * passing and every behaviour identical on a dev server, while a built
     * page gained an environment variable that disables the checker.
     */
    const source = readFileSync('src/core/config.ts', 'utf8')
    expect(source).toContain(
      "unsafeLiveTest: Boolean(import.meta.env.DEV) && read('VITE_UNSAFE_LIVE_TEST') === '1'",
    )
  })

  it('is the only thing that can widen the override beyond the mocks', () => {
    // If a second route to `canOverride` appears, this says so. The demo
    // override exists to be ticked against mocks; it must not become a
    // switch that moves real money on a deployed page.
    const screen = readFileSync('src/ui/session/SessionScreen.tsx', 'utf8')
    expect(screen).toContain('const canOverride = Boolean(stubAdapters) || config.unsafeLiveTest')
  })
})
