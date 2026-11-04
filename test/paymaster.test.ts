import { describe, expect, it } from 'vitest'
import { decodeFunctionData, encodeFunctionResult, parseAbi } from 'viem'
import {
  GAS_RESERVE_UNITS,
  GasNotConfiguredError,
  GasUnavailableError,
  PAYMASTER_PERMIT_UNITS,
  PAYMASTER_SURCHARGE_BPS,
  USDC_ARBITRUM,
  createCirclePaymasterGas,
  createEthGas,
  encodeCirclePaymasterData,
  isDelegatedTo,
  unitsAfterGasReserve,
  usdcTransfer,
  weiToUsdc,
  withSurcharge,
} from '@/adapters/paymaster'
import type { NetworkAdapter } from '@/adapters/types'
import { testLogger, USDC } from './helpers'
import { evmAddress, hex, parseAmount } from '@/core/types'
import { privateKeyToAccount } from 'viem/accounts'

const account = privateKeyToAccount(`0x${'ab'.repeat(32)}`)
const WALLET = evmAddress(`0x${'5e'.repeat(20)}`)

const net: NetworkAdapter = {
  kind: 'tor',
  isPrivate: true,
  assurance: 'verified',
  fetch: async () => new Response('{}'),
}

const base = {
  network: net,
  logger: testLogger,
  account,
  rpcUrl: 'https://arb1.example/rpc',
}

describe('the paymaster path', () => {
  it('refuses to run without a bundler, naming what is missing', async () => {
    const gas = createCirclePaymasterGas(base)
    await expect(gas.prepare(WALLET)).rejects.toThrow(GasNotConfiguredError)
    await expect(gas.prepare(WALLET)).rejects.toThrow(/bundler URL/)
  })

  it('names each missing piece in turn rather than guessing', async () => {
    const withBundler = createCirclePaymasterGas({ ...base, bundlerUrl: 'https://b.example' })
    // Guessing a paymaster address would build an operation a bundler
    // rejects at best, and mines wrongly at worst.
    await expect(withBundler.prepare(WALLET)).rejects.toThrow(/paymaster address/)

    const withPaymaster = createCirclePaymasterGas({
      ...base,
      bundlerUrl: 'https://b.example',
      paymasterAddress: evmAddress(`0x${'11'.repeat(20)}`),
    })
    await expect(withPaymaster.prepare(WALLET)).rejects.toThrow(/7702 delegate/)
  })

  it('refuses a wallet that is not the signing key', async () => {
    const gas = createCirclePaymasterGas({
      ...base,
      bundlerUrl: 'https://b.example',
      paymasterAddress: evmAddress(`0x${'11'.repeat(20)}`),
      delegateAddress: evmAddress(`0x${'22'.repeat(20)}`),
    })
    await expect(gas.prepare(WALLET)).rejects.toThrow(/does not match the key/)
  })
})

describe('the forming user operation', () => {
  const delegate = evmAddress(`0x${'22'.repeat(20)}`)
  const paymaster = evmAddress(`0x${'11'.repeat(20)}`)
  const wallet = evmAddress(account.address)
  const balance = 5_000_000n
  const txHash = `0x${'cd'.repeat(32)}`

  it('packs Circle’s permit as mode, token, value, signature', () => {
    const signature = hex(`0x${'ab'.repeat(65)}`)
    const packed = encodeCirclePaymasterData({
      token: USDC_ARBITRUM,
      value: PAYMASTER_PERMIT_UNITS,
      signature,
    })
    expect(packed.startsWith('0x00')).toBe(true)
    expect(packed.toLowerCase()).toContain(USDC_ARBITRUM.slice(2).toLowerCase())
    expect(packed.endsWith('ab'.repeat(65))).toBe(true)
  })

  it('recognises an EIP-7702 delegation and nothing weaker', () => {
    expect(isDelegatedTo(`0xef0100${'22'.repeat(20)}`, delegate)).toBe(true)
    expect(isDelegatedTo('0x', delegate)).toBe(false)
    expect(isDelegatedTo('0x0', delegate)).toBe(false)
    expect(isDelegatedTo(`0xef0100${'33'.repeat(20)}`, delegate)).toBe(false)
  })

  it('keeps a USDC reserve when the transfer would empty the wallet', () => {
    expect(unitsAfterGasReserve(balance, balance, GAS_RESERVE_UNITS)).toBe(balance - GAS_RESERVE_UNITS)
    expect(unitsAfterGasReserve(balance, 1_000_000n, GAS_RESERVE_UNITS)).toBe(1_000_000n)
    expect(() => unitsAfterGasReserve(GAS_RESERVE_UNITS, 1n, GAS_RESERVE_UNITS)).toThrow(
      GasUnavailableError,
    )
  })

  it('converts wei to USDC without rounding down', () => {
    // 0.001 ETH at $3,000 is exactly 3 USDC.
    expect(weiToUsdc(10n ** 15n, 3000n * 10n ** 8n)).toBe(3_000_000n)
    expect(weiToUsdc(1n, 1n)).toBe(1n)
  })

  it('submits a user operation that pays the paymaster in USDC', async () => {
    const calls: { url: string; method: string; params: unknown[] }[] = []
    const net: NetworkAdapter = {
      kind: 'tor',
      isPrivate: true,
      assurance: 'verified',
      async fetch(url, init) {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          id?: number
          method?: string
          params?: unknown[]
        }
        const method = body.method ?? ''
        calls.push({ url: String(url), method, params: body.params ?? [] })
        const result = answer(method, body.params ?? [])
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { status: 200 })
      },
    }
    const gas = createCirclePaymasterGas({
      network: net,
      logger: testLogger,
      account,
      rpcUrl: 'https://arb.example/rpc',
      bundlerUrl: 'https://bundler.example',
      paymasterAddress: paymaster,
      delegateAddress: delegate,
    })

    const sent = await gas.send(wallet, USDC_ARBITRUM, usdcTransfer(evmAddress(`0x${'de'.repeat(20)}`), balance))
    expect(sent).toBe(txHash)

    const op = calls.find((c) => c.method === 'eth_sendUserOperation')
    expect(op?.url).toBe('https://bundler.example')
    const request = op?.params[0] as {
      paymaster?: string
      paymasterData?: string
      callData?: string
      eip7702Auth?: { address?: string }
    }
    expect(request.paymaster?.toLowerCase()).toBe(paymaster.toLowerCase())
    expect(request.paymasterData?.toLowerCase().startsWith('0x00')).toBe(true)
    expect(request.paymasterData?.toLowerCase()).toContain(USDC_ARBITRUM.slice(2).toLowerCase())
    expect(request.eip7702Auth?.address?.toLowerCase()).toBe(delegate.toLowerCase())
    expect(op?.params[1]?.toString().toLowerCase()).toBe('0x4337084d9e255ff0702461cf8895ce9e3b5ff108')

    const executed = decodeFunctionData({
      abi: parseAbi(['function execute(address target, uint256 value, bytes data)']),
      data: request.callData as `0x${string}`,
    })
    const transferred = decodeFunctionData({
      abi: parseAbi(['function transfer(address,uint256) returns (bool)']),
      data: executed.args[2],
    })
    expect(transferred.args[1]).toBe(balance - GAS_RESERVE_UNITS)
    expect(calls.every((c) => c.url === 'https://arb.example/rpc' || c.url === 'https://bundler.example')).toBe(
      true,
    )

    function answer(method: string, params: unknown[]): unknown {
      if (method === 'eth_call') return ethCall(String(params[0] && (params[0] as { data?: string }).data))
      if (method === 'eth_getCode') return '0x'
      if (method === 'eth_getTransactionCount') return '0x0'
      if (method === 'eth_estimateGas') return '0x5208'
      if (method === 'eth_gasPrice') return '0x1'
      if (method === 'eth_chainId') return '0xa4b1'
      if (method === 'pimlico_getUserOperationGasPrice') {
        return {
          standard: { maxFeePerGas: '0x1', maxPriorityFeePerGas: '0x1' },
        }
      }
      if (method === 'eth_estimateUserOperationGas') {
        return {
          callGasLimit: '0x5208',
          verificationGasLimit: '0x30d40',
          preVerificationGas: '0x5208',
          paymasterVerificationGasLimit: '0x30d40',
          paymasterPostOpGasLimit: '0x88b8',
        }
      }
      if (method === 'eth_sendUserOperation') return `0x${'ab'.repeat(32)}`
      if (method === 'eth_getUserOperationReceipt') {
        return {
          userOpHash: `0x${'ab'.repeat(32)}`,
          success: true,
          actualGasCost: '0x1',
          actualGasUsed: '0x1',
          logs: [],
          receipt: {
            transactionHash: txHash,
            transactionIndex: '0x0',
            blockHash: `0x${'11'.repeat(32)}`,
            blockNumber: '0x1',
            from: wallet,
            to: '0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108',
            cumulativeGasUsed: '0x1',
            gasUsed: '0x1',
            contractAddress: null,
            logs: [],
            logsBloom: `0x${'00'.repeat(256)}`,
            status: '0x1',
            effectiveGasPrice: '0x1',
            type: '0x2',
          },
        }
      }
      throw new Error(`unexpected ${method}`)
    }

    function ethCall(data: string | undefined): string {
      const selector = data?.slice(0, 10)
      const abi = parseAbi([
        'function name() view returns (string)',
        'function version() view returns (string)',
        'function nonces(address) view returns (uint256)',
        'function balanceOf(address) view returns (uint256)',
        'function getNonce(address, uint192) view returns (uint256)',
        'function latestAnswer() view returns (int256)',
      ])
      if (selector === '0x06fdde03') {
        return encodeFunctionResult({ abi, functionName: 'name', result: 'USD Coin' })
      }
      if (selector === '0x54fd4d50') {
        return encodeFunctionResult({ abi, functionName: 'version', result: '2' })
      }
      if (selector === '0x7ecebe00') {
        return encodeFunctionResult({ abi, functionName: 'nonces', result: 0n })
      }
      if (selector === '0x70a08231') {
        return encodeFunctionResult({ abi, functionName: 'balanceOf', result: balance })
      }
      if (selector === '0x35567e1a') {
        return encodeFunctionResult({ abi, functionName: 'getNonce', result: 0n })
      }
      if (selector === '0x50d25bcd') {
        return encodeFunctionResult({ abi, functionName: 'latestAnswer', result: 3000n * 10n ** 8n })
      }
      throw new Error(`unexpected eth_call ${selector}`)
    }
  })
})

describe('the surcharge', () => {
  it('is ten per cent, rounded up', () => {
    expect(PAYMASTER_SURCHARGE_BPS).toBe(1_000)
    expect(withSurcharge(USDC('100')).units).toBe(110_000_000n)
  })

  it('never rounds a cost down', () => {
    // A gas estimate that is short leaves the session with an operation it
    // cannot pay for.
    expect(withSurcharge(parseAmount('USDC', '0.000001')).units).toBe(2n)
  })
})

describe('the USDC transfer the exit leg sends', () => {
  it('encodes transfer(address,uint256)', () => {
    const data = usdcTransfer(evmAddress(`0x${'de'.repeat(20)}`), 455_000_000n)
    expect(data.startsWith('0xa9059cbb')).toBe(true)
    expect(data.toLowerCase()).toContain('de'.repeat(20))
  })

  it('points at native USDC on Arbitrum', () => {
    expect(USDC_ARBITRUM.toLowerCase()).toBe('0xaf88d065e77c8cc2239327c5edb3a432268e5831')
  })
})

/**
 * The privacy claim the product makes about chain reads.
 *
 * Both gas adapters used viem's `http()` transport, which calls global
 * `fetch`, under a comment saying the reads were routed through the app's
 * network layer. They were not: every Arbitrum read carried the session
 * wallet's address out over the clear network while the checker reported
 * the connection private.
 */
describe('chain reads stay inside the network adapter', () => {
  function counting() {
    const urls: string[] = []
    const net: NetworkAdapter = {
      kind: 'tor',
      isPrivate: true,
      assurance: 'verified',
      async fetch(url, init) {
        urls.push(String(url))
        const call = JSON.parse(String(init?.body ?? '{}')) as { id?: number }
        // Any balance will do; the point is which pipe the question went down.
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: '0x0' }), {
          status: 200,
        })
      },
    }
    return { net, urls }
  }

  const account = privateKeyToAccount(`0x${'22'.repeat(32)}`)
  const RPC = 'https://arb.example/rpc'

  it('routes the ETH fallback’s reads through it', async () => {
    const { net, urls } = counting()
    const gas = createEthGas({ network: net, logger: testLogger, account, rpcUrl: RPC })
    // It refuses, because the stub reports no ETH. That is the right answer
    // and beside the point: what matters is that it asked down our pipe.
    await gas.prepare(evmAddress(`0x${'5e'.repeat(20)}`)).catch(() => {})
    expect(urls).toContain(RPC)
  })

  it('routes the paymaster’s reads through it', async () => {
    const { net, urls } = counting()
    const gas = createCirclePaymasterGas({
      network: net,
      logger: testLogger,
      account,
      rpcUrl: RPC,
      bundlerUrl: 'https://bundler.example',
      paymasterAddress: evmAddress(`0x${'ab'.repeat(20)}`),
      delegateAddress: evmAddress(`0x${'cd'.repeat(20)}`),
    })
    // prepare reads the delegation back with getCode before doing anything.
    await gas.prepare(evmAddress(account.address)).catch(() => {})
    expect(urls.some((u) => u === RPC)).toBe(true)
  })

  it('reports an RPC failure rather than returning a wrong answer', async () => {
    const net: NetworkAdapter = {
      kind: 'tor',
      isPrivate: true,
      assurance: 'verified',
      async fetch() {
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'node is behind' } }),
          { status: 200 },
        )
      },
    }
    const gas = createEthGas({ network: net, logger: testLogger, account, rpcUrl: RPC })
    await expect(gas.prepare(evmAddress(`0x${'5e'.repeat(20)}`))).rejects.toThrow(/node is behind/)
  })
})
