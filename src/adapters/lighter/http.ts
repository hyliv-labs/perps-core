/**
 * Lighter, over HTTP.
 *
 * Verified against the live API on 2026-10-26 (spikes/04-lighter-roundtrip.ts):
 *
 *   GET /api/v1/orderBooks -> 200, 246 markets, every one 0.0000/0.0000
 *   GET /api/v1/status     -> 403 without credentials, so it is no use as a
 *                             reachability check
 *   POST /api/v1/sendTx    -> where a signed transaction goes
 *
 * ## The signing problem
 *
 * Lighter does not sign in JavaScript. Its own TypeScript package
 * (`zklighter-perps`) is an OpenAPI client with no signer in it at all, and
 * the only TypeScript SDK that does sign reaches a native library through
 * FFI, which a browser cannot do. The Python and Go SDKs ship compiled
 * signer binaries.
 *
 * So this adapter does every read itself and takes signing as a dependency
 * it refuses to fake. Without a signer it answers the public questions and
 * declines the rest, naming the reason. When a WASM build of Lighter's Go
 * signer exists, it implements `LighterSigner` and drops in here; nothing
 * else changes.
 *
 * Declining loudly is the point. A signer quietly stubbed out would read as
 * working right up until it moved someone's money.
 */

import type { LighterAdapter, NetworkAdapter, OrderRequest, Position } from '../types'
import type { LighterAccount } from '@/core/session'
import type { Amount, EvmAddress } from '@/core/types'
import { ASSETS, amount } from '@/core/types'
import type { Logger } from '@/core/log'

export const LIGHTER_API = 'https://mainnet.zklighter.elliot.ai'

/** Confirmed live: fees are zero on every market, maker and taker alike. */
export interface Market {
  readonly symbol: string
  readonly marketId: number
  readonly status: string
  readonly takerFee: string
  readonly makerFee: string
  readonly minBaseAmount: string
  readonly minQuoteAmount: string
  readonly sizeDecimals: number
  readonly priceDecimals: number
}

/** Shapes read from the live API on 2026-10-27, not guessed. */
export interface RawPosition {
  market_id: number
  symbol: string
  /** 1 long, -1 short. The size itself carries no sign. */
  sign: number
  position: string
  avg_entry_price: string
  unrealized_pnl: string
  liquidation_price: string
}

export interface RawAccount {
  account_index: number
  collateral: string
  available_balance: string
  positions: RawPosition[]
}

interface RawOrderBook {
  symbol: string
  market_id: number
  status: string
  taker_fee: string
  maker_fee: string
  min_base_amount: string
  min_quote_amount: string
  supported_size_decimals: number
  supported_price_decimals: number
}

/**
 * What a signer must be able to do.
 *
 * Every argument is named rather than positional. Lighter's own exports take
 * twelve positional arguments for an order, where swapping `isAsk` and
 * `orderType` would still produce a perfectly valid signature — for the
 * wrong order. Naming them is the cheapest way to never make that mistake.
 *
 * The signer never hands a key back and the adapter never sees one.
 */
export interface LighterSigner {
  readonly kind: 'wasm' | 'local-helper'
  /** The public half, which the account carries and the API knows it by. */
  readonly apiPublicKey: string

  /**
   * The message the L1 wallet must sign to register this API key.
   *
   * Lighter's own words: generating an API key needs no L1 key, but
   * *associating* it with an account does. The body is plain text — an
   * EIP-191 personal_sign message beginning "Register Lighter Account",
   * verified against the pinned signer — so it is signed with the session's
   * EVM key, not with typed data.
   */
  changePubKeyBody(args: { nonce: number; apiKeyIndex?: number }): Promise<string>

  /** Registers this session's key against the account. */
  changePubKey(args: {
    signedMessage: string
    nonce: number
    apiKeyIndex?: number
  }): Promise<SignedTx>

  createOrder(args: {
    marketIndex: number
    clientOrderIndex: number
    /** Integer strings in the market's own units, never floats. */
    baseAmount: string
    price: string
    isAsk: boolean
    orderType: number
    timeInForce: number
    reduceOnly: boolean
    triggerPrice?: string
    /** -1 asks Lighter for its own default of 28 days. */
    orderExpiry?: number
    nonce: number
  }): Promise<SignedTx>

  cancelAllOrders(args: {
    timeInForce: number
    time: number
    nonce: number
  }): Promise<SignedTx>

  withdraw(args: {
    assetIndex: number
    routeType: number
    amount: string
    nonce: number
  }): Promise<SignedTx>

  /**
   * Leverage on Lighter is a per-market account setting with its own
   * transaction type, not a field on an order. Without this operation a
   * leverage control would be a control that lies.
   */
  updateLeverage(args: {
    marketIndex: number
    /** 10_000 / leverage, never below the market's `min_initial_margin_fraction`. */
    initialMarginFraction: number
    /** 0 cross, 1 isolated. */
    marginMode: number
    nonce: number
  }): Promise<SignedTx>

  authToken(args?: { apiKeyIndex?: number }): Promise<string>
}

/** What Lighter's signer returns: a transaction ready for /api/v1/sendTx. */
export interface SignedTx {
  readonly txType?: number
  readonly txInfo: string
  readonly signature?: string
}

export class MissingSignerError extends Error {
  override readonly name = 'MissingSignerError'
  constructor(action: string) {
    super(
      `${action} needs a Lighter signer, and none is configured. Lighter signs with a ` +
        'native library its JavaScript packages do not carry; a WebAssembly build of its Go ' +
        'signer would satisfy LighterSigner and be used here.',
    )
  }
}

/**
 * How far from the mark a close-out order may sweep.
 *
 * Wide, deliberately: a close that does not fill is worse than one that fills
 * badly, because the session is trying to leave.
 */
export const CLOSE_BOUND_BPS = 200

/** Lighter takes deposits from Arbitrum One, among others. */
export const ARBITRUM_CHAIN_ID = 42161

/**
 * USDC on Lighter, and the fast route.
 *
 * Three, read from /api/v1/assetDetails on 2026-10-28: ETH is 1, USDC is 3.
 * This said 0, and the signer refuses any index below 1 outright
 * ("AssetIndex should not be less than 1"), so every withdrawal would have
 * failed at the last step of the session — with the money already on
 * Lighter and the exit the only thing left to do.
 */
export const USDC_ASSET_INDEX = 3
/**
 * The route asked for on a withdrawal.
 *
 * Named "fast" from the venue's own documentation, and on 2026-11-04 a
 * withdrawal sent with this value came back from the withdrawal history as
 * `type: "secure"`. So either the value does not mean what the name says,
 * or the fast route was declined and quietly downgraded. Either way the
 * caller cannot assume a fast settlement, and `withdrawalStatus` logs when
 * the type that comes back is not `fast`.
 */
export const FAST_WITHDRAWAL_ROUTE = 0

/**
 * Cancel every resting order now, rather than at a scheduled time.
 *
 * Named because the pairing is not obvious: with this, the transaction's
 * cancel-all time must be zero. Sending a timestamp alongside it is
 * refused with `CancelAllTime should be nil`.
 */
export const CANCEL_IMMEDIATE = 0

/**
 * Transaction types, from lighter-go types/txtypes/constants.go at the
 * pinned commit.
 *
 * The signer does not return one — it answers `{txHash, txInfo}` — so the
 * caller supplies it. Reading it off the signer's record, as this adapter
 * did, meant `submit` threw "the signer gave no tx type" on every write.
 */
export const TX_TYPE = {
  changePubKey: 8,
  withdraw: 13,
  createOrder: 14,
  cancelAllOrders: 16,
  updateLeverage: 20,
} as const

export class SignerMismatchError extends Error {
  override readonly name = 'SignerMismatchError'
  constructor(expected: string, got: string) {
    super(
      `this session's Lighter key does not match the one its account was registered ` +
        `with (expected ${expected.slice(0, 12)}…, derived ${got.slice(0, 12)}…). ` +
        'Refusing to sign rather than authorise the wrong key.',
    )
  }
}

export class AccountNotReadyError extends Error {
  override readonly name = 'AccountNotReadyError'
  constructor(address: string) {
    super(
      `Lighter has no account for ${address} yet. The USDC deposit has to land on ` +
        'Arbitrum before a session key can be registered against it.',
    )
  }
}

/** A decimal string into the integer units Lighter signs over. */
export function toUnits(decimal: string, decimals: number): string {
  const [whole = '0', frac = ''] = decimal.trim().split('.')
  return (BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0').slice(0, decimals) || '0')).toString()
}

export class LighterError extends Error {
  override readonly name = 'LighterError'
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`Lighter responded ${status}: ${body.slice(0, 200)}`)
  }
}

export interface LighterOptions {
  readonly network: NetworkAdapter
  readonly logger: Logger
  readonly apiUrl?: string
  /**
   * Builds the signer for an account, once that account is known.
   *
   * A factory rather than a ready-made signer because Lighter's signing
   * client is created *against an account index*, and the account index
   * only exists after the deposit has landed and created the account. A
   * prebuilt signer was therefore impossible, which is why nothing ever
   * passed one and every write refused.
   *
   * It is called again after a reload or a reconnect, with the account read
   * back from storage, so a resumed session can still close and withdraw.
   */
  readonly createSigner?: (args: {
    accountIndex: number
    apiKeyIndex: number
  }) => Promise<LighterSigner>
  /**
   * Signs a plain-text message with the session's L1 (EVM) key.
   *
   * Registering an API key needs the wallet that owns the Lighter account
   * to authorise it. The EVM key itself never reaches this adapter.
   */
  readonly l1Sign?: (message: string) => Promise<string>
}

export interface LighterHttpAdapter extends LighterAdapter {
  markets(): Promise<readonly Market[]>
  setLeverage(
    account: LighterAccount,
    marketSymbol: string,
    initialMarginFraction: number,
    marginMode?: 'cross' | 'isolated',
  ): Promise<{ txHash: string }>
  readonly canSign: boolean
}

export function createLighterAdapter(options: LighterOptions): LighterHttpAdapter {
  const { network, logger } = options
  const api = options.apiUrl ?? LIGHTER_API

  /** What the mark is right now, for pricing a close. */
  async function markPrice(marketId: number): Promise<number> {
    const body = await get<{ order_book_details?: { mark_price: string }[] }>(
      `/api/v1/orderBookDetails?market_id=${marketId}`,
    )
    const mark = Number(body.order_book_details?.[0]?.mark_price)
    if (!Number.isFinite(mark) || mark <= 0) {
      throw new LighterError(502, `no mark price for market ${marketId}`)
    }
    return mark
  }

  /** Lighter rejects a transaction signed against a stale nonce. */
  async function nextNonce(accountIndex: number, apiKeyIndex: number): Promise<number> {
    const body = await get<{ nonce?: number }>(
      `/api/v1/nextNonce?account_index=${accountIndex}&api_key_index=${apiKeyIndex}`,
    )
    if (typeof body.nonce !== 'number') throw new LighterError(500, 'no nonce was returned')
    return body.nonce
  }

  /**
   * The signer for an account, built once and kept.
   *
   * Keyed by account index so a rebuilt adapter — after a reload, or after
   * the connection was switched from Tor to Nym — can still sign for a
   * session it did not open. Without this, resuming a session in `trading`
   * left it unable to close or withdraw: exactly the stranding the gate
   * refuses to start a session for.
   */
  const signers = new Map<number, Promise<LighterSigner>>()

  async function signerFor(account: LighterAccount, action: string): Promise<LighterSigner> {
    if (!options.createSigner) throw new MissingSignerError(action)
    let pending = signers.get(account.accountIndex)
    if (!pending) {
      pending = options.createSigner({
        accountIndex: account.accountIndex,
        apiKeyIndex: account.apiKeyIndex,
      }).then((signer) => {
        // The key is derived from the vault, so a rebuild must reproduce the
        // key the account was registered with. If it does not, something is
        // wrong with the derivation and signing anyway would produce
        // transactions Lighter rejects — or, worse, authorise the wrong key.
        if (signer.apiPublicKey !== account.apiPublicKey) {
          throw new SignerMismatchError(account.apiPublicKey, signer.apiPublicKey)
        }
        return signer
      })
      signers.set(account.accountIndex, pending)
      // A failed build must not be remembered as a permanent failure.
      pending.catch(() => signers.delete(account.accountIndex))
    }
    return pending
  }

  /**
   * POST /api/v1/sendTx takes the signed transaction and answers a hash.
   *
   * **Form-encoded, not JSON.** This sent JSON until 2026-11-04 and every
   * write refused with `400 {"code":20001,"message":"invalid param "}` —
   * orders, withdrawals, leverage changes, key registration, all of them.
   * The same signed transaction, byte for byte, as a urlencoded body
   * answered 200 with a tx hash.
   *
   * Measured against the live venue while registering a real account's
   * key. Nothing here caught it, because every test asserts this request
   * against a mock and a mock accepts whatever shape it is handed. The
   * venue is the only thing that knows, and it had never been asked.
   *
   * A query string is not a substitute: it reached the signer and was
   * rejected further in, at nonce validation.
   */
  async function submit(tx: SignedTx, txType: number, what: string): Promise<string> {
    const response = await network.fetch(`${api}/api/v1/sendTx`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        tx_type: String(tx.txType ?? txType),
        tx_info: tx.txInfo,
      }).toString(),
    })
    const text = await response.text()
    if (!response.ok) throw new LighterError(response.status, text)
    const body = JSON.parse(text) as { tx_hash?: string; message?: string }
    if (!body.tx_hash) throw new LighterError(502, `${what}: no transaction hash came back`)
    logger.info('lighter tx sent', { what })
    return body.tx_hash
  }

  async function get<T>(path: string): Promise<T> {
    const response = await network.fetch(`${api}${path}`)
    const text = await response.text()
    if (!response.ok) throw new LighterError(response.status, text)
    return JSON.parse(text) as T
  }

  return {
    canSign: Boolean(options.createSigner && options.l1Sign),

    /** Public, and the numbers the rest of the app needs to size an order. */
    async markets(): Promise<readonly Market[]> {
      const body = await get<{ order_books?: RawOrderBook[] }>('/api/v1/orderBooks')
      const markets = (body.order_books ?? []).map(
        (m): Market => ({
          symbol: m.symbol,
          marketId: m.market_id,
          status: m.status,
          takerFee: m.taker_fee,
          makerFee: m.maker_fee,
          minBaseAmount: m.min_base_amount,
          minQuoteAmount: m.min_quote_amount,
          sizeDecimals: m.supported_size_decimals,
          priceDecimals: m.supported_price_decimals,
        }),
      )
      logger.debug('lighter markets', { count: markets.length })
      return markets
    },

    /**
     * Register this session's key against the account.
     *
     * The USDC deposit that brings the account into existence is an Arbitrum
     * transaction and belongs to the gas adapter, not here. By the time this
     * runs the deposit must have landed, so this looks the account up by its
     * L1 address and refuses clearly when it is not there yet.
     */
    /**
     * Where this wallet sends USDC to fund a Lighter account.
     *
     * Verified live on 2026-10-28: POST /api/v1/createIntentAddress with
     * chain_id 42161 answers an intent address. The address is derived from
     * the sender alone — the same wallet gets the same address whatever the
     * amount — so calling this twice is free and a retry cannot create a
     * second place for the money to go.
     *
     * Because each session has a wallet of its own, each session gets a
     * deposit address of its own, and two sessions never share one.
     */
    async depositAddress(from: EvmAddress, value: Amount): Promise<EvmAddress> {
      const query = new URLSearchParams({
        chain_id: String(ARBITRUM_CHAIN_ID),
        from_addr: from,
        amount: value.units.toString(),
        is_external_deposit: 'true',
      })
      const response = await network.fetch(`${api}/api/v1/createIntentAddress?${query}`, {
        method: 'POST',
      })
      const text = await response.text()
      if (!response.ok) throw new LighterError(response.status, text)
      const body = JSON.parse(text) as { intent_address?: string }
      const address = body.intent_address
      if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
        throw new LighterError(502, `no intent address came back for ${from}`)
      }
      logger.info('lighter deposit address', { from })
      return address as EvmAddress
    },

    async openAccount(from: EvmAddress, deposit: Amount): Promise<LighterAccount> {
      if (!options.createSigner) throw new MissingSignerError('Opening a Lighter account')
      if (!options.l1Sign) throw new MissingSignerError('Opening a Lighter account')
      void deposit

      // The account index has to be read before the signer can be built:
      // Lighter's signing client is created against it. This is the whole
      // reason the signer is a factory.
      const found = await get<{ accounts?: { account_index: number }[] }>(
        `/api/v1/account?by=l1_address&value=${encodeURIComponent(from)}`,
      )
      const accountIndex = found.accounts?.[0]?.account_index
      if (accountIndex === undefined) {
        throw new AccountNotReadyError(from)
      }

      const apiKeyIndex = 0
      const signer = await options.createSigner({ accountIndex, apiKeyIndex })
      const nonce = await nextNonce(accountIndex, apiKeyIndex)

      /*
       * Registering the key takes an L1 signature, not an empty string.
       *
       * The signer hands back the exact text to sign — "Register Lighter
       * Account", carrying the public key, the nonce and both indices — and
       * the session's EVM wallet signs it. This previously passed '', which
       * Lighter would have rejected, leaving the session funded on Arbitrum
       * with no account to trade through.
       */
      const message = await signer.changePubKeyBody({ nonce, apiKeyIndex })
      const signedMessage = await options.l1Sign(message)
      const tx = await signer.changePubKey({ signedMessage, nonce, apiKeyIndex })
      await submit(tx, TX_TYPE.changePubKey, 'registering the API key')

      const account = { accountIndex, apiKeyIndex, apiPublicKey: signer.apiPublicKey }
      // Keep it, so the first order does not rebuild what was just made.
      signers.set(accountIndex, Promise.resolve(signer))
      logger.info('lighter account opened', { accountIndex })
      return account
    },

    async placeOrder(account: LighterAccount, order: OrderRequest) {
      const signer = await signerFor(account, 'Placing an order')

      const markets = await this.markets()
      const market = markets.find((m) => m.symbol === order.market)
      if (!market) throw new LighterError(404, `no Lighter market called ${order.market}`)

      // A market order carries a price too. lighter-go rejects anything below
      // MinOrderPrice (1), and the Python SDK names the field
      // `avg_execution_price`: for an IOC order it is the worst price the
      // sweep may reach, not a placeholder. Signing zero would have every
      // market order refused, so the caller must state its bound.
      if (!order.price) {
        throw new LighterError(
          400,
          order.type === 'market'
            ? 'a market order needs a worst acceptable price; Lighter refuses a price of zero'
            : 'a limit order needs a limit price',
        )
      }

      const nonce = await nextNonce(account.accountIndex, account.apiKeyIndex)
      const tx = await signer.createOrder({
        marketIndex: market.marketId,
        // Lighter dedupes on this, so a retry of the same order is not a
        // second position.
        clientOrderIndex: nonce,
        baseAmount: toUnits(order.size, market.sizeDecimals),
        price: toUnits(order.price, market.priceDecimals),
        isAsk: order.side === 'sell',
        // 0 limit, 1 market; 1 good-till-time, 0 immediate-or-cancel.
        orderType: order.type === 'market' ? 1 : 0,
        timeInForce: order.type === 'market' ? 0 : 1,
        reduceOnly: order.reduceOnly,
        nonce,
      })
      const hash = await submit(tx, TX_TYPE.createOrder, 'placing an order')
      return { orderId: hash }
    },

    /**
     * What is actually open.
     *
     * Verified against the live API on 2026-10-27, which corrected two things
     * guessed earlier:
     *
     *   - `/api/v1/accountPositions` answers 403. Positions come back on the
     *     account itself, at `accounts[0].positions`.
     *   - `position` is UNSIGNED, with the direction in a separate `sign`
     *     field. Reading it as signed would show every short as a long, and
     *     would then "close" it by selling more.
     *
     * An unexpected shape throws. Answering "no positions" to a question that
     * failed is how a session withdraws its collateral with a trade still on.
     */
    async positions(account: LighterAccount): Promise<readonly Position[]> {
      const body = await get<{ accounts?: RawAccount[] }>(
        `/api/v1/account?by=index&value=${account.accountIndex}`,
      )
      const found = body.accounts?.[0]
      if (!found || !Array.isArray(found.positions)) {
        throw new LighterError(502, `no account ${account.accountIndex} came back with positions`)
      }

      return found.positions
        .filter((p) => Number(p.position) !== 0)
        .map((p): Position => {
          const size = (p.sign < 0 ? -1 : 1) * Number(p.position)
          return {
            market: p.symbol,
            size: String(size),
            entryPrice: p.avg_entry_price,
            unrealizedPnl: p.unrealized_pnl,
            // Zero means Lighter is not quoting one for a cross position.
            ...(Number(p.liquidation_price) > 0
              ? { liquidationPrice: p.liquidation_price }
              : {}),
          }
        })
    },

    /**
     * Set the leverage for one market.
     *
     * Lighter stores this on the account, so it is a transaction of its own
     * and must land before the order it is meant to apply to.
     */
    async setLeverage(
      account: LighterAccount,
      marketSymbol: string,
      initialMarginFraction: number,
      marginMode: 'cross' | 'isolated' = 'isolated',
    ): Promise<{ txHash: string }> {
      const signer = await signerFor(account, 'Setting leverage')

      const markets = await this.markets()
      const market = markets.find((m) => m.symbol === marketSymbol)
      if (!market) throw new LighterError(404, `no Lighter market called ${marketSymbol}`)

      const nonce = await nextNonce(account.accountIndex, account.apiKeyIndex)
      const tx = await signer.updateLeverage({
        marketIndex: market.marketId,
        initialMarginFraction,
        marginMode: marginMode === 'isolated' ? 1 : 0,
        nonce,
      })
      return { txHash: await submit(tx, TX_TYPE.updateLeverage, 'setting leverage') }
    },

    /**
     * Cancel the resting orders, then flatten what is actually open.
     *
     * Cancelling alone is not closing. An account with no orders and a live
     * perp is still exposed, and the session would go on to withdraw its free
     * collateral and retire the key with the trade still running — the loss
     * would land on an account nobody is watching any more.
     *
     * Each position is closed with a reduce-only immediate-or-cancel order
     * bounded a stated distance from the mark, so a thin book cannot fill it
     * at any price at all.
     */
    async closeAll(account: LighterAccount) {
      const signer = await signerFor(account, 'Closing positions')

      const cancelNonce = await nextNonce(account.accountIndex, account.apiKeyIndex)
      await submit(
        await signer.cancelAllOrders({
          timeInForce: CANCEL_IMMEDIATE,
          /*
           * Zero, not a timestamp. `timeInForce: 0` means cancel now, and
           * the venue refuses a scheduled time alongside it:
           * `CancelAllTime should be nil`, seen on 2026-11-04 trying to
           * flatten a real position.
           *
           * It matters more than a rejected cancel: closeAll is what runs
           * before a withdrawal, so a session that could not cancel could
           * not flatten, and would either strand collateral behind an open
           * perp or withdraw with the trade still running.
           */
          time: 0,
          nonce: cancelNonce,
        }),
        TX_TYPE.cancelAllOrders,
        'cancelling orders',
      )

      const open = await this.positions(account)
      const markets = await this.markets()
      for (const position of open) {
        const size = Number(position.size)
        if (!Number.isFinite(size) || size === 0) continue
        const market = markets.find((m) => m.symbol === position.market)
        if (!market) throw new LighterError(404, `cannot close an unknown market ${position.market}`)

        const mark = await markPrice(market.marketId)
        // Long closes by selling, so the bound sits below the mark.
        const side = size > 0 ? 'sell' : 'buy'
        const bound = mark * (1 + (side === 'buy' ? CLOSE_BOUND_BPS : -CLOSE_BOUND_BPS) / 10_000)

        const nonce = await nextNonce(account.accountIndex, account.apiKeyIndex)
        await submit(
          await signer.createOrder({
            marketIndex: market.marketId,
            clientOrderIndex: nonce,
            baseAmount: toUnits(Math.abs(size).toFixed(market.sizeDecimals), market.sizeDecimals),
            price: toUnits(bound.toFixed(market.priceDecimals), market.priceDecimals),
            isAsk: side === 'sell',
            orderType: 1,
            timeInForce: 0,
            reduceOnly: true,
            nonce,
          }),
          TX_TYPE.createOrder,
          `closing ${position.market}`,
        )
      }

      logger.info('lighter closed out', { positions: open.length })
    },

    async withdraw(account: LighterAccount, to: EvmAddress, value: Amount) {
      const signer = await signerFor(account, 'Withdrawing')
      if (value.units < FAST_WITHDRAWAL_MINIMUM.units) {
        throw new LighterError(400, 'Lighter will not withdraw less than 1 USDC')
      }
      void to
      const nonce = await nextNonce(account.accountIndex, account.apiKeyIndex)
      const tx = await signer.withdraw({
        assetIndex: USDC_ASSET_INDEX,
        routeType: FAST_WITHDRAWAL_ROUTE,
        amount: value.units.toString(),
        nonce,
      })
      return { ref: await submit(tx, TX_TYPE.withdraw, 'withdrawing') }
    },

    async withdrawalStatus(ref: string, account?: LighterAccount) {
      /*
       * Ask the authenticated withdrawal history first, because it is the
       * only thing that knows about claiming.
       *
       * A secure withdrawal ends `claimable`: Lighter has finalised it and
       * the funds wait for the user to claim them on L1. The public
       * transaction endpoint cannot express that — it reports
       * `committed_at: 0` both for a withdrawal waiting its turn and for
       * one waiting for its owner, which is how a real withdrawal sat
       * unclaimed for hours on 2026-11-04 while the caller polled.
       */
      if (account && options.createSigner) {
        try {
          const signer = await signerFor(account, 'Reading the withdrawal history')
          const token = await signer.authToken({ apiKeyIndex: account.apiKeyIndex })
          const response = await network.fetch(
            `${api}/api/v1/withdraw/history?account_index=${account.accountIndex}&limit=20`,
            { headers: { authorization: String(token) } },
          )
          if (response.ok) {
            const body = JSON.parse(await response.text()) as {
              withdraws?: { status?: string; type?: string; amount?: string }[]
            }
            // The history keys on its own id, not the submission hash, so
            // the newest entry is the one just asked about.
            const entry = body.withdraws?.[0]
            const state = (entry?.status ?? '').toLowerCase()
            if (state) {
              if (entry?.type && entry.type.toLowerCase() !== 'fast') {
                logger.warn('withdrawal took the secure route, not the fast one', {})
              }
              switch (state) {
                case 'claimable':
                  return 'claimable' as const
                case 'claimed':
                case 'completed':
                case 'success':
                  return 'settled' as const
                case 'failed':
                case 'rejected':
                  return 'failed' as const
                default:
                  return 'pending' as const
              }
            }
          }
        } catch (error) {
          // An unavailable history is not a verdict about the money.
          logger.warn('could not read the withdrawal history', {})
          void error
        }
      }

      /*
       * Fallback: the public transaction. It cannot see claiming, so it
       * never reports `settled` on its own — saying "pending" forever is
       * wrong but safe, while saying "settled" would move a session on
       * with the funds still on the venue.
       */
      let body: { status?: string }
      try {
        body = await get<{ status?: string }>(`/api/v1/tx?by=hash&value=${encodeURIComponent(ref)}`)
      } catch (error) {
        if (error instanceof LighterError && /transaction not found|21500/.test(error.message)) {
          return 'pending' as const
        }
        throw error
      }
      switch ((body.status ?? '').toLowerCase()) {
        case 'committed':
        case 'verified':
        case 'success':
          return 'settled' as const
        case 'failed':
        case 'rejected':
          return 'failed' as const
        default:
          return 'pending' as const
      }
    },
  }
}

/** Lighter's fast withdrawal takes USDC only, with a four dollar floor. */
/**
 * The smallest withdrawal Lighter accepts.
 *
 * One USDC, read from /api/v1/assetDetails on 2026-10-28
 * (`min_withdrawal_amount: "1.000000"` for asset 3). This said four, which
 * was the fast-withdrawal *fee* as first misread — and the fee is a dollar
 * too. A floor set three dollars too high refuses withdrawals Lighter would
 * have accepted, at the one moment the session is trying to leave.
 */
export const FAST_WITHDRAWAL_MINIMUM: Amount = amount('USDC', 1n * 10n ** BigInt(ASSETS.USDC.decimals))
