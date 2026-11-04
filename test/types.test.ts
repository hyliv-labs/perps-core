import { describe, expect, it } from 'vitest'
import { addAmount, bps, formatAmount, parseAmount, subAmount } from '@/core/types'

describe('amounts', () => {
  it('parses to the asset’s smallest unit', () => {
    expect(parseAmount('USDC', '12.5').units).toBe(12_500_000n)
    expect(parseAmount('ZEC', '0.00000001').units).toBe(1n)
    expect(parseAmount('ZEC', '10').units).toBe(10_00000000n)
  })

  it('round-trips through format without drift', () => {
    for (const value of ['0', '1', '0.1', '1234.56789', '0.00000001']) {
      expect(formatAmount(parseAmount('ZEC', value))).toBe(value)
    }
  })

  it('rejects more precision than the asset has', () => {
    expect(() => parseAmount('USDC', '1.1234567')).toThrow()
  })

  it('refuses to mix assets', () => {
    expect(() => addAmount(parseAmount('ZEC', '1'), parseAmount('USDC', '1'))).toThrow()
    expect(() => subAmount(parseAmount('ZEC', '1'), parseAmount('USDC', '1'))).toThrow()
  })

  it('rounds fees up so they are never understated', () => {
    // 0.20% of 1 unit is 0.002 units, which must not round to zero.
    expect(bps(parseAmount('USDC', '0.000001'), 20).units).toBe(1n)
    expect(bps(parseAmount('USDC', '1000'), 20).units).toBe(2_000_000n)
  })
})
