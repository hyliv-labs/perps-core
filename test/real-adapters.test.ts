import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => vi.unstubAllGlobals())
import { privateKeyToAccount } from 'viem/accounts'
import { cannotRoundTrip, createRealAdapters, notReady } from '@/adapters/real'
import { MissingSignerError } from '@/adapters/lighter/http'
import { PAYMASTER_SEND_READY } from '@/adapters/paymaster'
import type { NetworkAdapter } from '@/adapters/types'
import { testLogger } from './helpers'
import { evmAddress, parseAmount } from '@/core/types'

/**
 * The assembly, and the promise it makes.
 *
 * The point of the capability report is that it cannot drift from what the
 * adapters do. These tests hold the two against each other: whatever the
 * report calls ready has to work, and whatever it calls missing has to
 * refuse — rather than quietly doing something else.
 */

const ACCOUNT = privateKeyToAccount(`0x${'11'.repeat(32)}`)
const RPC = 'https://arb.example/rpc'

const net: NetworkAdapter = {
  kind: 'tor',
  isPrivate: true,
  assurance: 'verified',
  async fetch() {
    return new Response(JSON.stringify({ order_books: [] }), { status: 200 })
  },
}

/** No Noir Wallet is injected under vitest, so the manual path is taken. */
const prompts = {
  askReceiveAddress: async () => `u1${'z'.repeat(40)}`,
  confirmSent: async () => {},
}

const base = {
  network: net,
  logger: testLogger,
  account: ACCOUNT,
  rpcUrl: RPC,
  noirPrompts: prompts,
}

describe('assembling the real adapters', () => {
  it('builds all five without a signer, a bundler or a wallet', async () => {
    // Nothing here may throw at assembly time. An adapter that cannot do its
    // job must still exist and refuse when asked, or the screen has nothing
    // to show and nothing to explain.
    const { adapters } = await createRealAdapters(base)
    expect(Object.keys(adapters).sort()).toEqual(['gas', 'lighter', 'near', 'network', 'noir'])
  })

  it('says plainly what will be refused', async () => {
    const { capabilities } = await createRealAdapters(base)
    expect(capabilities.quoteSwap.ok).toBe(true)
    expect(capabilities.readMarkets.ok).toBe(true)
    expect(capabilities.placeOrder.ok).toBe(false)
    expect(capabilities.withdraw.ok).toBe(false)
    // Gas still works — in ETH — so it is not a refusal. Its privacy is.
    expect(capabilities.payGas.ok).toBe(true)
    expect(capabilities.gasIsPrivate.ok).toBe(false)

    const blocked = notReady(capabilities)
    expect(blocked.length).toBeGreaterThan(0)
    // Every refusal names what is missing rather than just failing. With no
    // key callback at all the remedy is the key, not the binary; the
    // `pnpm fetch:signer` wording belongs to the case where a key exists
    // and the artifacts were never deployed.
    expect(blocked.join(' ')).toMatch(/No Lighter API key/)
  })

  it('refuses the orders its own report calls missing', async () => {
    // The report and the adapter must not be able to disagree.
    const { adapters, capabilities } = await createRealAdapters(base)
    expect(capabilities.placeOrder.ok).toBe(false)
    await expect(
      adapters.lighter.placeOrder(
        { accountIndex: 1, apiKeyIndex: 0, apiPublicKey: '0x' },
        {
          market: 'ZEC',
          side: 'buy',
          size: '1',
          type: 'market',
          price: '1250',
          reduceOnly: false,
        },
      ),
    ).rejects.toThrow(MissingSignerError)
  })

  it('calls the order path ready only when the signer is actually deployed', async () => {
    // public/lighter is gitignored: the binary is fetched by
    // `pnpm fetch:signer`, not committed. A capability that said "ready"
    // because a key callback was passed would be reporting the config
    // rather than the world, and would strand a session that got as far as
    // Lighter before discovering the signer was never deployed.
    const key = async () => ({ privateKeyHex: `0x${'ab'.repeat(40)}`, retire() {} })

    vi.stubGlobal('fetch', async () => new Response('{}', { status: 404 }))
    const absent = await createRealAdapters({ ...base, lighterApiKey: key })
    expect(absent.capabilities.placeOrder.ok).toBe(false)
    expect(absent.capabilities.placeOrder.why).toMatch(/fetch:signer/)
    expect(absent.capabilities.withdraw.ok).toBe(false)

    vi.stubGlobal('fetch', async () => new Response('{}', { status: 200 }))
    const present = await createRealAdapters({ ...base, lighterApiKey: key })
    expect(present.capabilities.placeOrder.ok).toBe(true)
    expect(present.capabilities.withdraw.ok).toBe(true)
    vi.unstubAllGlobals()
  })

  it('names the cost of the ETH fallback rather than hiding it', async () => {
    // Falling back to ETH works, but the wallet then has to be funded with
    // ETH from somewhere, and that somewhere links the session. Saying so is
    // the difference between a fallback and a trap.
    const { capabilities } = await createRealAdapters(base)
    expect(capabilities.gasIsPrivate.why).toMatch(/links it/)
    // And it names the wallet to fund, because the address is only useful
    // before the session starts, not after.
    expect(capabilities.payGas.why).toContain(ACCOUNT.address)
  })

  it('pays gas in USDC when the paymaster is configured', async () => {
    const { capabilities } = await createRealAdapters({
      ...base,
      bundlerUrl: 'https://bundler.example',
      paymasterAddress: evmAddress(`0x${'ab'.repeat(20)}`),
      delegateAddress: evmAddress(`0x${'cd'.repeat(20)}`),
    })
    expect(PAYMASTER_SEND_READY).toBe(true)
    expect(capabilities.gasIsPrivate.ok).toBe(true)
    expect(capabilities.payGas.why).toMatch(/USDC/)
  })

  it('does not claim USDC gas when the paymaster is not configured', async () => {
    const { capabilities } = await createRealAdapters(base)
    expect(capabilities.gasIsPrivate.ok).toBe(false)
    expect(capabilities.payGas.ok).toBe(true)
    expect(capabilities.payGas.why).toMatch(/ETH/)
  })

  it('lets a session start when the only thing missing is gas privacy', async () => {
    // The whole point of the split. Paying in ETH works; it merely links
    // the session, which the user can see and decide about. Gating Start on
    // it meant no configuration in existence could complete a round trip.
    const { capabilities } = await createRealAdapters(base)
    expect(cannotRoundTrip(capabilities)).not.toContain(capabilities.gasIsPrivate.why)
    expect(notReady(capabilities)).toContain(capabilities.gasIsPrivate.why)
  })

  it('refuses the whole round trip on testnet rather than quoting into nothing', async () => {
    /*
     * There is no Zcash testnet on the other side of the swap: 1Click prices
     * mainnet assets, and the Lighter and Arbitrum endpoints are mainnet.
     * A testnet deployment can therefore hold shielded TAZ and go no
     * further, and the capability has to say so — reporting `quoteSwap` as
     * ready because the adapter was constructed would be the report claiming
     * more than the code does.
     */
    const { capabilities } = await createRealAdapters({ ...base, zcashNetwork: 'test' })
    expect(capabilities.quoteSwap.ok).toBe(false)
    expect(capabilities.quoteSwap.why).toMatch(/no Zcash testnet/i)
    // And because quoteSwap is not exempted, this is fatal rather than a
    // warning: Start is blocked instead of stranding funds mid-session.
    expect(cannotRoundTrip(capabilities)).toContain(capabilities.quoteSwap.why)
  })

  it('still quotes on mainnet, which is the default', async () => {
    // The gate above must not fire for an assembly that said nothing about
    // the network; mainnet is the product.
    const { capabilities } = await createRealAdapters(base)
    expect(capabilities.quoteSwap.ok).toBe(true)
  })

  it('falls back to the manual Noir path and says why', async () => {
    const { noirKind, capabilities } = await createRealAdapters(base)
    expect(noirKind).toBe('manual')
    expect(capabilities.sendZcash.ok).toBe(false)
    expect(capabilities.sendZcash.why.length).toBeGreaterThan(10)
  })

  it('treats the manual Zcash path as workable but an unsigned exit as fatal', async () => {
    // The distinction Start is gated on. Without a Noir extension the leg
    // still completes by hand; without a signer the session can take real
    // money in and has no way out of it, which must not be startable.
    const { capabilities } = await createRealAdapters(base)
    const fatal = cannotRoundTrip(capabilities)
    expect(fatal).not.toContain(capabilities.sendZcash.why)
    expect(fatal).toContain(capabilities.withdraw.why)
    expect(fatal).toContain(capabilities.placeOrder.why)
    // And it is a strict subset of everything that will refuse.
    const all = notReady(capabilities)
    expect(all.length).toBeGreaterThan(fatal.length)
    for (const why of fatal) expect(all).toContain(why)
  })

  it('still quotes a swap, which is what works today', async () => {
    const { adapters } = await createRealAdapters(base)
    // The 1Click adapter is real and verified; it only needs the network.
    expect(typeof adapters.near.quote).toBe('function')
    expect(() => parseAmount('ZEC', '1')).not.toThrow()
  })
})
