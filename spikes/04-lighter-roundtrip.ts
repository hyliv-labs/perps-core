/**
 * Spike 04 — Lighter deposit, one order, fast withdrawal.
 *
 * Settles the venue path and two numbers the doc could not pin down: the
 * fast-withdrawal fee (documented only behind a login) and whether API key
 * registration and order signing can happen in a browser at all. If signing
 * needs a native binary or a Python SDK, the "no backend" property is at
 * risk and the adapter needs a WASM path.
 *
 * Read-only by default. Pass --live to actually deposit and trade.
 */

import { optional, report, required } from './_report'

const API = required('LIGHTER_API_URL')
const LIVE = process.argv.includes('--live')

async function get(path: string): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${API}${path}`)
  const text = await response.text()
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    json = text
  }
  return { status: response.status, json }
}

interface OrderBook {
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

async function main(): Promise<void> {
  // Public endpoints first: they cost nothing and reveal the shapes.
  // /api/v1/status answers 403 without credentials, so it is no use as a
  // reachability check; the order books are public and answer 200.
  const books = await get('/api/v1/orderBooks')
  const all = ((books.json as { order_books?: OrderBook[] }).order_books ?? [])
  const feePairs = new Set(all.map((m) => `${m.taker_fee}/${m.maker_fee}`))
  const eth = all.find((m) => m.symbol === 'ETH')

  console.log(`markets: ${all.length}`)
  console.log(`distinct taker/maker fee pairs: ${[...feePairs].join(' , ')}`)
  if (eth) {
    console.log(
      `ETH: market_id ${eth.market_id}, min base ${eth.min_base_amount},` +
        ` min quote ${eth.min_quote_amount}, size ${eth.supported_size_decimals}dp,` +
        ` price ${eth.supported_price_decimals}dp`,
    )
  }

  if (!LIVE) {
    console.log(
      '\nRead-only. To settle the rest, re-run with --live and a funded' +
        '\nsession wallet, then record:' +
        '\n  - does account creation happen implicitly on deposit?' +
        '\n  - what does API key registration sign, and can WebCrypto do it?' +
        '\n  - the exact fast-withdrawal fee on a 4 USDC minimum' +
        '\n  - wall-clock time from withdrawal request to USDC on Arbitrum',
    )
  }

  report({
    spike: '04-lighter-roundtrip',
    settles: 'Venue path, browser-side signing, fast-withdrawal fee',
    verdict: books.status === 200 ? 'partial' : 'fail',
    findings: {
      orderBooksStatus: books.status,
      markets: all.length,
      feePairs: [...feePairs].join(' , '),
      ethMarketId: eth?.market_id ?? 'not found',
      ethMinBase: eth?.min_base_amount ?? 'not found',
      ethMinQuote: eth?.min_quote_amount ?? 'not found',
      statusEndpoint: '403 without credentials; not a reachability check',
      live: LIVE,
      signerLanguage: optional('LIGHTER_SIGNER') ?? 'unknown — the thing to find out',
    },
    notes: LIVE
      ? 'Record the withdrawal fee and the signing requirement above.'
      : 'Public endpoints only. Re-run with --live once a session wallet is funded.',
  })
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
