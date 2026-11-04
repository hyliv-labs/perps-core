/**
 * Paying for gas.
 *
 * A session wallet is born holding USDC and no ETH, and that is deliberate:
 * funding it with ETH from anywhere would be the link the whole product
 * exists to break. So it has to transact without ever holding the chain's
 * native coin.
 *
 * Two strategies, both named in the architecture doc:
 *
 *   - **Circle Paymaster** (strategy C). The wallet delegates under EIP-7702
 *     and signs a USDC permit to the paymaster, which then pays the gas and
 *     takes USDC for it, with a ten per cent surcharge. Nothing has to be
 *     held but USDC.
 *   - **A little ETH** (strategy A). The documented fallback: swap a small
 *     amount for ETH and pay gas the ordinary way. Simpler, one more hop,
 *     and the hop is visible.
 *
 * Strategy C follows Circle's paymaster v0.8 quickstart. The session key
 * delegates to the Simple7702 account on the first user operation, so that
 * delegation is paid in USDC too. A separate 7702 transaction would need
 * ETH, which this wallet does not hold. The paymaster data is Circle's
 * documented packing: a mode byte, the USDC address, a permit value, and
 * the permit signature. The call itself is `execute(target, value, data)`
 * on that account, so a permit the bundler rejects never moves the tokens.
 */

import {
  createBundlerClient,
  toSimple7702SmartAccount,
} from 'viem/account-abstraction'
import type { PrivateKeyAccount } from 'viem/accounts'
import {
  createPublicClient,
  createWalletClient,
  custom,
  decodeFunctionData,
  encodeFunctionData,
  encodePacked,
  maxUint256,
  parseAbi,
  parseErc6492Signature,
  verifyTypedData,
  type Account,
  type Hex as ViemHex,
} from 'viem'
import { arbitrum } from 'viem/chains'
import type { GasAdapter, NetworkAdapter } from '../types'
import { type Amount, type EvmAddress, type Hex, amount, evmAddress, hex } from '@/core/types'
import type { Logger } from '@/core/log'

/** Native USDC on Arbitrum One. */
export const USDC_ARBITRUM = evmAddress('0xaf88d065e77c8cC2239327C5EDb3A432268e5831')

/** Circle takes ten per cent on top of the gas it pays for. */
export const PAYMASTER_SURCHARGE_BPS = 1_000

/**
 * USDC the permit lets Circle pull for one operation.
 *
 * This is the cap from Circle's v0.8 quickstart, not the expected cost.
 * The paymaster takes the real gas cost, up to this, and ignores the rest.
 * The deadline is `2^256 - 1` because a paymaster cannot read the block
 * timestamp while it validates the operation.
 */
export const PAYMASTER_PERMIT_UNITS = 10_000_000n

/** Verification and post-op gas Circle's quickstart budgets for the paymaster. */
export const PAYMASTER_VERIFICATION_GAS = 200_000n
export const PAYMASTER_POSTOP_GAS = 35_000n

/**
 * USDC left in the wallet when a transfer would otherwise empty it.
 *
 * The paymaster collects its fee from the same balance, in the same
 * operation, after the transfer. Sending every unit away makes that
 * collection revert, and the transfer reverts with it.
 *
 * Temporarily 0.10 USDC so the paymaster can be tried with a small balance.
 * Put this back to 1_000_000n (1 USDC) after that test.
 */
export const GAS_RESERVE_UNITS = 100_000n

/** ETH / USD on Arbitrum One, 8 decimals. A quote, not a swap. */
export const ETH_USD_ARBITRUM = evmAddress('0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612')

/**
 * Whether `send()` can submit a user operation.
 *
 * Kept next to the implementation so a capability report cannot claim USDC
 * gas from the three environment variables alone. It is on because `send()`
 * builds Circle's documented operation. Turn it off only by changing it
 * here, in the same change that stops `send()` from submitting.
 */
export const PAYMASTER_SEND_READY = true

export class GasNotConfiguredError extends Error {
  override readonly name = 'GasNotConfiguredError'
  constructor(missing: string) {
    super(
      `the paymaster path needs ${missing}. Set it, or fall back to the ETH strategy; ` +
        'guessing it would produce an operation a bundler rejects.',
    )
  }
}

export class GasUnavailableError extends Error {
  override readonly name = 'GasUnavailableError'
}

const ERC20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function nonces(address) view returns (uint256)',
  'function name() view returns (string)',
  'function version() view returns (string)',
  'function transfer(address,uint256) returns (bool)',
])

const PERMIT_TYPES = {
  Permit: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const

const PRICE_FEED = parseAbi(['function latestAnswer() view returns (int256)'])

/** EIP-7702 designates a delegate with `0xef0100` and the address. */
export function isDelegatedTo(code: string | undefined | null, delegate: EvmAddress): boolean {
  if (!code) return false
  return code.toLowerCase() === `0xef0100${delegate.slice(2).toLowerCase()}`
}

function isEmptyCode(code: string | undefined | null): boolean {
  return !code || /^0x0*$/i.test(code)
}

/**
 * How many units of a USDC transfer can be sent once gas has been kept back.
 *
 * `requested` is what the caller asked to move. The paymaster is paid from
 * what stays behind, so a transfer of the whole balance is cut down to
 * `balance - reserve`. A transfer that already leaves the reserve alone is
 * sent as asked.
 */
export function unitsAfterGasReserve(balance: bigint, requested: bigint, reserve: bigint): bigint {
  if (reserve <= 0n) throw new GasUnavailableError('the gas reserve is empty')
  if (balance <= reserve) {
    throw new GasUnavailableError(
      'the session wallet does not hold enough USDC to pay gas and still send the transfer',
    )
  }
  const room = balance - reserve
  return requested > room ? room : requested
}

/** Wei of gas into USDC units, rounded up. `ethUsd8` is Chainlink's 8-decimal price. */
export function weiToUsdc(wei: bigint, ethUsd8: bigint): bigint {
  if (wei < 0n || ethUsd8 <= 0n) {
    throw new GasUnavailableError('the ETH price feed returned nothing usable')
  }
  const scale = 10n ** 20n
  const product = wei * ethUsd8
  const units = product / scale
  return product % scale === 0n ? units : units + 1n
}

/**
 * Circle paymaster v0.8 data.
 *
 * Mode `0` means the trailing bytes are an EIP-2612 permit that lets the
 * paymaster pull USDC. Packed, not ABI-encoded: the signature is the raw
 * 65 bytes, with no length prefix.
 */
export function encodeCirclePaymasterData(permit: {
  readonly token: EvmAddress
  readonly value: bigint
  readonly signature: Hex
}): Hex {
  return hex(
    encodePacked(
      ['uint8', 'address', 'uint256', 'bytes'],
      [0, permit.token as ViemHex, permit.value, permit.signature as ViemHex],
    ),
  )
}

function requireOwner(account: Account): PrivateKeyAccount {
  if (account.type !== 'local' || typeof account.signAuthorization !== 'function') {
    throw new GasUnavailableError('this account cannot sign an EIP-7702 authorization')
  }
  return account as PrivateKeyAccount
}

function decodeTransfer(data: Hex): { to: EvmAddress; units: bigint } | null {
  try {
    const decoded = decodeFunctionData({ abi: ERC20, data: data as ViemHex })
    if (decoded.functionName !== 'transfer') return null
    const [to, units] = decoded.args
    return { to: evmAddress(to), units }
  } catch {
    return null
  }
}

function rpcQuantity(value: unknown): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value))
  if (typeof value === 'string' && /^(0x[0-9a-fA-F]+|\d+)$/.test(value)) return BigInt(value)
  throw new GasUnavailableError('the bundler returned a gas price that is not a number')
}

export interface PaymasterOptions {
  readonly network: NetworkAdapter
  readonly logger: Logger
  /** The session key, which signs the delegation, the permit and each call. */
  readonly account: Account
  readonly rpcUrl: string
  /** An ERC-4337 bundler. Without one there is nowhere to send an operation. */
  readonly bundlerUrl?: string
  readonly paymasterAddress?: EvmAddress
  /** The account implementation the wallet delegates to under 7702. */
  readonly delegateAddress?: EvmAddress
}

/**
 * Reads go through the app's network adapter, so an Arbitrum read cannot
 * leak the session wallet's address over the clear network.
 */
function clientFor(options: PaymasterOptions) {
  return createPublicClient({ chain: arbitrum, transport: rpcOver(options) })
}

/**
 * An EIP-1193 transport that speaks JSON-RPC over the app's network adapter.
 *
 * This used to be viem's `http()` with `onFetchRequest: undefined`, under a
 * comment claiming the reads were routed through us. They were not: viem's
 * http transport calls global `fetch`, so every Arbitrum read — each one
 * carrying the session wallet's address — went out over the clear network
 * while the checker reported the connection private.
 *
 * viem 2.21 has no hook to replace its fetch, so the transport is built from
 * the one thing that does route: `network.fetch`.
 */
export function rpcOver(options: Pick<PaymasterOptions, 'network' | 'rpcUrl'>) {
  let id = 0
  return custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      const response = await options.network.fetch(options.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: (id += 1),
          method,
          params: params ?? [],
        }),
      })
      const text = await response.text()
      if (!response.ok) {
        throw new GasUnavailableError(`${method}: the RPC answered ${response.status}`)
      }
      const body = JSON.parse(text) as { result?: unknown; error?: { message?: string } }
      if (body.error) {
        throw new GasUnavailableError(`${method}: ${body.error.message ?? 'rejected'}`)
      }
      return body.result
    },
  })
}

export function createCirclePaymasterGas(options: PaymasterOptions): GasAdapter {
  const { logger } = options
  const publicClient = clientFor(options)

  const requireConfig = () => {
    if (!options.bundlerUrl) throw new GasNotConfiguredError('a bundler URL')
    if (!options.paymasterAddress) throw new GasNotConfiguredError("Circle's paymaster address")
    if (!options.delegateAddress) throw new GasNotConfiguredError('a 7702 delegate address')
    return {
      bundlerUrl: options.bundlerUrl,
      paymaster: options.paymasterAddress,
      delegate: options.delegateAddress,
    }
  }

  const requireWallet = (wallet: EvmAddress) => {
    const owner = requireOwner(options.account)
    if (wallet.toLowerCase() !== owner.address.toLowerCase()) {
      throw new GasUnavailableError('the session wallet does not match the key that would sign for it')
    }
    return owner
  }

  /** The bundler speaks JSON-RPC, and it goes through our network layer too. */
  async function bundler<T>(method: string, params: unknown[]): Promise<T> {
    const { bundlerUrl } = requireConfig()
    const response = await options.network.fetch(bundlerUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
    const text = await response.text()
    if (!response.ok) {
      throw new GasUnavailableError(`${method}: the bundler answered ${response.status}`)
    }
    let body: { result?: T; error?: { message?: string } }
    try {
      body = JSON.parse(text) as { result?: T; error?: { message?: string } }
    } catch {
      throw new GasUnavailableError(`${method}: the bundler did not return JSON`)
    }
    if (body.error) throw new GasUnavailableError(`${method}: ${body.error.message ?? 'rejected'}`)
    if (body.result === undefined) throw new GasUnavailableError(`${method}: no result`)
    return body.result
  }

  async function circlePaymasterFields() {
    const { paymaster } = requireConfig()
    const owner = requireOwner(options.account)
    const usdc = USDC_ARBITRUM as ViemHex
    const [name, version, nonce] = await Promise.all([
      publicClient.readContract({ address: usdc, abi: ERC20, functionName: 'name' }),
      publicClient.readContract({ address: usdc, abi: ERC20, functionName: 'version' }),
      publicClient.readContract({
        address: usdc,
        abi: ERC20,
        functionName: 'nonces',
        args: [owner.address],
      }),
    ])
    const permit = {
      domain: {
        name,
        version,
        chainId: arbitrum.id,
        verifyingContract: USDC_ARBITRUM as ViemHex,
      },
      types: PERMIT_TYPES,
      primaryType: 'Permit' as const,
      message: {
        owner: owner.address,
        spender: paymaster as ViemHex,
        value: PAYMASTER_PERMIT_UNITS,
        nonce,
        deadline: maxUint256,
      },
    }
    const signed = await owner.signTypedData(permit)
    const valid = await verifyTypedData({ ...permit, address: owner.address, signature: signed })
    if (!valid) throw new GasUnavailableError('the USDC permit signature does not verify')
    const { signature } = parseErc6492Signature(signed)
    return {
      paymaster: paymaster as ViemHex,
      paymasterData: encodeCirclePaymasterData({
        token: USDC_ARBITRUM,
        value: PAYMASTER_PERMIT_UNITS,
        signature: hex(signature),
      }) as ViemHex,
      paymasterVerificationGasLimit: PAYMASTER_VERIFICATION_GAS,
      paymasterPostOpGasLimit: PAYMASTER_POSTOP_GAS,
      isFinal: true as const,
    }
  }

  return {
    /**
     * Confirm the wallet can delegate.
     *
     * The delegation itself rides on the first user operation, which is
     * what lets a wallet with no ETH pay for it. Doing it here would be a
     * transaction the wallet cannot afford. Calling this twice is safe:
     * a wallet that already points at the delegate is left alone.
     */
    async prepare(wallet: EvmAddress) {
      const { delegate } = requireConfig()
      requireWallet(wallet)
      const code = await publicClient.getCode({ address: wallet as ViemHex })
      if (isDelegatedTo(code, delegate)) {
        logger.info('session wallet already delegated', {})
        return { delegationTx: null, permitTx: null }
      }
      if (!isEmptyCode(code)) {
        throw new GasUnavailableError(
          'the session wallet is delegated to a different contract, so it cannot pay gas through this paymaster',
        )
      }
      logger.info('delegation will ride on the first user operation', {})
      return { delegationTx: null, permitTx: null }
    },

    async send(wallet: EvmAddress, to: EvmAddress, data: Hex, value?: bigint): Promise<Hex> {
      const config = requireConfig()
      const owner = requireWallet(wallet)
      const code = await publicClient.getCode({ address: wallet as ViemHex })
      if (!isEmptyCode(code) && !isDelegatedTo(code, config.delegate)) {
        throw new GasUnavailableError(
          'the session wallet is delegated to a different contract, so it cannot pay gas through this paymaster',
        )
      }

      let callData = data
      if (to.toLowerCase() === USDC_ARBITRUM.toLowerCase()) {
        const decoded = decodeTransfer(data)
        if (decoded) {
          const balance = await publicClient.readContract({
            address: USDC_ARBITRUM as ViemHex,
            abi: ERC20,
            functionName: 'balanceOf',
            args: [wallet as ViemHex],
          })
          const reserve = await quoteReserve(wallet, to, data)
          const units = unitsAfterGasReserve(balance, decoded.units, reserve)
          if (units !== decoded.units) {
            callData = usdcTransfer(decoded.to, units)
            logger.info('held USDC back so the paymaster can collect gas', {})
          }
        }
      } else {
        const balance = await publicClient.readContract({
          address: USDC_ARBITRUM as ViemHex,
          abi: ERC20,
          functionName: 'balanceOf',
          args: [wallet as ViemHex],
        })
        if (balance < GAS_RESERVE_UNITS) {
          throw new GasUnavailableError('the session wallet does not hold enough USDC to pay the paymaster')
        }
      }

      const authorization = isDelegatedTo(code, config.delegate)
        ? undefined
        : await owner.signAuthorization({
            contractAddress: config.delegate as ViemHex,
            chainId: arbitrum.id,
            nonce: await publicClient.getTransactionCount({
              address: wallet as ViemHex,
              blockTag: 'pending',
            }),
          })

      const account = await toSimple7702SmartAccount({
        client: publicClient,
        owner,
        implementation: config.delegate as ViemHex,
      })
      const bundlerClient = createBundlerClient({
        account,
        client: publicClient,
        chain: arbitrum,
        paymaster: {
          getPaymasterData: circlePaymasterFields,
          getPaymasterStubData: circlePaymasterFields,
        },
        transport: rpcOver({ network: options.network, rpcUrl: config.bundlerUrl }),
        userOperation: {
          estimateFeesPerGas: async () => {
            const quoted = await bundler<{
              standard?: { maxFeePerGas?: unknown; maxPriorityFeePerGas?: unknown }
            }>('pimlico_getUserOperationGasPrice', []).catch(() => null)
            const standard = quoted?.standard
            if (standard?.maxFeePerGas !== undefined && standard.maxPriorityFeePerGas !== undefined) {
              return {
                maxFeePerGas: rpcQuantity(standard.maxFeePerGas),
                maxPriorityFeePerGas: rpcQuantity(standard.maxPriorityFeePerGas),
              }
            }
            const price = await publicClient.getGasPrice()
            return { maxFeePerGas: price, maxPriorityFeePerGas: price }
          },
        },
      })

      let userOpHash: ViemHex
      try {
        userOpHash = await bundlerClient.sendUserOperation({
          calls: [
            {
              to: to as ViemHex,
              data: callData as ViemHex,
              value: value ?? 0n,
            },
          ],
          ...(authorization ? { authorization } : {}),
        })
      } catch (error) {
        throw new GasUnavailableError(
          `the bundler refused the user operation: ${error instanceof Error ? error.message : error}`,
        )
      }

      try {
        const receipt = await bundlerClient.waitForUserOperationReceipt({
          hash: userOpHash,
          timeout: 90_000,
        })
        const mined = receipt.receipt?.transactionHash
        if (!receipt.success || !mined) {
          throw new GasUnavailableError(
            `the user operation reverted${receipt.reason ? `: ${receipt.reason}` : ''}`,
          )
        }
        logger.info('gas paid in usdc', {})
        return hex(mined)
      } catch (error) {
        if (error instanceof GasUnavailableError) throw error
        // The bundler accepted it. Returning the hash confirms the attempt,
        // so a retry cannot send the same USDC twice while the receipt is late.
        logger.warn('user operation submitted, receipt not in yet', {})
        return hex(userOpHash)
      }
    },

    /**
     * What a call of this shape costs, in USDC, including Circle's ten per
     * cent. Rounded up, because a gas estimate that is short leaves the
     * session stuck with an operation it cannot pay for.
     */
    async estimate(wallet: EvmAddress, to: EvmAddress, data: Hex): Promise<Amount> {
      requireWallet(wallet)
      const gas = await publicClient.estimateGas({
        account: wallet as ViemHex,
        to: to as ViemHex,
        data: data as ViemHex,
      })
      const price = await publicClient.getGasPrice()
      const feed = await publicClient.readContract({
        address: ETH_USD_ARBITRUM as ViemHex,
        abi: PRICE_FEED,
        functionName: 'latestAnswer',
      })
      const weiCost = (gas + PAYMASTER_VERIFICATION_GAS + PAYMASTER_POSTOP_GAS) * price * 2n
      return withSurcharge(amount('USDC', weiToUsdc(weiCost, feed)))
    },
  }

  /** USDC to leave behind. A failed quote falls back to the fixed reserve. */
  async function quoteReserve(wallet: EvmAddress, to: EvmAddress, data: Hex): Promise<bigint> {
    try {
      const quote = await publicClient.estimateGas({
        account: wallet as ViemHex,
        to: to as ViemHex,
        data: data as ViemHex,
      })
      const price = await publicClient.getGasPrice()
      const feed = await publicClient.readContract({
        address: ETH_USD_ARBITRUM as ViemHex,
        abi: PRICE_FEED,
        functionName: 'latestAnswer',
      })
      const weiCost = (quote + PAYMASTER_VERIFICATION_GAS + PAYMASTER_POSTOP_GAS) * price * 2n
      const units = withSurcharge(amount('USDC', weiToUsdc(weiCost, feed))).units
      if (units > PAYMASTER_PERMIT_UNITS) {
        throw new GasUnavailableError(
          'gas would cost more USDC than the paymaster permit allows',
        )
      }
      return units > GAS_RESERVE_UNITS ? units : GAS_RESERVE_UNITS
    } catch (error) {
      if (error instanceof GasUnavailableError) throw error
      return GAS_RESERVE_UNITS
    }
  }
}

/* ------------------------------------------------------- the ETH fallback */

export interface EthGasOptions {
  readonly network: NetworkAdapter
  readonly logger: Logger
  readonly account: Account
  readonly rpcUrl: string
}

/**
 * Strategy A: hold a little ETH and pay the ordinary way.
 *
 * One more hop than the paymaster, and that hop is visible on-chain, so this
 * is the fallback rather than the default. It is the path used when the
 * paymaster is not configured.
 */
export function createEthGas(options: EthGasOptions): GasAdapter {
  // Through the network adapter, like every other read. The fallback is the
  // simpler path, not the one that gets to leak the wallet's address.
  const transport = rpcOver(options)
  const publicClient = createPublicClient({ chain: arbitrum, transport })
  const walletClient = createWalletClient({
    account: options.account,
    chain: arbitrum,
    transport,
  })

  return {
    /** Nothing to set up, but the wallet does need ETH, so check and say. */
    async prepare(wallet: EvmAddress) {
      const balance = await publicClient.getBalance({ address: wallet as ViemHex })
      if (balance === 0n) {
        throw new GasUnavailableError(
          'this strategy pays gas in ETH and the session wallet holds none. Swap a little ' +
            'for ETH first, or configure the paymaster.',
        )
      }
      options.logger.info('eth gas available', {})
      return { delegationTx: null, permitTx: null }
    },

    async send(wallet: EvmAddress, to: EvmAddress, data: Hex, value?: bigint): Promise<Hex> {
      void wallet
      const txHash = await walletClient.sendTransaction({
        to: to as ViemHex,
        data: data as ViemHex,
        ...(value !== undefined ? { value } : {}),
      })
      options.logger.info('gas paid in eth', {})
      return hex(txHash)
    },

    async estimate(wallet: EvmAddress, to: EvmAddress, data: Hex): Promise<Amount> {
      const gas = await publicClient.estimateGas({
        account: wallet as ViemHex,
        to: to as ViemHex,
        data: data as ViemHex,
      })
      const price = await publicClient.getGasPrice()
      // ETH, not USDC. The caller knows which strategy it asked for.
      return amount('ETH', gas * price)
    },
  }
}

/** Add Circle's surcharge to a gas figure, rounding up. */
export function withSurcharge(value: Amount): Amount {
  return amount(
    value.asset,
    (value.units * BigInt(10_000 + PAYMASTER_SURCHARGE_BPS) + 9_999n) / 10_000n,
  )
}

/** A USDC transfer, which is what the exit leg actually sends. */
export function usdcTransfer(to: EvmAddress, units: bigint): Hex {
  return hex(
    encodeFunctionData({
      abi: ERC20,
      functionName: 'transfer',
      args: [to as ViemHex, units],
    }),
  )
}
