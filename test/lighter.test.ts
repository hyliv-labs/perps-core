import { describe, expect, it } from 'vitest'
import {
  FAST_WITHDRAWAL_MINIMUM,
  LighterError,
  MissingSignerError,
  TX_TYPE,
  CANCEL_IMMEDIATE,
  createLighterAdapter,
  type LighterSigner,
} from '@/adapters/lighter/http'
import type { NetworkAdapter } from '@/adapters/types'
import { testLogger } from './helpers'
import { evmAddress, parseAmount } from '@/core/types'


/**
 * sendTx is form-encoded, so a test that parsed JSON here would pass while
 * the venue refused every write. Decoding it the way the venue does keeps
 * these assertions honest about the bytes that actually go out.
 */
function formBody(body: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(body))
}

function netAnswering(body: unknown, status = 200): NetworkAdapter & { urls: string[] } {
  const urls: string[] = []
  return {
    kind: 'tor',
    isPrivate: true,
    assurance: 'verified',
    urls,
    async fetch(url) {
      urls.push(url)
      return new Response(JSON.stringify(body), { status })
    },
  }
}

const ORDER_BOOKS = {
  order_books: [
    {
      symbol: 'ETH',
      market_id: 0,
      status: 'active',
      taker_fee: '0.0000',
      maker_fee: '0.0000',
      min_base_amount: '0.0020',
      min_quote_amount: '10.000000',
      supported_size_decimals: 4,
      supported_price_decimals: 2,
    },
  ],
}

const ACCOUNT = { accountIndex: 1001, apiKeyIndex: 0, apiPublicKey: '0xab' }

/**
 * The adapter takes a factory, not a signer: Lighter's signing client is
 * created against an account index that does not exist until the deposit
 * lands. `signing()` is what a configured adapter looks like.
 */
const signing = () => ({
  createSigner: async () => signer,
  l1Sign: async (_message: string) => `0x${'cd'.repeat(65)}`,
})
const signer: LighterSigner = {
  kind: 'wasm',
  apiPublicKey: '0xab',
  changePubKeyBody: async () => 'Register Lighter Account\n\npubkey: 0xab',
  changePubKey: async () => ({ txInfo: '{}' }),
  createOrder: async () => ({ txInfo: '{}' }),
  cancelAllOrders: async () => ({ txInfo: '{}' }),
  withdraw: async () => ({ txInfo: '{}' }),
  updateLeverage: async () => ({ txInfo: '{}' }),
  authToken: async () => 'token',
}

describe('Lighter adapter', () => {
  describe('the reads, which work today', () => {
    it('maps the public market list', async () => {
      const net = netAnswering(ORDER_BOOKS)
      const lighter = createLighterAdapter({ network: net, logger: testLogger })
      const markets = await lighter.markets()
      expect(markets).toHaveLength(1)
      expect(markets[0]).toMatchObject({
        symbol: 'ETH',
        marketId: 0,
        takerFee: '0.0000',
        minBaseAmount: '0.0020',
        sizeDecimals: 4,
      })
    })

    it('goes through the network layer, never global fetch', async () => {
      const net = netAnswering(ORDER_BOOKS)
      await createLighterAdapter({ network: net, logger: testLogger }).markets()
      expect(net.urls[0]).toContain('/api/v1/orderBooks')
    })

    it('reads positions for an account', async () => {
      // The shape read from the live API on 2026-10-27: positions hang off
      // the account, and the size is unsigned with the sign beside it.
      const net = netAnswering({
        accounts: [
          {
            account_index: 1001,
            collateral: '500.0',
            available_balance: '400.0',
            positions: [
              {
                market_id: 0,
                symbol: 'ETH',
                sign: 1,
                position: '0.38',
                avg_entry_price: '3118.40',
                unrealized_pnl: '18.90',
                liquidation_price: '2100.5',
              },
            ],
          },
        ],
      })
      const lighter = createLighterAdapter({ network: net, logger: testLogger })
      const positions = await lighter.positions(ACCOUNT)
      expect(positions[0]).toMatchObject({
        market: 'ETH',
        size: '0.38',
        entryPrice: '3118.40',
        liquidationPrice: '2100.5',
      })
    })

    it('raises a typed error on a failed read', async () => {
      const net = netAnswering({ message: 'nope' }, 500)
      const lighter = createLighterAdapter({ network: net, logger: testLogger })
      await expect(lighter.markets()).rejects.toThrow(LighterError)
    })
  })

  describe('the writes, which cannot work yet', () => {
    const lighter = () =>
      createLighterAdapter({ network: netAnswering({}), logger: testLogger })

    it('knows it cannot sign', () => {
      expect(lighter().canSign).toBe(false)
      expect(
        createLighterAdapter({ network: netAnswering({}), logger: testLogger, ...signing() }).canSign,
      ).toBe(true)
    })

    it.each([
      ['openAccount', (l: ReturnType<typeof lighter>) => l.openAccount(evmAddress(`0x${'5e'.repeat(20)}`), parseAmount('USDC', '100'))],
      ['placeOrder', (l: ReturnType<typeof lighter>) => l.placeOrder(ACCOUNT, { market: 'ETH', side: 'buy', size: '0.1', type: 'market' as const, price: '2500', reduceOnly: false })],
      ['closeAll', (l: ReturnType<typeof lighter>) => l.closeAll(ACCOUNT)],
      ['withdraw', (l: ReturnType<typeof lighter>) => l.withdraw(ACCOUNT, evmAddress(`0x${'5e'.repeat(20)}`), parseAmount('USDC', '10'))],
    ])('refuses %s without a signer, and says why', async (_name, call) => {
      // A stubbed signer would read as working right up until it moved money.
      await expect(call(lighter())).rejects.toThrow(MissingSignerError)
      await expect(call(lighter())).rejects.toThrow(/WebAssembly build of its Go signer/)
    })
  })

  describe('withdrawal status', () => {
    const statusFor = async (status: string) =>
      createLighterAdapter({
        network: netAnswering({ status }),
        logger: testLogger,
      }).withdrawalStatus('0xref')

    it('settles only on a committed transaction', async () => {
      expect(await statusFor('committed')).toBe('settled')
      expect(await statusFor('verified')).toBe('settled')
    })

    it('reports a failure', async () => {
      expect(await statusFor('failed')).toBe('failed')
    })

    it('treats anything unrecognised as still in flight', async () => {
      expect(await statusFor('something_new')).toBe('pending')
      expect(await statusFor('')).toBe('pending')
    })

    it('treats a transaction Lighter has not indexed yet as pending', async () => {
      /*
       * The real failure this prevents. A withdrawal that has just been
       * submitted answers 400 `transaction not found` until it is indexed,
       * and a 400 throws — so a caller asking straight after withdrawing
       * saw an exception, read it as a failed withdrawal, and retried.
       * The retry withdraws the collateral a second time.
       *
       * Observed on a live withdrawal on 2026-11-04: the submission
       * returned a hash and the very next status call threw.
       */
      const notFound = {
        kind: 'direct' as const,
        isPrivate: false,
        assurance: 'none' as const,
        fetch: async () =>
          new Response(JSON.stringify({ code: 21500, message: 'transaction not found' }), {
            status: 400,
          }),
      }
      const status = await createLighterAdapter({
        network: notFound,
        logger: testLogger,
      }).withdrawalStatus('0xref')
      expect(status).toBe('pending')
    })
  })

  it('states the fast withdrawal floor in units', () => {
    // Lighter's own figure for asset 3, not the fee, which is also $1.
    expect(FAST_WITHDRAWAL_MINIMUM.units).toBe(1_000_000n)
    expect(FAST_WITHDRAWAL_MINIMUM.asset).toBe('USDC')
  })
})

describe('Lighter writes, once a signer is present', () => {
  function scripted(replies: Record<string, unknown>) {
    const sent: { url: string; body?: unknown }[] = []
    const net: NetworkAdapter = {
      kind: 'tor',
      isPrivate: true,
      assurance: 'verified',
      async fetch(url, init) {
        sent.push({
          url,
          ...(init?.body ? { body: formBody(String(init.body)) } : {}),
        })
        const key = Object.keys(replies).find((k) => url.includes(k))
        return new Response(JSON.stringify(key ? replies[key] : {}), { status: 200 })
      },
    }
    return { net, sent }
  }

  const signed = { txType: 14, txInfo: '{"signed":true}' }
  const fullSigner = { ...signer, createOrder: async () => signed, withdraw: async () => signed }

  it('reads a fresh nonce, signs, and submits to sendTx', async () => {
    const { net, sent } = scripted({
      orderBooks: ORDER_BOOKS,
      nextNonce: { nonce: 42 },
      sendTx: { code: 200, tx_hash: '0xhash' },
    })
    const lighter = createLighterAdapter({ network: net, logger: testLogger, createSigner: async () => fullSigner, l1Sign: async () => `0x${'cd'.repeat(65)}` })
    const result = await lighter.placeOrder(ACCOUNT, {
      market: 'ETH',
      side: 'buy',
      size: '0.5',
      type: 'market',
      price: '2500',
      reduceOnly: false,
    })

    expect(result.orderId).toBe('0xhash')
    const post = sent.find((s) => s.url.includes('sendTx'))!
    // The API takes the signed blob, not the order fields.
    expect(post.body).toEqual({ tx_type: '14', tx_info: '{"signed":true}' })
    expect(sent.some((s) => s.url.includes('nextNonce'))).toBe(true)
  })

  it('refuses a withdrawal under Lighter’s one dollar floor', async () => {
    const { net } = scripted({ nextNonce: { nonce: 1 } })
    const lighter = createLighterAdapter({ network: net, logger: testLogger, createSigner: async () => fullSigner, l1Sign: async () => `0x${'cd'.repeat(65)}` })
    await expect(
      lighter.withdraw(ACCOUNT, evmAddress(`0x${'5e'.repeat(20)}`), parseAmount('USDC', '0.5')),
    ).rejects.toThrow(/1 USDC/)
  })

  it('allows the three dollars the old four dollar floor wrongly refused', async () => {
    const { net } = scripted({ nextNonce: { nonce: 1 }, sendTx: { code: 200, tx_hash: '0xw' } })
    const lighter = createLighterAdapter({ network: net, logger: testLogger, createSigner: async () => fullSigner, l1Sign: async () => `0x${'cd'.repeat(65)}` })
    await expect(
      lighter.withdraw(ACCOUNT, evmAddress(`0x${'5e'.repeat(20)}`), parseAmount('USDC', '3')),
    ).resolves.toEqual({ ref: '0xw' })
  })

  it('says plainly when the deposit has not landed yet', async () => {
    const { net } = scripted({ account: { accounts: [] } })
    const lighter = createLighterAdapter({ network: net, logger: testLogger, createSigner: async () => fullSigner, l1Sign: async () => `0x${'cd'.repeat(65)}` })
    await expect(
      lighter.openAccount(evmAddress(`0x${'5e'.repeat(20)}`), parseAmount('USDC', '100')),
    ).rejects.toThrow(/deposit has to land/)
  })

  it('supplies the transaction type the signer does not return', async () => {
    // The pinned binary answers {txHash, txInfo} and no type. This adapter
    // used to read the type off that record and refuse when it was absent,
    // which is every single write. The type belongs to the operation, so
    // the caller names it: 14 for an order.
    const { net, sent } = scripted({
      orderBooks: ORDER_BOOKS,
      nextNonce: { nonce: 1 },
      sendTx: { code: 200, tx_hash: '0x1' },
    })
    const lighter = createLighterAdapter({
      network: net,
      logger: testLogger,
      createSigner: async () => ({ ...signer, createOrder: async () => ({ txInfo: '{}' }) }),
      l1Sign: async () => `0x${'cd'.repeat(65)}`,
    })
    await lighter.placeOrder(ACCOUNT, {
      market: 'ETH',
      side: 'buy',
      size: '1',
      type: 'market',
      price: '2500',
      reduceOnly: false,
    })
    const post = sent.find((c) => c.url.includes('sendTx'))!
    expect((post.body as { tx_type: string }).tx_type).toBe(String(TX_TYPE.createOrder))
  })

  it('refuses a stale nonce rather than signing against a guess', async () => {
    const { net } = scripted({ orderBooks: ORDER_BOOKS, nextNonce: {} })
    const lighter = createLighterAdapter({ network: net, logger: testLogger, createSigner: async () => fullSigner, l1Sign: async () => `0x${'cd'.repeat(65)}` })
    await expect(
      lighter.placeOrder(ACCOUNT, { market: 'ETH', side: 'buy', size: '1', type: 'market', price: '2500', reduceOnly: false }),
    ).rejects.toThrow(/no nonce/)
  })
})

describe('decimal to units', () => {
  it('scales without floating point', async () => {
    const { toUnits } = await import('@/adapters/lighter/http')
    expect(toUnits('0.5', 4)).toBe('5000')
    expect(toUnits('3118.40', 2)).toBe('311840')
    expect(toUnits('1', 6)).toBe('1000000')
  })
})

/**
 * Positions and close-out, against shapes read from the live API on
 * 2026-10-27 rather than guessed.
 */
describe('positions and closing out', () => {
  const ACCOUNT_2 = { accountIndex: 513030, apiKeyIndex: 0, apiPublicKey: '0xab' }
  const reader: LighterSigner = {
    kind: 'wasm',
    apiPublicKey: '0xab',
    changePubKeyBody: async () => 'Register Lighter Account',
    changePubKey: async () => ({ txType: 8, txInfo: '{}' }),
    createOrder: async () => ({ txType: 14, txInfo: '{}' }),
    cancelAllOrders: async () => ({ txType: 16, txInfo: '{}' }),
    withdraw: async () => ({ txType: 19, txInfo: '{}' }),
    updateLeverage: async () => ({ txType: 20, txInfo: '{}' }),
    authToken: async () => 'token',
  }

  const BOOKS = {
    order_books: [
      {
        symbol: 'ZEC', market_id: 90, status: 'active', taker_fee: '0.0000', maker_fee: '0.0000',
        min_base_amount: '0.004', min_quote_amount: '10.000000',
        supported_size_decimals: 3, supported_price_decimals: 3,
      },
      {
        symbol: 'HYPE', market_id: 24, status: 'active', taker_fee: '0.0000', maker_fee: '0.0000',
        min_base_amount: '0.1', min_quote_amount: '10.000000',
        supported_size_decimals: 2, supported_price_decimals: 4,
      },
    ],
  }

  /** The real response: positions hang off the account, and sizes are unsigned. */
  const ACCOUNT_BODY = {
    accounts: [
      {
        account_index: 513030,
        collateral: '106435.704386',
        available_balance: '66678.544307',
        positions: [
          { market_id: 90, symbol: 'ZEC', sign: 1, position: '13.359', avg_entry_price: '1235.794', unrealized_pnl: '62.608459', liquidation_price: '0' },
          { market_id: 24, symbol: 'HYPE', sign: -1, position: '249.50', avg_entry_price: '77.7779', unrealized_pnl: '-0.614512', liquidation_price: '418.0889717354632' },
          { market_id: 1, symbol: 'BNB', sign: 1, position: '0.00', avg_entry_price: '0.0000', unrealized_pnl: '0.000000', liquidation_price: '0' },
        ],
      },
    ],
  }

  function netFor(replies: Record<string, unknown>) {
    const sent: { url: string; body?: unknown }[] = []
    const net: NetworkAdapter = {
      kind: 'tor',
      isPrivate: true,
      assurance: 'verified',
      async fetch(url, init) {
        sent.push({ url, ...(init?.body ? { body: formBody(String(init.body)) } : {}) })
        const key = Object.keys(replies).find((k) => url.includes(k))
        return new Response(JSON.stringify(key ? replies[key] : {}), { status: 200 })
      },
    }
    return { net, sent }
  }

  it('carries the sign, so a short is not read as a long', async () => {
    // Lighter stores direction in `sign` and the size unsigned. Reading
    // `position` as signed would show the HYPE short as a 249.50 long and
    // then "close" it by selling 249.50 more.
    const { net } = netFor({ '/api/v1/account?': ACCOUNT_BODY })
    const lighter = createLighterAdapter({ network: net, logger: testLogger, createSigner: async () => reader, l1Sign: async () => `0x${'cd'.repeat(65)}` })
    const open = await lighter.positions(ACCOUNT_2)

    expect(open.map((p) => `${p.market} ${p.size}`)).toEqual(['ZEC 13.359', 'HYPE -249.5'])
  })

  it('leaves out a flat market and Lighter’s unquoted liquidation price', async () => {
    const { net } = netFor({ '/api/v1/account?': ACCOUNT_BODY })
    const lighter = createLighterAdapter({ network: net, logger: testLogger, createSigner: async () => reader, l1Sign: async () => `0x${'cd'.repeat(65)}` })
    const open = await lighter.positions(ACCOUNT_2)

    expect(open.find((p) => p.market === 'BNB')).toBeUndefined()
    // Zero means "not quoting one", not "liquidates at zero".
    expect(open.find((p) => p.market === 'ZEC')?.liquidationPrice).toBeUndefined()
    expect(open.find((p) => p.market === 'HYPE')?.liquidationPrice).toBe('418.0889717354632')
  })

  it('throws on a shape it does not recognise rather than reporting flat', async () => {
    // /api/v1/accountPositions answers 403 live. Anything that silently became
    // "no positions" would let a session withdraw with a trade still open.
    const { net } = netFor({ '/api/v1/account?': { code: 200, accounts: [] } })
    const lighter = createLighterAdapter({ network: net, logger: testLogger, createSigner: async () => reader, l1Sign: async () => `0x${'cd'.repeat(65)}` })
    await expect(lighter.positions(ACCOUNT_2)).rejects.toThrow(/positions/)
  })

  it('cancels immediately, with no scheduled time alongside it', async () => {
    /*
     * The venue refuses `CancelAllTime should be nil` when a timestamp is
     * sent with an immediate cancel, which is what this used to do.
     *
     * It is not a cosmetic rejection: closeAll runs before every
     * withdrawal, so a cancel the venue throws out means the session
     * cannot flatten — and then either strands collateral behind an open
     * perp or withdraws with the trade still running. Seen trying to
     * flatten a real position on 2026-11-04.
     */
    const seen: { timeInForce: number; time: number }[] = []
    const cancelSigner = {
      ...reader,
      cancelAllOrders: async (a: { timeInForce: number; time: number }) => {
        seen.push({ timeInForce: a.timeInForce, time: a.time })
        return { txType: 16, txInfo: '{}' }
      },
    }
    const { net } = netFor({
      '/api/v1/account?': ACCOUNT_BODY,
      orderBooks: BOOKS,
      orderBookDetails: { order_book_details: [{ mark_price: '1000.000' }] },
      nextNonce: { nonce: 7 },
      sendTx: { code: 200, tx_hash: '0xhash' },
    })
    const lighter = createLighterAdapter({ network: net, logger: testLogger, createSigner: async () => cancelSigner, l1Sign: async () => `0x${'cd'.repeat(65)}` })
    await lighter.closeAll(ACCOUNT_2)

    expect(seen).toHaveLength(1)
    expect(seen[0]!.timeInForce).toBe(CANCEL_IMMEDIATE)
    expect(seen[0]!.time).toBe(0)
  })

  it('closes each position reduce-only on the opposite side', async () => {
    const orders: { isAsk: number; reduceOnly: number; market: number; price: string }[] = []
    const closingSigner = {
      ...reader,
      createOrder: async (a: {
        marketIndex: number
        isAsk: boolean
        reduceOnly: boolean
        price: string
      }) => {
        orders.push({
          market: a.marketIndex,
          isAsk: a.isAsk ? 1 : 0,
          reduceOnly: a.reduceOnly ? 1 : 0,
          price: a.price,
        })
        return { txType: 14, txInfo: '{}' }
      },
    }
    const { net } = netFor({
      '/api/v1/account?': ACCOUNT_BODY,
      orderBooks: BOOKS,
      orderBookDetails: { order_book_details: [{ mark_price: '1000.000' }] },
      nextNonce: { nonce: 7 },
      sendTx: { code: 200, tx_hash: '0xhash' },
    })
    const lighter = createLighterAdapter({ network: net, logger: testLogger, createSigner: async () => closingSigner, l1Sign: async () => `0x${'cd'.repeat(65)}` })
    await lighter.closeAll(ACCOUNT_2)

    // Cancelling orders is not closing a position, so both must happen.
    expect(orders).toHaveLength(2)
    // The ZEC long closes by selling, bounded BELOW the 1000 mark.
    expect(orders[0]).toMatchObject({ market: 90, isAsk: 1, reduceOnly: 1 })
    expect(Number(orders[0]!.price)).toBeLessThan(1000 * 1000)
    // The HYPE short closes by buying, bounded ABOVE it.
    expect(orders[1]).toMatchObject({ market: 24, isAsk: 0, reduceOnly: 1 })
    expect(Number(orders[1]!.price)).toBeGreaterThan(1000 * 10_000)
  })
})
