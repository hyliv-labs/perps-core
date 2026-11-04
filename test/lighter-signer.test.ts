import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest'
import {
  LIGHTER_CHAIN_ID,
  ORDER_EXPIRY_DEFAULT,
  PINNED,
  SignerError,
  SignerIntegrityError,
  createWasmSigner,
  forgetSigner,
  type LighterExports,
} from '@/adapters/lighter/wasm-signer'

/**
 * The signer, against what the pinned binary actually does.
 *
 * Everything asserted here was read out of `public/lighter/main.wasm` by
 * running it under Node, not inferred from the Go source. Four things that
 * reading overturned, each of which would have failed only with money on
 * the exchange:
 *
 *   - **The exports are curried.** `_signCreateOrder(args…)` returns a bound
 *     function; calling *that* returns the promise. Awaiting the first value
 *     yields a function, which is never a rejection and never carries an
 *     `error`, so every failure would have read as success.
 *   - **Failure is spelled `error`, not `err`.**
 *   - **The public key is returned, not supplied.** `_createClientByPrv`
 *     answers `{success, pk, prv, body}`. There is no export that derives a
 *     public key from a private one, so a caller could not have known it.
 *   - **`orderExpiry: -1` is rejected** with "OrderExpiry is invalid". Zero
 *     is the accepted default.
 */

afterEach(() => vi.restoreAllMocks())
// The exports are global to the page, so the module caches them. Tests need
// a clean one each time or the first stub would serve every case.
beforeEach(() => forgetSigner())

const PRV = `0x${'ab'.repeat(40)}`
const PK = '44deab6d577184dafa2f73eb64ebd1cee338cbc94469ca48af9a816b6ad25685cef154524558a3fb'
const BODY = `Register Lighter Account\n\npubkey: 0x${PK}\nnonce: 0x0000000000000000`

const BASE = {
  accountIndex: 1001,
  apiKeyIndex: 2,
  privateKey: PRV,
}

function stub(overrides: Partial<Record<keyof LighterExports, unknown>> = {}) {
  const calls: { fn: string; args: unknown[] }[] = []
  /** Curried, exactly as the Go side registers it. */
  const make =
    (fn: string, reply: unknown) =>
    (...args: unknown[]) => {
      calls.push({ fn, args })
      return () => Promise.resolve(reply)
    }
  const exports = {
    _createClientByPrv: make('_createClientByPrv', { success: true, pk: PK, prv: PRV.slice(2) }),
    _getChangePubKeyTransaction: make('_getChangePubKeyTransaction', { success: true, pk: PK, body: BODY }),
    _signCreateOrder: make('_signCreateOrder', { txHash: '0xa', txInfo: '{"order":1}' }),
    _signCancelAllOrders: make('_signCancelAllOrders', { txInfo: '{"cancel":1}' }),
    _signWithdraw: make('_signWithdraw', { txInfo: '{"withdraw":1}' }),
    _signChangePubKey: make('_signChangePubKey', { txInfo: '{"key":1}' }),
    _signUpdateLeverage: make('_signUpdateLeverage', { txInfo: '{"lev":1}' }),
    _createAuthToken: make('_createAuthToken', { token: 'token-abc' }),
    ...overrides,
  } as unknown as LighterExports
  return { calls, exports, instantiate: async () => exports }
}

/** A curried reply, for overrides. */
const reply = (value: unknown) => () => () => Promise.resolve(value)

describe('the Lighter WASM signer', () => {
  describe('the key', () => {
    it('crosses into WASM exactly once, when the client is made', async () => {
      const s = stub()
      const signer = await createWasmSigner({ ...BASE, instantiate: s.instantiate })
      await signer.createOrder({
        marketIndex: 0,
        clientOrderIndex: 1,
        baseAmount: '2000',
        price: '311840',
        isAsk: false,
        orderType: 0,
        timeInForce: 0,
        reduceOnly: false,
        nonce: 5,
      })
      await signer.withdraw({ assetIndex: 3, routeType: 0, amount: '4000000', nonce: 6 })

      const withKey = s.calls.filter((c) => c.args.includes(PRV))
      expect(withKey).toHaveLength(1)
      expect(withKey[0]!.fn).toBe('_createClientByPrv')
    })

    it('never lands on the object the app holds', async () => {
      const signer = await createWasmSigner({ ...BASE, instantiate: stub().instantiate })
      expect(JSON.stringify(signer)).not.toContain('abab')
    })

    it('does not keep the private key the client echoes back', async () => {
      // `_createClientByPrv` returns `prv` alongside `pk`. Reading the whole
      // record onto the signer would put the key back in the app's hands.
      const signer = await createWasmSigner({ ...BASE, instantiate: stub().instantiate })
      expect(JSON.stringify(signer)).not.toContain(PRV.slice(2, 20))
    })
  })

  describe('the public key', () => {
    it('comes from the client rather than from the caller', async () => {
      // There is no export that derives one, so the caller cannot supply it.
      const signer = await createWasmSigner({ ...BASE, instantiate: stub().instantiate })
      expect(signer.apiPublicKey).toBe(PK)
    })

    it('refuses a client that returned none', async () => {
      const s = stub({ _createClientByPrv: reply({ success: true }) })
      await expect(createWasmSigner({ ...BASE, instantiate: s.instantiate })).rejects.toThrow(
        /did not return a public key/,
      )
    })
  })

  describe('the registration message', () => {
    it('hands back the text the L1 wallet has to sign', async () => {
      const signer = await createWasmSigner({ ...BASE, instantiate: stub().instantiate })
      const body = await signer.changePubKeyBody({ nonce: 0, apiKeyIndex: 2 })
      // Plain text, so it is personal_sign and not typed data.
      expect(body).toMatch(/^Register Lighter Account/)
      expect(body).toContain(PK)
    })

    it('refuses to proceed when the signer gives no message', async () => {
      const s = stub({ _getChangePubKeyTransaction: reply({ success: true }) })
      const signer = await createWasmSigner({ ...BASE, instantiate: s.instantiate })
      await expect(signer.changePubKeyBody({ nonce: 0 })).rejects.toThrow(/no message to sign/)
    })
  })

  describe('argument order, read from main.go', () => {
    it('creates the client as (prv, chainId, accountIndex, nonce, apiKeyIndex)', async () => {
      const s = stub()
      await createWasmSigner({ ...BASE, nonce: 9, instantiate: s.instantiate })
      // There is no API URL argument, which an earlier version wrongly passed.
      expect(s.calls[0]!.args).toEqual([PRV, LIGHTER_CHAIN_ID, 1001, 9, 2])
    })

    it('signs against Lighter’s chain id, not the deposit chain’s', async () => {
      const s = stub()
      await createWasmSigner({ ...BASE, instantiate: s.instantiate })
      expect(s.calls[0]!.args[1]).toBe(304)
      expect(s.calls[0]!.args[1]).not.toBe(42161)
    })

    it('places the order fields where Lighter expects them', async () => {
      const s = stub()
      const signer = await createWasmSigner({ ...BASE, instantiate: s.instantiate })
      await signer.createOrder({
        marketIndex: 0,
        clientOrderIndex: 7,
        baseAmount: '2000',
        price: '311840',
        isAsk: true,
        orderType: 1,
        timeInForce: 2,
        reduceOnly: true,
        nonce: 5,
      })
      const call = s.calls.find((c) => c.fn === '_signCreateOrder')!
      // accountIndex, market, clientOrderIndex, base, price, isAsk, type,
      // tif, reduceOnly, trigger, expiry, nonce
      expect(call.args).toEqual([1001, 0, 7, '2000', '311840', 1, 1, 2, 1, '0', ORDER_EXPIRY_DEFAULT, 5])
    })

    it('defaults the expiry to 0, which is the only value accepted', async () => {
      // -1 is the Python SDK's sentinel and this file used it; the binary
      // answers "OrderExpiry is invalid", so every order would have failed.
      expect(ORDER_EXPIRY_DEFAULT).toBe(0)
    })

    it('sends booleans as the 0 or 1 the signer reads', async () => {
      const s = stub()
      const signer = await createWasmSigner({ ...BASE, instantiate: s.instantiate })
      await signer.createOrder({
        marketIndex: 0,
        clientOrderIndex: 1,
        baseAmount: '1',
        price: '1',
        isAsk: false,
        orderType: 0,
        timeInForce: 0,
        reduceOnly: false,
        nonce: 1,
      })
      const call = s.calls.find((c) => c.fn === '_signCreateOrder')!
      expect(call.args[5]).toBe(0)
      expect(call.args[8]).toBe(0)
    })

    it('withdraws as (accountIndex, assetIndex, routeType, amount, nonce)', async () => {
      const s = stub()
      const signer = await createWasmSigner({ ...BASE, instantiate: s.instantiate })
      await signer.withdraw({ assetIndex: 3, routeType: 1, amount: '4000000', nonce: 3 })
      expect(s.calls.find((c) => c.fn === '_signWithdraw')!.args).toEqual([
        1001, 3, 1, '4000000', 3,
      ])
    })

    it('cancels as (accountIndex, timeInForce, time, nonce)', async () => {
      const s = stub()
      const signer = await createWasmSigner({ ...BASE, instantiate: s.instantiate })
      await signer.cancelAllOrders({ timeInForce: 0, time: 1700, nonce: 4 })
      expect(s.calls.find((c) => c.fn === '_signCancelAllOrders')!.args).toEqual([
        1001, 0, 1700, 4,
      ])
    })
  })

  describe('results', () => {
    it('returns the transaction to submit', async () => {
      const signer = await createWasmSigner({ ...BASE, instantiate: stub().instantiate })
      const tx = await signer.createOrder({
        marketIndex: 0,
        clientOrderIndex: 1,
        baseAmount: '1',
        price: '1',
        isAsk: false,
        orderType: 0,
        timeInForce: 0,
        reduceOnly: false,
        nonce: 1,
      })
      // No txType: the binary does not return one, so the adapter supplies it.
      expect(tx.txInfo).toBe('{"order":1}')
      expect(tx.txType).toBeUndefined()
    })

    it('returns an auth token as a string', async () => {
      const signer = await createWasmSigner({ ...BASE, instantiate: stub().instantiate })
      expect(await signer.authToken()).toBe('token-abc')
    })

    it('throws on an error rather than submitting it as a signature', async () => {
      // Spelled `error` by the Go side. Matching only `err` meant a refusal
      // was read as a signed transaction and posted to sendTx.
      const s = stub({ _signWithdraw: reply({ error: 'bad nonce' }) })
      const signer = await createWasmSigner({ ...BASE, instantiate: s.instantiate })
      await expect(
        signer.withdraw({ assetIndex: 3, routeType: 0, amount: '1', nonce: 1 }),
      ).rejects.toThrow(/bad nonce/)
    })

    it('fails loudly when the client cannot be created', async () => {
      const s = stub({ _createClientByPrv: reply({ error: 'private key length is not 40 bytes' }) })
      await expect(createWasmSigner({ ...BASE, instantiate: s.instantiate })).rejects.toThrow(
        /40 bytes/,
      )
    })

    it('refuses a reply with no transaction in it', async () => {
      const s = stub({ _signWithdraw: reply({ success: true }) })
      const signer = await createWasmSigner({ ...BASE, instantiate: s.instantiate })
      await expect(
        signer.withdraw({ assetIndex: 3, routeType: 0, amount: '1', nonce: 1 }),
      ).rejects.toThrow(SignerError)
    })
  })

  describe('loading', () => {
    it('instantiates once however many signers are built', async () => {
      // Re-running the Go runtime replaces the globals and the client map,
      // so a second session would tear down the first session's client.
      let loads = 0
      const s = stub()
      const instantiate = async () => {
        loads += 1
        return s.exports
      }
      await createWasmSigner({ ...BASE, instantiate })
      await createWasmSigner({ ...BASE, accountIndex: 2002, instantiate })
      expect(loads).toBe(1)
    })

    it('does not remember a failed load as permanent', async () => {
      // The artifacts may simply not have been fetched yet.
      let attempt = 0
      const s = stub()
      const instantiate = async () => {
        attempt += 1
        if (attempt === 1) throw new SignerError('not fetched')
        return s.exports
      }
      await expect(createWasmSigner({ ...BASE, instantiate })).rejects.toThrow(/not fetched/)
      await expect(createWasmSigner({ ...BASE, instantiate })).resolves.toBeDefined()
    })
  })

  describe('integrity', () => {
    it('pins what the fetch script wrote', () => {
      expect(PINNED.wasmSha256).toBe(
        '6e24ad64ecbf16fc35c1a381ddf0acce0e3c564a32fe6c116ffd29e9df723c5b',
      )
      expect(PINNED.sourceCommit).toBe('ca5690f29f51197e844e1b4d7f2e455b56fc4785')
    })

    it('refuses a binary whose hash does not match', async () => {
      // Whatever a CDN serves a month from now, this binary gets session keys.
      vi.stubGlobal('fetch', async () => new Response(new Uint8Array([1, 2, 3])))
      await expect(createWasmSigner(BASE)).rejects.toThrow(SignerIntegrityError)
    })

    it('names the artifact without dumping it', async () => {
      vi.stubGlobal('fetch', async () => new Response(new Uint8Array([9])))
      const error = (await createWasmSigner(BASE).catch((e: unknown) => e)) as Error
      expect(error.message).toMatch(/runtime|signer/)
      expect(error.message).toMatch(/will not be loaded/)
    })
  })
})
