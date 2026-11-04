/**
 * Why has the withdrawal not landed?
 *
 * The public tx endpoint only says `committed_at: 0`, which is the same
 * answer for "waiting its turn" and "nobody will ever take it". Lighter's
 * own withdrawal history is authenticated and knows the difference, so this
 * mints an auth token with the session key and asks.
 */
import { createWasmSigner } from '@/adapters/lighter/wasm-signer'
import { privateKeyToAccount } from 'viem/accounts'

const API = 'https://mainnet.zklighter.elliot.ai'
const ACCOUNT_INDEX = 766821
const API_KEY_INDEX = 0
const KEY = (process.env.SPIKE_PRIVATE_KEY!.startsWith('0x')
  ? process.env.SPIKE_PRIVATE_KEY!
  : `0x${process.env.SPIKE_PRIVATE_KEY}`) as `0x${string}`

async function apiKeyHex(): Promise<string> {
  const account = privateKeyToAccount(KEY)
  const seed = new TextEncoder().encode(`coldtrail/lighter/${account.address.toLowerCase()}`)
  const bits = await crypto.subtle.digest('SHA-512', seed)
  return Buffer.from(new Uint8Array(bits).slice(0, 40)).toString('hex')
}

async function main() {
  const signer = await createWasmSigner({
    basePath: process.env.SIGNER_BASE ?? 'http://localhost:5173/lighter',
    privateKey: await apiKeyHex(),
    accountIndex: ACCOUNT_INDEX,
    apiKeyIndex: API_KEY_INDEX,
  })
  const auth = await signer.authToken({ apiKeyIndex: API_KEY_INDEX })
  console.log('auth token minted\n')

  const paths = [
    `/api/v1/withdraw/history?account_index=${ACCOUNT_INDEX}&limit=10`,
    `/api/v1/accountTxs?by=account_index&value=${ACCOUNT_INDEX}&limit=10`,
    `/api/v1/account?by=index&value=${ACCOUNT_INDEX}`,
  ]
  for (const p of paths) {
    const r = await fetch(`${API}${p}`, { headers: { authorization: String(auth) } })
    const t = await r.text()
    console.log(`${r.status}  ${p}`)
    console.log(`   ${t.slice(0, 700)}\n`)
  }
}
main().catch((e) => console.error('ERR:', String(e?.message ?? e).slice(0, 400)))
