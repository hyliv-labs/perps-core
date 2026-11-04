/**
 * Spike 03 — Circle Paymaster with an EIP-7702 session wallet on Arbitrum.
 *
 * Read-only unless `--live` is passed. `--live` sends 0.01 USDC from the
 * throwaway wallet back to itself, and the paymaster takes the gas in USDC.
 * The wallet must hold USDC and zero ETH. Zero ETH is the point of the test.
 */

import { createPublicClient, http, formatUnits } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arbitrum } from 'viem/chains'
import { createDirectNetwork } from '../src/adapters/network/index'
import {
  createCirclePaymasterGas,
  isDelegatedTo,
  usdcTransfer,
} from '../src/adapters/paymaster/index'
import { createLogger } from '../src/core/log'
import { evmAddress } from '../src/core/types'
import { optional, report, required } from './_report'

const RPC = required('ARBITRUM_RPC_URL')
const KEY = required('SPIKE_PRIVATE_KEY')
const PAYMASTER = optional('CIRCLE_PAYMASTER_ADDRESS')
const BUNDLER = optional('BUNDLER_URL')
const DELEGATE = optional('CIRCLE_DELEGATE_ADDRESS')
const LIVE = process.argv.includes('--live')

const USDC = evmAddress('0xaf88d065e77c8cC2239327C5EDb3A432268e5831')
/** 0.01 USDC. The rest stays so the paymaster can collect its fee. */
const SEND_UNITS = 10_000n
const ERC20_BALANCE_OF = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

function privateKey(): `0x${string}` {
  const trimmed = KEY.trim()
  const hex = trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
    console.error('SPIKE_PRIVATE_KEY must be a 32-byte hex key.')
    process.exit(1)
  }
  return hex as `0x${string}`
}

function redact(value: string): string {
  return value.replace(/0x[0-9a-fA-F]{64}/g, '[redacted]')
}

async function main(): Promise<void> {
  const account = privateKeyToAccount(privateKey())
  const publicClient = createPublicClient({ chain: arbitrum, transport: http(RPC) })

  const read = async () => {
    const [ethBalance, usdcBalance, code] = await Promise.all([
      publicClient.getBalance({ address: account.address }),
      publicClient.readContract({
        address: USDC as `0x${string}`,
        abi: ERC20_BALANCE_OF,
        functionName: 'balanceOf',
        args: [account.address],
      }),
      publicClient.getCode({ address: account.address }),
    ])
    return { ethBalance, usdcBalance, code }
  }

  const before = await read()
  console.log(`wallet:     ${account.address}`)
  console.log(`ETH:        ${formatUnits(before.ethBalance, 18)}`)
  console.log(`USDC:       ${formatUnits(before.usdcBalance, 6)}`)
  console.log(`delegated:  ${before.code && before.code !== '0x' ? before.code : 'no (plain EOA)'}`)

  if (!LIVE) {
    const ready = Boolean(PAYMASTER && BUNDLER && DELEGATE)
    report({
      spike: '03-paymaster-7702',
      settles: 'Gas strategy C: USDC-only session wallet can transact on Arbitrum',
      verdict: ready ? 'partial' : 'fail',
      findings: {
        wallet: account.address,
        ethWei: before.ethBalance,
        usdc: formatUnits(before.usdcBalance, 6),
        alreadyDelegated: Boolean(before.code && before.code !== '0x'),
        paymasterConfigured: Boolean(PAYMASTER),
        bundlerConfigured: Boolean(BUNDLER),
        delegateConfigured: Boolean(DELEGATE),
      },
      notes: ready
        ? 'Balances read. Pass --live to send 0.01 USDC back to this wallet.'
        : 'Blocked on paymaster, bundler, or delegate. Balances above are still worth recording.',
    })
    return
  }

  if (!PAYMASTER || !BUNDLER || !DELEGATE) {
    console.error('Set CIRCLE_PAYMASTER_ADDRESS, CIRCLE_DELEGATE_ADDRESS, and BUNDLER_URL.')
    process.exit(1)
  }
  if (before.ethBalance > 0n) {
    console.error('Refusing to send. This wallet holds ETH, so a success would not prove USDC gas.')
    process.exit(1)
  }
  if (before.usdcBalance <= 100_000n) {
    console.error('Refusing to send. The wallet needs more than 0.10 USDC so the reserve and the transfer both fit.')
    process.exit(1)
  }

  const delegate = evmAddress(DELEGATE)
  const wallet = evmAddress(account.address)
  const gas = createCirclePaymasterGas({
    network: createDirectNetwork({ timeoutMs: 60_000 }),
    logger: createLogger({
      write(level, message) {
        console.log(`[${level}] ${message}`)
      },
    }),
    account,
    rpcUrl: RPC,
    bundlerUrl: BUNDLER,
    paymasterAddress: evmAddress(PAYMASTER),
    delegateAddress: delegate,
  })

  console.log('\nSending 0.01 USDC back to this wallet. Gas is paid in USDC.')
  const txHash = await gas.send(wallet, USDC, usdcTransfer(wallet, SEND_UNITS), 0n)
  console.log(`submitted:  ${txHash}`)

  const after = await read()
  const delegated = isDelegatedTo(after.code, delegate)
  const spent = before.usdcBalance - after.usdcBalance
  const passed = after.ethBalance === 0n && delegated && spent > SEND_UNITS && spent < 100_000n

  console.log(`ETH after:  ${formatUnits(after.ethBalance, 18)}`)
  console.log(`USDC after: ${formatUnits(after.usdcBalance, 6)}`)
  console.log(`spent:      ${formatUnits(spent, 6)} USDC (0.01 plus the paymaster fee)`)
  console.log(`delegated:  ${delegated ? 'yes' : after.code ?? 'no'}`)

  report({
    spike: '03-paymaster-7702',
    settles: 'Gas strategy C: USDC-only session wallet can transact on Arbitrum',
    verdict: passed ? 'pass' : 'partial',
    findings: {
      wallet: account.address,
      txHash,
      ethWeiAfter: after.ethBalance,
      usdcBefore: formatUnits(before.usdcBalance, 6),
      usdcAfter: formatUnits(after.usdcBalance, 6),
      spentUsdc: formatUnits(spent, 6),
      delegated,
    },
    notes: passed
      ? 'User operation mined. ETH is still zero and the wallet is delegated to the configured account.'
      : 'The operation was submitted. ETH, the delegation, or the USDC spent did not all match a completed paymaster payment.',
  })
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
  console.error(redact(message))
  process.exit(1)
})
