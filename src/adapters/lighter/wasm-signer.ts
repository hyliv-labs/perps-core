/**
 * Lighter's signer, in the browser.
 *
 * Lighter signs with a Go library and its JavaScript packages carry no
 * signer, which looked like the end of the "no backend, keys on device"
 * claim. It is not: Lighter publishes an official WebAssembly build of that
 * same Go signer, and this loads it.
 *
 * The argument lists below were read out of `web-wasm/main.go` at the pinned
 * commit, not inferred. Two things that reading settled, both of which the
 * first version of this file had wrong:
 *
 *   - **Every export returns a Promise**, not a string. `promiseResult` in
 *     the Go source wraps each one.
 *   - **`_createClientByPrv` takes no API URL.** Its arguments are the key,
 *     the chain id, the account index, a nonce and the API key index, in
 *     that order.
 *
 * Two things are deliberate here.
 *
 * **The hashes are checked again.** `scripts/fetch-lighter-signer.mjs`
 * verifies them on download, which says nothing about what a CDN serves a
 * month later. This binary is handed session keys, so it is hashed once more
 * before it is instantiated and refused on mismatch.
 *
 * **The key never leaves this module.** It crosses into WASM once, when the
 * client is made, and nothing here returns it, logs it, or puts it on an
 * object the rest of the app holds.
 */

import type { LighterSigner, SignedTx } from './http'

/** From web-wasm/main.manifest.json at commit ca5690f2, built with go1.26.8. */
export const PINNED = {
  wasmSha256: '6e24ad64ecbf16fc35c1a381ddf0acce0e3c564a32fe6c116ffd29e9df723c5b',
  runtimeSha256: '0c949f4996f9a89698e4b5c586de32249c3b69b7baadb64d220073cc04acba14',
  sourceCommit: 'ca5690f29f51197e844e1b4d7f2e455b56fc4785',
} as const

/**
 * Lighter's own default: ask it to pick, rather than inventing an expiry.
 *
 * Zero, not -1. The Python SDK's "no expiry" sentinel is -1 and this file
 * used it; the pinned WASM answers `OrderExpiry is invalid` to -1 and
 * accepts 0. Every order this app placed would have been refused by the
 * signer, before Lighter ever saw it.
 */
export const ORDER_EXPIRY_DEFAULT = 0

/**
 * The chain id the signature is bound to.
 *
 * Lighter's own, not Arbitrum's. 42161 is where the USDC deposit comes
 * from; signing against it would produce a valid signature in the wrong
 * domain. From lighter-python's signer_client: 304 for mainnet.zklighter.
 */
export const LIGHTER_CHAIN_ID = 304

export class SignerIntegrityError extends Error {
  override readonly name = 'SignerIntegrityError'
  constructor(what: string, expected: string, got: string) {
    super(
      `the Lighter ${what} is not the file we pinned (expected ${expected.slice(0, 12)}…, ` +
        `got ${got.slice(0, 12)}…). It will not be loaded.`,
    )
  }
}

export class SignerError extends Error {
  override readonly name = 'SignerError'
}

/** The exports this file uses, out of the thirty-odd the manifest lists. */
export interface LighterExports {
  _createClientByPrv: (...args: unknown[]) => unknown
  _getChangePubKeyTransaction: (...args: unknown[]) => unknown
  _resetClients?: (...args: unknown[]) => unknown
  _signCreateOrder: (...args: unknown[]) => unknown
  _signCancelAllOrders: (...args: unknown[]) => unknown
  _signWithdraw: (...args: unknown[]) => unknown
  _signUpdateLeverage: (...args: unknown[]) => unknown
  _signChangePubKey: (...args: unknown[]) => unknown
  _createAuthToken: (...args: unknown[]) => unknown
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function fetchVerified(url: string, expected: string, what: string): Promise<ArrayBuffer> {
  const response = await fetch(url)
  if (!response.ok) throw new SignerError(`${what}: ${response.status} from ${url}`)
  const bytes = await response.arrayBuffer()
  const got = await sha256Hex(bytes)
  if (got !== expected) throw new SignerIntegrityError(what, expected, got)
  return bytes
}

/** Load the Go runtime and the signer, verifying both on the way in. */
async function defaultInstantiate(basePath: string): Promise<LighterExports> {
  const runtime = await fetchVerified(
    `${basePath}/wasm_exec.js`,
    PINNED.runtimeSha256,
    'WebAssembly runtime',
  )
  // Go's runtime defines a global `Go`; it is a script, not a module, so it
  // is run rather than imported — and only after its hash has been checked.
  new Function(new TextDecoder().decode(runtime))()

  const GoCtor = (
    globalThis as {
      Go?: new () => { importObject: WebAssembly.Imports; run(i: WebAssembly.Instance): void }
    }
  ).Go
  if (!GoCtor) throw new SignerError('the Go runtime did not define its global')

  const wasm = await fetchVerified(`${basePath}/main.wasm`, PINNED.wasmSha256, 'signer')
  const go = new GoCtor()
  const { instance } = await WebAssembly.instantiate(wasm, go.importObject)
  // Go's main() registers the exports and then blocks, so it is not awaited.
  void go.run(instance)

  const exports = globalThis as unknown as Partial<LighterExports>
  if (typeof exports._createClientByPrv !== 'function') {
    throw new SignerError('the signer did not register its exports')
  }
  return exports as LighterExports
}

/**
 * Unwrap one call into the Go side.
 *
 * Each export is curried: calling `_signCreateOrder(args…)` returns a bound
 * function, and calling *that* returns the promise. This file previously
 * awaited the first value, which is a function and therefore never a
 * rejection and never an `{error}` — so every signature would have been
 * read as success and submitted as `undefined`. Verified against the pinned
 * binary under Node.
 */
async function settle(raw: unknown, what: string): Promise<Record<string, unknown>> {
  const value = await Promise.resolve(typeof raw === 'function' ? (raw as () => unknown)() : raw)
  const parsed: unknown = typeof value === 'string' ? safeParse(value) : value
  if (parsed && typeof parsed === 'object') {
    const record = parsed as Record<string, unknown>
    // An error returned as a signature would be submitted as one.
    // Go spells it `error`; an older reading of main.go had `err`, and the
    // difference is a rejected transaction submitted as a signed one.
    const failure = record.error ?? record.err
    if (failure) throw new SignerError(`${what} failed: ${String(failure)}`)
    return record
  }
  throw new SignerError(`${what} returned something unreadable`)
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return { str: text }
  }
}

function toSignedTx(record: Record<string, unknown>): SignedTx {
  const txInfo = record.txInfo ?? record.tx_info ?? record.str
  if (typeof txInfo !== 'string') throw new SignerError('the signer returned no transaction')
  return {
    txInfo,
    ...(typeof record.txType === 'number' ? { txType: record.txType } : {}),
    ...(typeof record.signature === 'string' ? { signature: record.signature } : {}),
  }
}

/**
 * One instantiation per page.
 *
 * `defaultInstantiate` re-runs the Go runtime and `go.run`, which replaces
 * the globals and the client map the previous call registered. Two sessions,
 * or one session after a reconnect, would silently tear down the first
 * client. The exports are global either way, so they are cached here.
 */
let loaded: Promise<LighterExports> | null = null

export function loadSigner(
  basePath = '/lighter',
  instantiate: (basePath: string) => Promise<LighterExports> = defaultInstantiate,
): Promise<LighterExports> {
  loaded ??= instantiate(basePath).catch((error: unknown) => {
    // A failed load must not be cached as a permanent failure: the artifacts
    // may simply not have been fetched yet.
    loaded = null
    throw error
  })
  return loaded
}

/** Only for tests, which need a clean global between cases. */
export function forgetSigner(): void {
  loaded = null
}

export interface WasmSignerOptions {
  /** Where the fetched artifacts are served from. */
  readonly basePath?: string
  /** Lighter's own chain id, not the deposit chain's. */
  readonly chainId?: number
  readonly accountIndex: number
  readonly apiKeyIndex: number
  /** Nonce the client is created against. */
  readonly nonce?: number
  /**
   * The Lighter API key, 0x-prefixed, 40 bytes.
   *
   * Crosses into WASM once, here, and is not retained by this module. It is
   * NOT the EVM session key: Lighter's signer refuses a 32-byte key.
   */
  readonly privateKey: string
  /** Swappable so this is testable without the 7.7 MB binary. */
  readonly instantiate?: (basePath: string) => Promise<LighterExports>
}

export async function createWasmSigner(options: WasmSignerOptions): Promise<LighterSigner> {
  const basePath = options.basePath ?? '/lighter'
  const api = await loadSigner(basePath, options.instantiate ?? defaultInstantiate)
  const account = options.accountIndex

  // (prv, chainId, accountIndex, nonce, apiKeyIndex) — read from main.go.
  // The key is passed here and nowhere else.
  const created = await settle(
    api._createClientByPrv(
      options.privateKey,
      options.chainId ?? LIGHTER_CHAIN_ID,
      account,
      options.nonce ?? 0,
      options.apiKeyIndex,
    ),
    'creating the signing client',
  )

  /*
   * The public key comes back from the client, it is not supplied.
   *
   * This used to be a caller-provided option, which meant the caller had to
   * know a key only the signer can derive — there is no export that derives
   * one. Reading it here is also what lets a resumed session check that the
   * key it just rebuilt is the key the account was registered with.
   *
   * The record also echoes `prv`. It is deliberately not read, not logged
   * and not returned.
   */
  const pk = created.pk
  if (typeof pk !== 'string' || pk.length === 0) {
    throw new SignerError('the signer did not return a public key')
  }

  return {
    kind: 'wasm',
    apiPublicKey: pk,

    async changePubKeyBody({ nonce, apiKeyIndex }) {
      const record = await settle(
        api._getChangePubKeyTransaction(account, nonce, apiKeyIndex ?? options.apiKeyIndex),
        'reading the registration message',
      )
      const body = record.body
      if (typeof body !== 'string' || body.length === 0) {
        throw new SignerError('the signer gave no message to sign')
      }
      return body
    },

    async changePubKey({ signedMessage, nonce, apiKeyIndex }) {
      return toSignedTx(
        await settle(
          api._signChangePubKey(account, signedMessage, nonce, apiKeyIndex ?? options.apiKeyIndex),
          'registering the API key',
        ),
      )
    },

    async createOrder(order) {
      return toSignedTx(
        await settle(
          api._signCreateOrder(
            account,
            order.marketIndex,
            order.clientOrderIndex,
            order.baseAmount,
            order.price,
            order.isAsk ? 1 : 0,
            order.orderType,
            order.timeInForce,
            order.reduceOnly ? 1 : 0,
            order.triggerPrice ?? '0',
            order.orderExpiry ?? ORDER_EXPIRY_DEFAULT,
            order.nonce,
          ),
          'signing an order',
        ),
      )
    },

    async cancelAllOrders({ timeInForce, time, nonce }) {
      return toSignedTx(
        await settle(
          api._signCancelAllOrders(account, timeInForce, time, nonce),
          'cancelling orders',
        ),
      )
    },

    async withdraw({ assetIndex, routeType, amount, nonce }) {
      return toSignedTx(
        await settle(
          api._signWithdraw(account, assetIndex, routeType, amount, nonce),
          'signing a withdrawal',
        ),
      )
    },

    async updateLeverage({ marketIndex, initialMarginFraction, marginMode, nonce }) {
      // _signUpdateLeverage(accountIndex, marketIndex, imf, marginMode, nonce),
      // read from web-wasm/main.go at the pinned commit.
      return toSignedTx(
        await settle(
          api._signUpdateLeverage(account, marketIndex, initialMarginFraction, marginMode, nonce),
          'setting leverage',
        ),
      )
    },

    async authToken(args) {
      const record = await settle(
        api._createAuthToken(account, args?.apiKeyIndex ?? options.apiKeyIndex),
        'creating an auth token',
      )
      const token = record.str ?? record.authToken ?? record.token
      if (typeof token !== 'string') throw new SignerError('no auth token was returned')
      return token
    },
  }
}
