/**
 * The live round trip, one step per invocation.
 *
 * Deliberately not a single script that runs the whole thing. Every step
 * here moves real money and several have never run before, so each one is
 * invoked by name, reports what it did, and stops. A failure halfway
 * through a long script would leave funds somewhere with no record of
 * which step was reached.
 *
 *   pnpm spike spikes/90-roundtrip-live.ts <step>
 */
import { privateKeyToAccount } from 'viem/accounts'
import { createDirectNetwork } from '@/adapters/network'
import { createCirclePaymasterGas, usdcTransfer, USDC_ARBITRUM } from '@/adapters/paymaster'
import { createLighterAdapter } from '@/adapters/lighter/http'
import { createWasmSigner } from '@/adapters/lighter/wasm-signer'
import { createLogger } from '@/core/log'
import { amount, evmAddress } from '@/core/types'

const RPC = process.env.ARBITRUM_RPC_URL!
const BUNDLER = process.env.BUNDLER_URL!
const PAYMASTER = evmAddress(process.env.CIRCLE_PAYMASTER_ADDRESS!)
const DELEGATE = evmAddress(process.env.CIRCLE_DELEGATE_ADDRESS!)
const KEY = (process.env.SPIKE_PRIVATE_KEY!.startsWith('0x')
  ? process.env.SPIKE_PRIVATE_KEY!
  : `0x${process.env.SPIKE_PRIVATE_KEY}`) as `0x${string}`

const account = privateKeyToAccount(KEY)
const WALLET = evmAddress(account.address)
const LIGHTER_DEPOSIT = evmAddress('0x4d58aea9c7cd8E4210a99E83dA21F894af4Af488')

const logger = createLogger({ write: (l, m) => console.log(`  [${l}] ${m}`) })
const network = createDirectNetwork({ timeoutMs: 60_000 })

function gas() {
  return createCirclePaymasterGas({
    network, logger, account, rpcUrl: RPC, bundlerUrl: BUNDLER,
    paymasterAddress: PAYMASTER, delegateAddress: DELEGATE,
  })
}

async function usdcBalance(): Promise<bigint> {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{
      to: USDC_ARBITRUM, data: '0x70a08231000000000000000000000000' + WALLET.slice(2) }, 'latest'] }) })
  const j: any = await r.json()
  return BigInt(j.result)
}

const fmt = (u: bigint) => (Number(u) / 1e6).toFixed(6)

async function deposit() {
  const before = await usdcBalance()
  console.log(`wallet USDC before: ${fmt(before)}`)
  const send = 11_900_000n
  if (before < send + 100_000n) throw new Error('not enough USDC to deposit and keep a gas reserve')
  console.log(`sending ${fmt(send)} USDC -> ${LIGHTER_DEPOSIT} (gas in USDC)`)
  const tx = await gas().send(WALLET, USDC_ARBITRUM, usdcTransfer(LIGHTER_DEPOSIT, send), 0n)
  console.log(`tx: ${tx}`)
  const after = await usdcBalance()
  console.log(`wallet USDC after:  ${fmt(after)}`)
  console.log(`total spent:        ${fmt(before - after)} (11.90 transfer + gas)`)
}

/**
 * The Lighter API key: 40 bytes, derived from the EVM key.
 *
 * Lighter's signer refuses anything else, so this is not the EVM key and
 * cannot be. Derived deterministically so the same session recovers the
 * same key after a reload rather than registering a second one.
 */
async function apiKeyHex(): Promise<string> {
  const seed = new TextEncoder().encode(`coldtrail/lighter/${WALLET.toLowerCase()}`)
  const bits = await crypto.subtle.digest('SHA-512', seed)
  return Buffer.from(new Uint8Array(bits).slice(0, 40)).toString('hex')
}

/** Served by the dev server from public/lighter, hash-checked on load. */
const SIGNER_BASE = process.env.SIGNER_BASE ?? 'http://localhost:5173/lighter'

function lighter() {
  return createLighterAdapter({
    network,
    logger,
    createSigner: async ({ accountIndex, apiKeyIndex }) =>
      createWasmSigner({
        basePath: SIGNER_BASE,
        privateKey: await apiKeyHex(),
        accountIndex,
        apiKeyIndex,
      }),
    l1Sign: async (message: string) => account.signMessage({ message }),
  })
}

async function account_() {
  const lighter_ = lighter()
  console.log('looking for the account the deposit created...')
  const acct = await lighter_.openAccount(WALLET, amount('USDC', 11_900_000n))
  console.log(JSON.stringify(acct, null, 2))
}

/** Polls until the bridge credits and the account exists. */
async function awaitAccount() {
  const started = Date.now()
  for (let i = 0; i < 120; i++) {
    const mins = ((Date.now() - started) / 60000).toFixed(1)
    try {
      const acct = await lighter().openAccount(WALLET, amount('USDC', 11_900_000n))
      console.log(`\n[${mins}m] ACCOUNT LIVE`)
      console.log(JSON.stringify(acct, null, 2))
      return
    } catch (e) {
      const msg = String((e as Error)?.message ?? e)
      if (!msg.includes('account not found') && !msg.includes('21100')) {
        console.log(`[${mins}m] different error, stopping: ${msg.slice(0, 300)}`)
        throw e
      }
      if (i % 4 === 0) console.log(`[${mins}m] bridge has not credited yet`)
    }
    await new Promise((r) => setTimeout(r, 30_000))
  }
  console.log('timed out waiting for the bridge')
}

const ACCOUNT = {
  accountIndex: 766821,
  apiKeyIndex: 0,
  // Read back from the venue. The adapter compares this against what the
  // signer derives and refuses on a mismatch, which is what stops a session
  // authorising a key its account never registered.
  apiPublicKey: 'ac123b2008a4d4947adf53000c0b40ce06bd581e8b9de7ac4687df7ef22ba3214f2be5300a326e2f',
}

/** Buy a small ETH perp, bounded so the sweep cannot run away. */
async function trade() {
  const l = lighter()
  const books = await l.markets()
  const eth = books.find((m) => m.symbol === 'ETH')!
  console.log(`ETH market ${eth.marketId}, size ${eth.sizeDecimals}dp, price ${eth.priceDecimals}dp`)

  const r = await fetch('https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails?market_id=0')
  const j: any = await r.json()
  const last = Number((j.order_book_details ?? j.order_books)[0].last_trade_price)
  // An IOC sweep needs a worst acceptable price, not a placeholder: Lighter
  // refuses zero. One per cent above last is the bound, so a thin book
  // cannot fill this far away from where it was quoted.
  const bound = (last * 1.01).toFixed(2)
  console.log(`last ${last}, worst acceptable ${bound}`)

  const res = await l.placeOrder(ACCOUNT, {
    market: 'ETH', side: 'buy', size: '0.0050', type: 'market', price: bound, reduceOnly: false,
  })
  console.log(`order: ${JSON.stringify(res)}`)
}

async function positions() {
  const ps = await lighter().positions(ACCOUNT)
  console.log(JSON.stringify(ps, null, 2))
}

/** Cancel everything and flatten: an account with no orders can still be exposed. */
async function flatten() {
  const l = lighter()
  console.log('before:', JSON.stringify(await l.positions(ACCOUNT)))
  await l.closeAll(ACCOUNT)
  await new Promise((r) => setTimeout(r, 4000))
  console.log('after: ', JSON.stringify(await l.positions(ACCOUNT)))
}

/**
 * Close the position directly, without the cancel-all step.
 *
 * closeAll() cancels first, which is right in general — an account with no
 * orders can still be exposed, so cancelling alone is not closing. But the
 * entry was IOC and filled completely, so there is nothing resting, and the
 * cancel is currently refused by the venue. Going straight to the
 * reduce-only leg gets flat now; the cancel bug is a separate fix.
 */
async function close() {
  const l = lighter()
  const before = await l.positions(ACCOUNT)
  console.log('before:', JSON.stringify(before))
  if (before.length === 0) return console.log('already flat')

  const r = await fetch('https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails?market_id=0')
  const j: any = await r.json()
  const last = Number((j.order_book_details ?? j.order_books)[0].last_trade_price)
  // Selling, so the worst acceptable price is below last.
  const bound = (last * 0.99).toFixed(2)
  const size = Math.abs(Number(before[0]!.size)).toFixed(4)
  console.log(`selling ${size} ETH, worst acceptable ${bound}, reduce-only`)

  const res = await l.placeOrder(ACCOUNT, {
    market: 'ETH', side: 'sell', size, type: 'market', price: bound, reduceOnly: true,
  })
  console.log(`close order: ${JSON.stringify(res)}`)
  await new Promise((x) => setTimeout(x, 5000))
  console.log('after: ', JSON.stringify(await l.positions(ACCOUNT)))
}

/** Fast withdrawal back to the session wallet. Costs a flat dollar. */
async function withdraw() {
  const l = lighter()
  const ps = await l.positions(ACCOUNT)
  // Withdrawing free collateral while a perp is open retires the key with
  // the trade still running, so this refuses rather than checking later.
  if (ps.length > 0) throw new Error(`refusing to withdraw with ${ps.length} position(s) open`)

  const r = await fetch('https://mainnet.zklighter.elliot.ai/api/v1/account?by=index&value=766821')
  const j: any = await r.json()
  const available = Number(j.accounts[0].available_balance)
  const units = BigInt(Math.floor(available * 1e6))
  console.log(`available ${available}, withdrawing all of it (a flat $1 fee comes off)`)

  const res = await l.withdraw(ACCOUNT, WALLET, amount('USDC', units))
  console.log(`withdrawal ref: ${res.ref}`)
  console.log(`status: ${await l.withdrawalStatus(res.ref)}`)
  console.log(`wallet USDC now: ${fmt(await usdcBalance())}`)
}

async function main() {
  const step = process.argv[2]
  if (step === 'deposit') return deposit()
  if (step === 'account') return account_()
  if (step === 'await') return awaitAccount()
  if (step === 'trade') return trade()
  if (step === 'positions') return positions()
  if (step === 'flatten') return flatten()
  if (step === 'close') return close()
  if (step === 'withdraw') return withdraw()
  console.log('steps: deposit | account | await | trade | positions | flatten')
}
main().catch((e) => { console.error('FAILED:', String(e?.message ?? e).slice(0, 600)); process.exit(1) })
