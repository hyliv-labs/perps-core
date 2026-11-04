import { describe, expect, it, vi } from 'vitest'
import { createOneClickAdapter, OneClickError } from '@/adapters/near1click/http'
import type { NetworkAdapter } from '@/adapters/types'
import { testLogger, T0, USDC, ZEC } from './helpers'
import type { SwapLeg } from '@/core/session'

/** A network stub that records what the adapter asked for. */
function stubNetwork(replies: { status: number; body: unknown }[]): NetworkAdapter & {
  calls: { url: string; init?: RequestInit }[]
} {
  const calls: { url: string; init?: RequestInit }[] = []
  let i = 0
  return {
    kind: 'tor',
    isPrivate: true,
    assurance: 'verified',
    calls,
    async fetch(url, init) {
      calls.push({ url, ...(init ? { init } : {}) })
      const reply = replies[Math.min(i++, replies.length - 1)]!
      return new Response(JSON.stringify(reply.body), { status: reply.status })
    },
  }
}

const QUOTE_BODY = {
  quote: {
    amountIn: '100000000',
    amountInFormatted: '1.0',
    amountInUsd: '1230.92',
    minAmountIn: '100000000',
    amountOut: '1227000000',
    amountOutFormatted: '1227.0',
    amountOutUsd: '1226.64',
    minAmountOut: '1214730000',
    deadline: new Date(T0 + 2 * 60 * 60_000).toISOString(),
  },
  depositAddress: 't1depositaddressfrom1click',
}

const leg = (patch: Partial<SwapLeg> = {}): SwapLeg => ({
  quoteId: 't1depositaddressfrom1click',
  depositAddress: 't1depositaddressfrom1click',
  amountIn: ZEC('1'),
  amountOutMin: USDC('1214.73'),
  deadline: T0 + 2 * 60 * 60_000,
  refundTo: `u1${'q'.repeat(40)}`,
  recipient: `0x${'5e'.repeat(20)}`,
  status: 'deposited',
  ...patch,
})

describe('1Click adapter', () => {
  it('sends every request through the network layer, never global fetch', async () => {
    const network = stubNetwork([{ status: 201, body: QUOTE_BODY }])
    const globalFetch = vi.spyOn(globalThis, 'fetch')
    const near = createOneClickAdapter({ network, logger: testLogger, now: () => T0 })

    await near.quote({
      from: ZEC('1'),
      toAsset: 'USDC',
      recipient: `0x${'5e'.repeat(20)}`,
      refundTo: `u1${'q'.repeat(40)}`,
      deadlineMs: 2 * 60 * 60_000,
    })

    expect(network.calls).toHaveLength(1)
    // A quote sent over the clear network would tie the caller's IP to the
    // deposit address, which is the link the product exists to break.
    expect(globalFetch).not.toHaveBeenCalled()
    globalFetch.mockRestore()
  })

  it('sends the required type fields and the confirmed asset ids', async () => {
    const network = stubNetwork([{ status: 201, body: QUOTE_BODY }])
    const near = createOneClickAdapter({ network, logger: testLogger, now: () => T0 })
    await near.quote({
      from: ZEC('1'),
      toAsset: 'USDC',
      recipient: `0x${'5e'.repeat(20)}`,
      refundTo: `u1${'q'.repeat(40)}`,
      deadlineMs: 2 * 60 * 60_000,
    })
    const sent = JSON.parse(String(network.calls[0]!.init!.body))
    expect(sent.depositType).toBe('ORIGIN_CHAIN')
    expect(sent.recipientType).toBe('DESTINATION_CHAIN')
    expect(sent.refundType).toBe('ORIGIN_CHAIN')
    expect(sent.confidentiality).toBe('basic')
    expect(sent.originAsset).toBe('nep141:zec.omft.near')
    expect(sent.destinationAsset).toBe(
      'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near',
    )
    expect(sent.amount).toBe('100000000')
  })

  it('accepts 201 and maps the quote onto a leg', async () => {
    const network = stubNetwork([{ status: 201, body: QUOTE_BODY }])
    const near = createOneClickAdapter({ network, logger: testLogger, now: () => T0 })
    const result = await near.quote({
      from: ZEC('1'),
      toAsset: 'USDC',
      recipient: `0x${'5e'.repeat(20)}`,
      refundTo: `u1${'q'.repeat(40)}`,
      deadlineMs: 2 * 60 * 60_000,
    })
    expect(result.depositAddress).toBe('t1depositaddressfrom1click')
    expect(result.amountOutMin.units).toBe(1_214_730_000n)
    expect(result.status).toBe('quoted')
  })

  it('refuses a quote that carries no deposit address', async () => {
    const network = stubNetwork([{ status: 201, body: { quote: QUOTE_BODY.quote } }])
    const near = createOneClickAdapter({ network, logger: testLogger, now: () => T0 })
    await expect(
      near.quote({
        from: ZEC('1'),
        toAsset: 'USDC',
        recipient: `0x${'5e'.repeat(20)}`,
        refundTo: `u1${'q'.repeat(40)}`,
        deadlineMs: 2 * 60 * 60_000,
      }),
    ).rejects.toThrow(/no deposit address/)
  })

  it('treats a 404 from status as "not seen yet", not as a failure', async () => {
    const network = stubNetwork([{ status: 404, body: { message: 'not found' } }])
    const near = createOneClickAdapter({ network, logger: testLogger, now: () => T0 })
    const before = leg()
    expect(await near.status(before)).toBe(before)
  })

  it('maps a settled status and reads the amount that actually arrived', async () => {
    const network = stubNetwork([
      {
        status: 200,
        body: { status: 'SUCCESS', swapDetails: { amountOutFormatted: '1226.44' } },
      },
    ])
    const near = createOneClickAdapter({ network, logger: testLogger, now: () => T0 })
    const after = await near.status(leg())
    expect(after.status).toBe('settled')
    expect(after.settledAmount?.units).toBe(1_226_440_000n)
  })

  it('maps a refund', async () => {
    const network = stubNetwork([{ status: 200, body: { status: 'REFUNDED' } }])
    const near = createOneClickAdapter({ network, logger: testLogger, now: () => T0 })
    expect((await near.status(leg())).status).toBe('refunded')
  })

  it('treats an unknown status as still pending rather than settled', async () => {
    const network = stubNetwork([{ status: 200, body: { status: 'SOMETHING_NEW' } }])
    const near = createOneClickAdapter({ network, logger: testLogger, now: () => T0 })
    // Guessing "settled" would hand the session on with no money behind it.
    expect((await near.status(leg())).status).toBe('deposited')
  })

  it('raises a typed error on a failed request', async () => {
    const network = stubNetwork([{ status: 400, body: { message: 'refundTo is not valid' } }])
    const near = createOneClickAdapter({ network, logger: testLogger, now: () => T0 })
    await expect(
      near.quote({
        from: ZEC('1'),
        toAsset: 'USDC',
        recipient: `0x${'5e'.repeat(20)}`,
        refundTo: 'nonsense',
        deadlineMs: 2 * 60 * 60_000,
      }),
    ).rejects.toThrow(OneClickError)
  })

  it('refuses to invent a minimum it has not measured', async () => {
    const network = stubNetwork([{ status: 200, body: {} }])
    const near = createOneClickAdapter({ network, logger: testLogger, now: () => T0 })
    await expect(near.minimum('ZEC', 'USDC')).rejects.toThrow(/not published/)
  })
})
