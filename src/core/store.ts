/**
 * Persistence.
 *
 * Every transition is written before the next side effect is attempted. The
 * ordering matters: if we send a transaction and crash before recording it,
 * a resume would send it twice. So the journal entry is written first, with
 * the idempotency key and no handle, and only then is the effect performed.
 * A crash between the two leaves a recorded key marked unconfirmed, which
 * the orchestrator reconciles against the outside world rather than
 * blindly retrying.
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { Session, SessionId } from './session'
import type { LinkabilityLedger } from './checker'
import type { VaultRecord } from './keys'

const DB_NAME = 'coldtrail'
const DB_VERSION = 1

interface Schema extends DBSchema {
  sessions: { key: string; value: Session; indexes: { by_state: string } }
  vault: { key: string; value: VaultRecord }
  ledger: {
    key: string
    value: {
      id: 'ledger'
      /** Each entry maps the claimed thing to the session that claimed it. */
      keyIndices: [number, string][]
      exitAddresses: [string, string][]
      sessionWallets: [string, string][]
    }
  }
}

export type Database = IDBPDatabase<Schema>

/** `name` is overridable so tests can get an isolated database each run. */
export async function openDatabase(name: string = DB_NAME): Promise<Database> {
  return openDB<Schema>(name, DB_VERSION, {
    upgrade(db) {
      const sessions = db.createObjectStore('sessions', { keyPath: 'id' })
      sessions.createIndex('by_state', 'state')
      db.createObjectStore('vault')
      db.createObjectStore('ledger', { keyPath: 'id' })
    },
  })
}

export class StaleWriteError extends Error {
  override readonly name = 'StaleWriteError'
  constructor(id: string, expected: number, found: number) {
    super(`session ${id}: expected revision ${expected}, found ${found}`)
  }
}

export interface SessionStore {
  get(id: SessionId): Promise<Session | undefined>
  /** All sessions that have not reached a terminal state. */
  open(): Promise<readonly Session[]>
  all(): Promise<readonly Session[]>
  /** Writes only if the stored revision is the one this session came from. */
  save(session: Session): Promise<void>
  ledger(): Promise<LinkabilityLedger>
  /** Claim identifiers for `sessionId`. Re-claiming by the same session is a no-op. */
  recordUse(
    sessionId: string,
    entry: { keyIndex?: number; exitAddress?: string; sessionWallet?: string },
  ): Promise<void>
  vault(): Promise<VaultRecord | undefined>
  saveVault(record: VaultRecord): Promise<void>
}

export function createSessionStore(db: Database): SessionStore {
  return {
    async get(id) {
      return db.get('sessions', id)
    },
    async all() {
      return db.getAll('sessions')
    },
    async open() {
      const all = await db.getAll('sessions')
      return all.filter((s) => s.state !== 'closed' && s.state !== 'failed')
    },
    async save(session) {
      const tx = db.transaction('sessions', 'readwrite')
      const existing = await tx.store.get(session.id)
      // revision - 1 is what the caller read; anything else means another tab
      // advanced this session while we held it.
      if (existing && existing.revision >= session.revision) {
        await tx.done
        throw new StaleWriteError(session.id, session.revision - 1, existing.revision)
      }
      await tx.store.put(session)
      await tx.done
    },
    async ledger() {
      const row = await db.get('ledger', 'ledger')
      return {
        usedKeyIndices: new Map(row?.keyIndices ?? []),
        usedExitAddresses: new Map(row?.exitAddresses ?? []),
        usedSessionWallets: new Map(row?.sessionWallets ?? []),
      }
    },
    async recordUse(sessionId, entry) {
      const tx = db.transaction('ledger', 'readwrite')
      const row = (await tx.store.get('ledger')) ?? {
        id: 'ledger' as const,
        keyIndices: [] as [number, string][],
        exitAddresses: [] as [string, string][],
        sessionWallets: [] as [string, string][],
      }
      const keys = new Map(row.keyIndices)
      const exits = new Map(row.exitAddresses)
      const wallets = new Map(row.sessionWallets)
      // A claim is never reassigned: the first session to take an identifier
      // owns it, so a later session sees it as used and is blocked.
      if (entry.keyIndex !== undefined && !keys.has(entry.keyIndex)) {
        keys.set(entry.keyIndex, sessionId)
      }
      if (entry.exitAddress && !exits.has(entry.exitAddress)) {
        exits.set(entry.exitAddress, sessionId)
      }
      if (entry.sessionWallet) {
        const w = entry.sessionWallet.toLowerCase()
        if (!wallets.has(w)) wallets.set(w, sessionId)
      }
      await tx.store.put({
        id: 'ledger',
        keyIndices: [...keys],
        exitAddresses: [...exits],
        sessionWallets: [...wallets],
      })
      await tx.done
    },
    async vault() {
      return db.get('vault', 'master')
    },
    async saveVault(record) {
      await db.put('vault', record, 'master')
    },
  }
}

/** In-memory store for tests and spikes. Same contract, no IndexedDB. */
export function createMemoryStore(): SessionStore {
  const sessions = new Map<string, Session>()
  const used = {
    keyIndices: new Map<number, string>(),
    exits: new Map<string, string>(),
    wallets: new Map<string, string>(),
  }
  let vaultRecord: VaultRecord | undefined

  return {
    async get(id) {
      return sessions.get(id)
    },
    async all() {
      return [...sessions.values()]
    },
    async open() {
      return [...sessions.values()].filter((s) => s.state !== 'closed' && s.state !== 'failed')
    },
    async save(session) {
      const existing = sessions.get(session.id)
      if (existing && existing.revision >= session.revision) {
        throw new StaleWriteError(session.id, session.revision - 1, existing.revision)
      }
      sessions.set(session.id, session)
    },
    async ledger() {
      return {
        usedKeyIndices: new Map(used.keyIndices),
        usedExitAddresses: new Map(used.exits),
        usedSessionWallets: new Map(used.wallets),
      }
    },
    async recordUse(sessionId, entry) {
      if (entry.keyIndex !== undefined && !used.keyIndices.has(entry.keyIndex)) {
        used.keyIndices.set(entry.keyIndex, sessionId)
      }
      if (entry.exitAddress && !used.exits.has(entry.exitAddress)) {
        used.exits.set(entry.exitAddress, sessionId)
      }
      if (entry.sessionWallet) {
        const w = entry.sessionWallet.toLowerCase()
        if (!used.wallets.has(w)) used.wallets.set(w, sessionId)
      }
    },
    async vault() {
      return vaultRecord
    },
    async saveVault(record) {
      vaultRecord = record
    },
  }
}
