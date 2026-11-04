/**
 * Receipts for payments this app actually made.
 *
 * A transaction id is the only evidence a shielded payment happened — the
 * amount, the sender and the recipient are all encrypted, so there is
 * nothing else to point at. Losing it on a page reload loses the evidence,
 * which is why this is written to disk the instant the wallet returns it
 * rather than kept in React state.
 *
 * It lives in its own database rather than beside the sessions. The session
 * store's schema is created in one unguarded `upgrade`, so adding a store to
 * it means a version bump and a migration, and getting that wrong costs
 * someone their vault. A receipt is not session state and does not need to
 * share a transaction with one.
 *
 * Nothing here is secret. A txid is public the moment it is broadcast, and
 * everything else recorded is what this device already typed.
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { ZcashNetwork } from './types'

const DB_NAME = 'coldtrail-receipts'
const DB_VERSION = 1

export interface Receipt {
  /** 64 lowercase hex characters. The evidence. */
  readonly txid: string
  readonly to: string
  /** A decimal string, as it was handed to the wallet. Never a float. */
  readonly amount: string
  readonly memo?: string
  readonly network: ZcashNetwork
  /** When this device saw the wallet return the id, in epoch milliseconds. */
  readonly sentAt: number
  /**
   * When it was first seen in a block.
   *
   * Absent until then, and that absence is meaningful: a broadcast is not a
   * payment. A transaction can sit in the mempool, or never be mined at all.
   */
  readonly minedAt?: number
}

interface Schema extends DBSchema {
  receipts: { key: string; value: Receipt }
}

export type ReceiptDatabase = IDBPDatabase<Schema>

export async function openReceipts(name: string = DB_NAME): Promise<ReceiptDatabase> {
  return openDB<Schema>(name, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains('receipts')) {
        db.createObjectStore('receipts', { keyPath: 'txid' })
      }
    },
  })
}

export interface ReceiptStore {
  save(receipt: Receipt): Promise<void>
  /** Newest first, because that is the one someone just made. */
  list(): Promise<readonly Receipt[]>
  get(txid: string): Promise<Receipt | undefined>
  /** Record that a transaction has been seen in a block. */
  markMined(txid: string, at: number): Promise<void>
}

export function createReceiptStore(db: ReceiptDatabase): ReceiptStore {
  return {
    async save(receipt) {
      await db.put('receipts', receipt)
    },
    async get(txid) {
      return db.get('receipts', txid)
    },
    async list() {
      const all = await db.getAll('receipts')
      return [...all].sort((a, b) => b.sentAt - a.sentAt)
    },
    async markMined(txid, at) {
      const found = await db.get('receipts', txid)
      // A receipt that is not there is not an error worth throwing over: the
      // transaction is still mined, this device simply has no record of
      // sending it. Inventing one would be worse than noticing nothing.
      if (!found) return
      // Kept at the first sighting. Re-confirming later must not move the
      // time it landed.
      if (found.minedAt !== undefined) return
      await db.put('receipts', { ...found, minedAt: at })
    },
  }
}
