/**
 * Core value types.
 *
 * All on-chain amounts are integers in an asset's smallest unit, held as
 * bigint. Floating point never touches a balance: a rounding error here is
 * lost user money, and USDC/ZEC differ in decimals (6 vs 8).
 */

export type Brand<T, B extends string> = T & { readonly __brand: B }

/** Hex-encoded, 0x-prefixed. */
export type Hex = Brand<string, 'Hex'>
/** An EVM address, checksummed or lowercase, 0x-prefixed. */
export type EvmAddress = Brand<string, 'EvmAddress'>
/** A Zcash shielded (unified or orchard) address. Never a transparent one. */
export type ShieldedAddress = Brand<string, 'ShieldedAddress'>
/**
 * Which Zcash network an address or a deployment belongs to.
 *
 * Carried explicitly rather than inferred, because the two are
 * indistinguishable to everything downstream once an address is a string:
 * a testnet address accepted by a mainnet deployment sends real ZEC nowhere
 * recoverable, and the mistake looks exactly like success until it does not.
 */
export type ZcashNetwork = 'main' | 'test'
/** Identifier of one trading session, stable across reloads. */
export type SessionId = Brand<string, 'SessionId'>
/** Deduplication key for an externally visible side effect. */
export type IdempotencyKey = Brand<string, 'IdempotencyKey'>

export function hex(value: string): Hex {
  if (!/^0x[0-9a-fA-F]*$/.test(value)) throw new TypeError('not hex')
  return value as Hex
}

export function evmAddress(value: string): EvmAddress {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new TypeError('not an EVM address')
  return value as EvmAddress
}

export const ASSETS = {
  ZEC: { symbol: 'ZEC', decimals: 8, chain: 'zcash' },
  USDC: { symbol: 'USDC', decimals: 6, chain: 'arbitrum' },
  ETH: { symbol: 'ETH', decimals: 18, chain: 'arbitrum' },
} as const

export type AssetSymbol = keyof typeof ASSETS

/** An amount of one asset, in that asset's smallest unit. */
export interface Amount {
  readonly asset: AssetSymbol
  readonly units: bigint
}

export function amount(asset: AssetSymbol, units: bigint): Amount {
  if (units < 0n) throw new RangeError('amount cannot be negative')
  return { asset, units }
}

/** Parse a human decimal string ("12.5") into smallest units. Exact, no floats. */
export function parseAmount(asset: AssetSymbol, decimal: string): Amount {
  const { decimals } = ASSETS[asset]
  const match = /^(\d+)(?:\.(\d*))?$/.exec(decimal.trim())
  if (!match) throw new TypeError(`cannot parse amount: ${decimal}`)
  const whole = match[1] ?? '0'
  const frac = (match[2] ?? '').padEnd(decimals, '0')
  if (frac.length > decimals) {
    throw new RangeError(`${asset} has ${decimals} decimals, got ${frac.length}`)
  }
  return amount(asset, BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac || '0'))
}

/** Render smallest units as a human decimal string. Truncates nothing. */
export function formatAmount({ asset, units }: Amount): string {
  const { decimals } = ASSETS[asset]
  const base = 10n ** BigInt(decimals)
  const whole = units / base
  const frac = (units % base).toString().padStart(decimals, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : `${whole}`
}

export function addAmount(a: Amount, b: Amount): Amount {
  if (a.asset !== b.asset) throw new TypeError('cannot add different assets')
  return amount(a.asset, a.units + b.units)
}

export function subAmount(a: Amount, b: Amount): Amount {
  if (a.asset !== b.asset) throw new TypeError('cannot subtract different assets')
  return amount(a.asset, a.units - b.units)
}

/** Basis points of an amount, rounded up so fees are never understated. */
export function bps(a: Amount, basisPoints: number): Amount {
  const n = BigInt(Math.round(basisPoints))
  return amount(a.asset, (a.units * n + 9_999n) / 10_000n)
}

/** A result type for operations that fail in expected, named ways. */
export type Result<T, E = Error> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E }

export const Ok = <T>(value: T): Result<T, never> => ({ ok: true, value })
export const Err = <E>(error: E): Result<never, E> => ({ ok: false, error })
