import { describe, expect, it } from 'vitest'
import { createReceiptStore, openReceipts } from '@/core/receipts'
import { explorerUrl } from '@/ui/pay/PayPanel'

/**
 * Keeping the evidence.
 *
 * A shielded payment encrypts the amount and both parties, so the
 * transaction id is the only thing that can be shown to anyone else. These
 * tests are about not losing it, and about not overwriting what it says.
 */

const TXID = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)

async function store(name: string) {
  return createReceiptStore(await openReceipts(name))
}

describe('receipts', () => {
  it('survives the page being closed between sending and looking', async () => {
    const first = await store('receipts-reload')
    await first.save({
      txid: TXID,
      to: `utest1${'q'.repeat(40)}`,
      amount: '0.001',
      network: 'test',
      sentAt: 1,
    })

    // A second handle on the same database is what a reload looks like.
    const second = await store('receipts-reload')
    expect((await second.get(TXID))?.amount).toBe('0.001')
  })

  it('lists the newest first, which is the one just made', async () => {
    const s = await store('receipts-order')
    await s.save({ txid: TXID, to: 'a', amount: '1', network: 'test', sentAt: 10 })
    await s.save({ txid: OTHER, to: 'b', amount: '2', network: 'test', sentAt: 20 })
    expect((await s.list()).map((r) => r.txid)).toEqual([OTHER, TXID])
  })

  it('records a mining time once and does not move it', async () => {
    // Re-confirming a transaction later must not restate when it landed.
    const s = await store('receipts-mined')
    await s.save({ txid: TXID, to: 'a', amount: '1', network: 'test', sentAt: 1 })
    await s.markMined(TXID, 100)
    await s.markMined(TXID, 200)
    expect((await s.get(TXID))?.minedAt).toBe(100)
  })

  it('leaves broadcast and mined distinguishable', async () => {
    // Broadcast is not payment: a transaction can sit in the mempool or
    // never be mined, and a receipt that could not tell the difference would
    // be claiming more than it knows.
    const s = await store('receipts-broadcast')
    await s.save({ txid: TXID, to: 'a', amount: '1', network: 'test', sentAt: 1 })
    expect((await s.get(TXID))?.minedAt).toBeUndefined()
  })

  it('ignores a mining report for a transaction it never sent', async () => {
    const s = await store('receipts-unknown')
    await expect(s.markMined(OTHER, 5)).resolves.toBeUndefined()
    expect(await s.get(OTHER)).toBeUndefined()
  })
})

describe('explorer links', () => {
  it('points at the network the transaction was made on', () => {
    // Not at the network the app happens to be on now: a receipt carries its
    // own network precisely so an old one still resolves.
    expect(explorerUrl(TXID, 'test')).toBe(`https://testnet.zcashexplorer.app/transactions/${TXID}`)
    expect(explorerUrl(TXID, 'main')).toBe(`https://mainnet.zcashexplorer.app/transactions/${TXID}`)
  })
})
