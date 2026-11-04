/** Polls until the withdrawal credits the session wallet. */
const RPC = process.env.ARBITRUM_RPC_URL!
const WALLET = '0xe1AE6D510fb56F3c960Aaf098E170c540ae2729C'
const API = 'https://mainnet.zklighter.elliot.ai'

async function usdc(): Promise<number> {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{
      to: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
      data: '0x70a08231000000000000000000000000' + WALLET.slice(2) }, 'latest'] }) })
  const j: any = await r.json()
  return Number(BigInt(j.result)) / 1e6
}

async function main() {
  const start = await usdc()
  console.log(`wallet at start: ${start.toFixed(6)}`)
  const began = Date.now()
  for (let i = 0; i < 120; i++) {
    const mins = ((Date.now() - began) / 60000).toFixed(1)
    const bal = await usdc()
    const acct: any = await (await fetch(`${API}/api/v1/account?by=index&value=766821`)).json()
    const coll = acct?.accounts?.[0]?.collateral
    if (bal > start + 0.5) {
      console.log(`\n[${mins}m] WITHDRAWAL LANDED: wallet ${bal.toFixed(6)} (+${(bal - start).toFixed(6)})`)
      console.log(`lighter collateral now: ${coll}`)
      return
    }
    if (i % 3 === 0) console.log(`[${mins}m] wallet ${bal.toFixed(6)}, lighter collateral ${coll}`)
    await new Promise((r) => setTimeout(r, 20_000))
  }
  console.log('timed out')
}
main().catch((e) => console.error(String(e).slice(0, 300)))
