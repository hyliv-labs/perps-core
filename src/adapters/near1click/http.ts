/**
 * NEAR 1Click, over HTTP.
 *
 * Verified against the live API on 2026-10-26 (spikes/01-1click-quote.ts):
 *
 *   POST /v0/quote                 -> 201, { quote: { … } }
 *   GET  /v0/status?depositAddress -> 200, or 404 while the address is unknown
 *
 * `depositType`, `recipientType` and `refundType` are all required and each
 * takes ORIGIN_CHAIN/DESTINATION_CHAIN, INTENTS or CONFIDENTIAL_INTENTS.
 * Addresses are validated per chain when the quote is asked for, so a Zcash
 * leg cannot even be priced without a real Zcash address.
 *
 * Every request goes through the NetworkAdapter rather than global fetch.
 * That is not a style choice: a quote sent straight out over the clear
 * network ties the caller's IP to the deposit address, which is the link
 * this product exists to break.
 */

import type { NearIntentsAdapter, QuoteRequest } from '../types'
import type { NetworkAdapter } from '../types'
import type { SwapLeg } from '@/core/session'
import { type Amount, type AssetSymbol, ASSETS, amount } from '@/core/types'
import type { Logger } from '@/core/log'

export const ONECLICK_API = 'https://1click.chaindefuser.com'

/** Asset ids, confirmed against GET /v0/tokens. */
export const ASSET_IDS: Readonly<Record<'ZEC' | 'USDC', string>> = {
  ZEC: 'nep141:zec.omft.near',
  USDC: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near',
}

interface QuoteResponse {
  quote: {
    amountIn: string
    amountInFormatted: string
    amountInUsd: string
    minAmountIn: string
    amountOut: string
    amountOutFormatted: string
    amountOutUsd: string
    minAmountOut: string
    deadline?: string
    depositAddress?: string
    depositMemo?: string
  }
  /** Present on a real (non-dry) quote. */
  depositAddress?: string
  timestamp?: string
}

interface StatusResponse {
  status?: string
  quoteResponse?: QuoteResponse
  swapDetails?: { amountOut?: string; amountOutFormatted?: string }
}

/**
 * 1Click's status vocabulary is not published in full. These are the values
 * seen so far; anything unrecognised is treated as still pending, because
 * guessing "settled" would hand the session on with no money behind it.
 */
function mapStatus(raw: string | undefined): SwapLeg['status'] {
  switch ((raw ?? '').toUpperCase()) {
    case 'SUCCESS':
    case 'SETTLED':
    case 'COMPLETED':
      return 'settled'
    case 'REFUNDED':
      return 'refunded'
    case 'EXPIRED':
    case 'FAILED':
      return 'expired'
    case 'PENDING_DEPOSIT':
    case 'KNOWN_DEPOSIT_TX':
    case 'PROCESSING':
    case 'INCOMPLETE_DEPOSIT':
      return 'deposited'
    default:
      return 'deposited'
  }
}

function toUnits(decimal: string, asset: AssetSymbol): bigint {
  const { decimals } = ASSETS[asset]
  const [whole = '0', frac = ''] = decimal.split('.')
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0').slice(0, decimals) || '0')
}

export interface OneClickOptions {
  readonly network: NetworkAdapter
  readonly logger: Logger
  readonly apiUrl?: string
  /**
   * Partner JWT. Confidential quotes are refused without it. When it is
   * present the platform fee is 0.20% instead of 0.25%.
   */
  readonly jwt?: string
  readonly now?: () => number
}

export function createOneClickAdapter(options: OneClickOptions): NearIntentsAdapter {
  const { network, logger } = options
  const api = options.apiUrl ?? ONECLICK_API
  const now = options.now ?? (() => Date.now())

  async function post(path: string, body: unknown): Promise<unknown> {
    const response = await network.fetch(`${api}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(options.jwt ? { authorization: `Bearer ${options.jwt}` } : {}),
      },
      body: JSON.stringify(body),
    })
    const text = await response.text()
    // 1Click answers 201 on a created quote, not 200.
    if (response.status < 200 || response.status >= 300) {
      throw new OneClickError(response.status, text)
    }
    return JSON.parse(text)
  }

  async function get(path: string): Promise<{ status: number; body: unknown }> {
    const response = await network.fetch(`${api}${path}`, {
      headers: options.jwt ? { authorization: `Bearer ${options.jwt}` } : {},
    })
    const text = await response.text()
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
    return { status: response.status, body }
  }

  return {
    async quote(request: QuoteRequest): Promise<SwapLeg> {
      const origin = ASSET_IDS[request.from.asset as 'ZEC' | 'USDC']
      const destination = ASSET_IDS[request.toAsset]
      if (!origin || !destination) {
        throw new Error(`no 1Click asset id for ${request.from.asset} -> ${request.toAsset}`)
      }
      const deadline = new Date(now() + request.deadlineMs).toISOString()

      const body = {
        dry: false,
        swapType: 'EXACT_INPUT',
        slippageTolerance: 100,
        depositType: 'ORIGIN_CHAIN',
        refundType: 'ORIGIN_CHAIN',
        recipientType: 'DESTINATION_CHAIN',
        // Public quotes are no longer priced. `basic` keeps the deposit on
        // Zcash and the payout on Arbitrum; it does not move the funds into
        // a Confidential Intents account.
        confidentiality: 'basic',
        originAsset: origin,
        destinationAsset: destination,
        amount: request.from.units.toString(),
        refundTo: request.refundTo,
        recipient: request.recipient,
        deadline,
      }

      const parsed = (await post('/v0/quote', body)) as QuoteResponse
      const q = parsed.quote
      const depositAddress = parsed.depositAddress ?? q.depositAddress
      if (!depositAddress) {
        throw new Error('1Click returned a quote with no deposit address')
      }

      logger.info('1Click quote', {
        from: request.from.asset,
        to: request.toAsset,
        amountIn: q.amountInFormatted,
        amountOut: q.amountOutFormatted,
      })

      return {
        quoteId: depositAddress, // the status endpoint is keyed by it
        depositAddress,
        amountIn: request.from,
        amountOutMin: amount(request.toAsset, BigInt(q.minAmountOut)),
        deadline: q.deadline ? Date.parse(q.deadline) : now() + request.deadlineMs,
        refundTo: request.refundTo,
        recipient: request.recipient,
        status: 'quoted',
      }
    },

    async status(leg: SwapLeg): Promise<SwapLeg> {
      const { status, body } = await get(
        `/v0/status?depositAddress=${encodeURIComponent(leg.depositAddress)}`,
      )
      // Until the deposit lands, 1Click does not know the address at all.
      if (status === 404) return leg
      if (status < 200 || status >= 300) {
        throw new OneClickError(status, JSON.stringify(body))
      }

      const parsed = body as StatusResponse
      const next = mapStatus(parsed.status)
      const outFormatted = parsed.swapDetails?.amountOutFormatted
      const settled =
        next === 'settled' && outFormatted
          ? amount(leg.amountOutMin.asset, toUnits(outFormatted, leg.amountOutMin.asset))
          : undefined

      logger.debug('1Click status', { raw: parsed.status, mapped: next })
      return settled ? { ...leg, status: next, settledAmount: settled } : { ...leg, status: next }
    },

    async minimum(asset, toAsset): Promise<Amount> {
      // There is no published minimums endpoint. The honest answer is the
      // smallest amount the solver will still quote, which spike 01 measures
      // by bisection against a real address; until it has run, refuse to
      // invent a number.
      void asset
      void toAsset
      throw new Error(
        'the 1Click minimum is not published; run spikes/01-1click-quote.ts with a real Zcash address',
      )
    },
  }
}

export class OneClickError extends Error {
  override readonly name = 'OneClickError'
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`1Click responded ${status}: ${body.slice(0, 200)}`)
  }
}
