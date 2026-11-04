import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { createWasmSigner, forgetSigner } from '@/adapters/lighter/wasm-signer'

/**
 * The signer, against the real binary.
 *
 * Every other test here runs on a stub of Lighter's exports, which means it
 * checks that this code does what we *believe* the binary does. That belief
 * was wrong four separate ways, and each way would have surfaced only with
 * money on the exchange. This test closes that gap for everything except
 * the nonce and the account, which need a funded account.
 *
 * It skips when `public/lighter/` is empty, because that directory is
 * gitignored: the 7.7 MB binary is fetched by `pnpm fetch:signer` and is
 * not in the repository. A skip here is exactly the condition that makes
 * `placeOrder` and `withdraw` report themselves unavailable.
 */

const BASE = join(process.cwd(), 'public', 'lighter')
const present = existsSync(join(BASE, 'main.wasm')) && existsSync(join(BASE, 'wasm_exec.js'))

/** Serve the pinned artifacts off disk, so the hash check runs for real. */
function serveFromDisk() {
  vi.stubGlobal('fetch', async (url: string) => {
    const name = String(url).split('/').pop()!
    return new Response(readFileSync(join(BASE, name)))
  })
}

describe.skipIf(!present)('the Lighter signer, against the pinned binary', () => {
  beforeAll(() => {
    // Go's runtime reaches for these when it runs outside a browser.
    const req = createRequire(import.meta.url)
    const g = globalThis as unknown as Record<string, unknown>
    g.require ??= req
    g.fs ??= req('node:fs')
    g.path ??= req('node:path')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    forgetSigner()
  })

  it('loads, verifies both hashes, and derives its own public key', async () => {
    serveFromDisk()
    const signer = await createWasmSigner({
      accountIndex: 1,
      apiKeyIndex: 0,
      privateKey: `0x${'11'.repeat(40)}`,
    })
    // 40 bytes in, 40 bytes of public key out.
    expect(signer.apiPublicKey).toMatch(/^[0-9a-f]{80}$/)
  })

  it('refuses a 32-byte key, which is why the EVM key cannot be reused', async () => {
    serveFromDisk()
    await expect(
      createWasmSigner({ accountIndex: 1, apiKeyIndex: 0, privateKey: `0x${'11'.repeat(32)}` }),
    ).rejects.toThrow(/40 bytes/)
  })

  it('returns plain text to sign, not typed data', async () => {
    serveFromDisk()
    const signer = await createWasmSigner({
      accountIndex: 1,
      apiKeyIndex: 0,
      privateKey: `0x${'11'.repeat(40)}`,
    })
    const body = await signer.changePubKeyBody({ nonce: 0, apiKeyIndex: 0 })
    expect(body).toMatch(/^Register Lighter Account/)
    expect(body).toContain(signer.apiPublicKey)
    // personal_sign, so it must not be JSON typed data.
    expect(() => JSON.parse(body)).toThrow()
  })

  it('signs an order, a cancel, a leverage change and a withdrawal', async () => {
    serveFromDisk()
    const signer = await createWasmSigner({
      accountIndex: 1,
      apiKeyIndex: 0,
      privateKey: `0x${'11'.repeat(40)}`,
    })

    const order = await signer.createOrder({
      marketIndex: 90,
      clientOrderIndex: 1,
      baseAmount: '1000',
      price: '50000',
      isAsk: false,
      orderType: 0,
      timeInForce: 0,
      reduceOnly: false,
      nonce: 0,
    })
    expect(JSON.parse(order.txInfo)).toMatchObject({ AccountIndex: 1, MarketIndex: 90 })

    const cancel = await signer.cancelAllOrders({ timeInForce: 0, time: 0, nonce: 0 })
    expect(JSON.parse(cancel.txInfo)).toHaveProperty('Sig')

    const leverage = await signer.updateLeverage({
      marketIndex: 90,
      initialMarginFraction: 1000,
      marginMode: 1,
      nonce: 0,
    })
    expect(JSON.parse(leverage.txInfo)).toMatchObject({ InitialMarginFraction: 1000 })

    // Asset 3 is USDC; the signer refuses anything below 1 outright.
    const withdrawal = await signer.withdraw({
      assetIndex: 3,
      routeType: 0,
      amount: '4000000',
      nonce: 0,
    })
    expect(JSON.parse(withdrawal.txInfo)).toMatchObject({ AssetIndex: 3, Amount: 4000000 })
  })

  it('rejects the order expiry this code used to send', async () => {
    serveFromDisk()
    const signer = await createWasmSigner({
      accountIndex: 1,
      apiKeyIndex: 0,
      privateKey: `0x${'11'.repeat(40)}`,
    })
    await expect(
      signer.createOrder({
        marketIndex: 90,
        clientOrderIndex: 1,
        baseAmount: '1000',
        price: '50000',
        isAsk: false,
        orderType: 0,
        timeInForce: 0,
        reduceOnly: false,
        orderExpiry: -1,
        nonce: 0,
      }),
    ).rejects.toThrow(/OrderExpiry is invalid/)
  })

  it('issues an auth token in Lighter’s documented shape', async () => {
    serveFromDisk()
    const signer = await createWasmSigner({
      accountIndex: 1,
      apiKeyIndex: 0,
      privateKey: `0x${'11'.repeat(40)}`,
    })
    // expiry:accountIndex:apiKeyIndex:signature
    expect(await signer.authToken()).toMatch(/^\d+:1:0:[0-9a-f]+$/)
  })
})
