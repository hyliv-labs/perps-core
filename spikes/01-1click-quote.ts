/**
 * Spike 01 — 1Click quote shapes for the ZEC legs.
 *
 * RUN 2026-10-26. What it settled:
 *
 *   - The endpoint is POST /v0/quote and it answers 201, not 200.
 *   - `depositType` is required: ORIGIN_CHAIN | INTENTS | CONFIDENTIAL_INTENTS.
 *     `recipientType`: DESTINATION_CHAIN | INTENTS | CONFIDENTIAL_INTENTS.
 *     `refundType`: ORIGIN_CHAIN | INTENTS | CONFIDENTIAL_INTENTS.
 *     CONFIDENTIAL_INTENTS is the confidential swap the architecture doc
 *     records as invite-only; it is a value on the ordinary quote.
 *   - Asset ids are confirmed: ZEC is `nep141:zec.omft.near` (8 decimals),
 *     USDC on Arbitrum is
 *     `nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near` (6).
 *   - A quote answers with `{ quote: { amountIn, amountInFormatted,
 *     amountInUsd, minAmountIn, amountOut, amountOutFormatted, amountOutUsd,
 *     minAmountOut, ... } }`.
 *   - Addresses are validated at quote time, per chain. A burn address
 *     (0x…dead) is rejected. **Both ZEC legs need a real Zcash address**:
 *     `refundTo` on the way in, `recipient` on the way out. Without one the
 *     ZEC legs cannot be quoted at all, so the solver spread and the
 *     per-asset minimum are still open.
 *
 * Set SPIKE_ZEC_REFUND_ADDRESS to a shielded address you control and run
 * again to settle those two numbers. Quote only: nothing is deposited.
 */

import { optional, report, required } from './_report'

const API = required('ONECLICK_API_URL')
const JWT = optional('ONECLICK_JWT')
const ZEC_ADDRESS = optional('SPIKE_ZEC_REFUND_ADDRESS')

/** An Arbitrum address for the EVM side of each leg. Never paid: dry quotes. */
const EVM = optional('SPIKE_EVM_ADDRESS') ?? '0x1111111111111111111111111111111111111111'

const ZEC = 'nep141:zec.omft.near'
const USDC = 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near'

interface Quote {
  amountIn: string
  amountInFormatted: string
  amountInUsd: string
  amountOut: string
  amountOutFormatted: string
  amountOutUsd: string
  minAmountOut: string
  deadline?: string
  depositAddress?: string
}

async function quote(
  body: Record<string, unknown>,
): Promise<{ status: number; quote?: Quote; error?: unknown }> {
  const response = await fetch(`${API}/v0/quote`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(JWT ? { authorization: `Bearer ${JWT}` } : {}),
    },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = text
  }
  const ok = response.status >= 200 && response.status < 300
  const q = (parsed as { quote?: Quote } | null)?.quote
  return ok && q ? { status: response.status, quote: q } : { status: response.status, error: parsed }
}

const common = {
  dry: true,
  swapType: 'EXACT_INPUT',
  slippageTolerance: 100, // basis points
  depositType: 'ORIGIN_CHAIN',
  refundType: 'ORIGIN_CHAIN',
  recipientType: 'DESTINATION_CHAIN',
}

function line(name: string, r: Awaited<ReturnType<typeof quote>>): string {
  if (!r.quote) return `${name}: ${r.status} ${JSON.stringify(r.error).slice(0, 160)}`
  const q = r.quote
  const inUsd = Number(q.amountInUsd)
  const outUsd = Number(q.amountOutUsd)
  const spread = inUsd > 0 ? ((inUsd - outUsd) / inUsd) * 100 : NaN
  return (
    `${name}: ${r.status}  ${q.amountInFormatted} in ($${inUsd.toFixed(2)})` +
    ` -> ${q.amountOutFormatted} out ($${outUsd.toFixed(2)})` +
    `  all-in cost ${spread.toFixed(3)}%`
  )
}

async function main(): Promise<void> {
  const deadline = new Date(Date.now() + 2 * 60 * 60_000).toISOString()
  const shortDeadline = new Date(Date.now() + 60 * 60_000).toISOString()

  // Control: no Zcash, so this proves the request shape independently.
  const control = await quote({
    ...common,
    originAsset: USDC,
    destinationAsset: 'nep141:eth.omft.near',
    amount: '100000000', // 100 USDC
    refundTo: EVM,
    recipient: EVM,
    deadline,
  })
  console.log(line('CONTROL  USDC -> ETH ', control))

  if (!ZEC_ADDRESS || !/^(u1|zs1|t1|t3)/.test(ZEC_ADDRESS)) {
    console.log(
      '\nNo usable SPIKE_ZEC_REFUND_ADDRESS, so the two ZEC legs are skipped.' +
        '\n1Click validates the Zcash address when the quote is asked for, which' +
        '\nmeans the solver spread and the per-asset minimum cannot be read' +
        '\nwithout a real shielded address. Set one and run again.',
    )
    report({
      spike: '01-1click-quote',
      settles: 'Request shape, asset ids, response shape',
      verdict: control.quote ? 'partial' : 'fail',
      findings: {
        endpoint: 'POST /v0/quote',
        successStatus: control.status,
        requestShapeVerified: Boolean(control.quote),
        depositTypes: 'ORIGIN_CHAIN | INTENTS | CONFIDENTIAL_INTENTS',
        recipientTypes: 'DESTINATION_CHAIN | INTENTS | CONFIDENTIAL_INTENTS',
        zecLegsBlockedOn: 'a real Zcash address for refundTo and recipient',
      },
      notes:
        'Shape settled against the live API. The ZEC spread and minimum stay open until a shielded address is supplied.',
    })
    return
  }

  const zecIn = await quote({
    ...common,
    originAsset: ZEC,
    destinationAsset: USDC,
    amount: '100000000', // 1 ZEC
    refundTo: ZEC_ADDRESS,
    recipient: EVM,
    deadline,
  })
  console.log(line('ZEC -> USDC          ', zecIn))

  const usdcOut = await quote({
    ...common,
    originAsset: USDC,
    destinationAsset: ZEC,
    amount: '500000000', // 500 USDC
    refundTo: EVM,
    recipient: ZEC_ADDRESS,
    deadline: shortDeadline,
  })
  console.log(line('USDC -> ZEC          ', usdcOut))

  // The smallest amount the solver will still quote.
  let minimum = 'not found above 0.001 ZEC'
  for (const units of ['100000', '1000000', '5000000', '10000000']) {
    const r = await quote({
      ...common,
      originAsset: ZEC,
      destinationAsset: USDC,
      amount: units,
      refundTo: ZEC_ADDRESS,
      recipient: EVM,
      deadline,
    })
    if (r.quote) {
      minimum = `${r.quote.amountInFormatted} ZEC`
      break
    }
  }

  const both = Boolean(zecIn.quote && usdcOut.quote)
  report({
    spike: '01-1click-quote',
    settles: 'ZEC leg minimums, deadline window, solver spread',
    verdict: both ? 'pass' : 'partial',
    findings: {
      endpoint: 'POST /v0/quote',
      successStatus: control.status,
      zecInStatus: zecIn.status,
      usdcOutStatus: usdcOut.status,
      smallestQuotedZec: minimum,
      authenticated: Boolean(JWT),
    },
    notes: both
      ? 'Both legs quoted. The all-in cost on each line is the fee plus the solver spread together.'
      : 'One leg did not quote; its error is printed above.',
  })
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
