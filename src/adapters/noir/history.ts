/**
 * Reading the wallet's transaction history, without having been told its shape.
 *
 * `getTransactionHistory()` is documented as "read local and on-chain
 * history" and nothing anywhere — the SDK repository, the provider API
 * reference — says what it returns. That leaves two ways to proceed, and
 * only one of them is honest.
 *
 * The dishonest one is to guess field names. That is exactly how this
 * codebase ended up probing `window.noir` for a `getNewAddress` method that
 * never existed, and the guess sat there looking like knowledge until it was
 * checked.
 *
 * So nothing here matches on a name it hopes is right. It matches
 * structurally: the container is whichever array is present, an entry is
 * ours when some field in it *equals the transaction id we already hold*,
 * and confirmation is only read from fields that both look like
 * confirmation and carry a positive value.
 *
 * The result is four states rather than two, and the extra two are the
 * point:
 *
 *  - `mined`      — found, with positive evidence it is in a block.
 *  - `seen`       — found, but nothing readable says it was mined. NOT mined.
 *  - `absent`     — the history was read and this id is not in it.
 *  - `unreadable` — the history could not be understood at all.
 *
 * `seen` and `unreadable` both mean "do not claim this was paid". A reader
 * that collapsed them into "not mined yet" would be guessing in the
 * direction that looks tidier, and the whole reason this file is careful is
 * that a transaction id is the only evidence a shielded payment leaves.
 */

import { isTxid } from './index'

export type TxStatus = 'mined' | 'seen' | 'absent' | 'unreadable'

/** A plain object, as opposed to an array, a null, or a primitive. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The list of entries inside whatever the wallet returned.
 *
 * Either the response is the array, or it is an object holding exactly one
 * array. "Exactly one" is doing real work: with two candidates there is no
 * structural reason to prefer either, and picking one would be the guess
 * this file exists to avoid.
 */
export function entriesOf(history: unknown): readonly unknown[] | undefined {
  if (Array.isArray(history)) return history
  if (!isRecord(history)) return undefined
  const arrays = Object.values(history).filter(Array.isArray)
  return arrays.length === 1 ? (arrays[0] as readonly unknown[]) : undefined
}

/** Whether this entry carries the id we are looking for, in any field. */
function mentions(entry: unknown, txid: string): boolean {
  if (!isRecord(entry)) return false
  const wanted = txid.trim().toLowerCase()
  return Object.values(entry).some(
    (v) => typeof v === 'string' && v.trim().toLowerCase() === wanted,
  )
}

/**
 * Positive evidence that an entry is in a block.
 *
 * Every rule here requires a *value* that means confirmed, not merely a
 * field whose name sounds like it. A height of zero, a confirmation count
 * of zero and a status of "pending" are all absence of evidence, and are
 * read as such.
 */
function looksMined(entry: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(entry)) {
    const name = key.toLowerCase()
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      if (name.includes('height') || name.includes('confirm')) return true
    }
    if (typeof value === 'boolean' && value) {
      if (name.includes('mined') || name.includes('confirmed')) return true
    }
    if (typeof value === 'string') {
      const said = value.trim().toLowerCase()
      if (said === 'mined' || said === 'confirmed') return true
    }
  }
  return false
}

/**
 * Where a transaction stands, according to a history of unknown shape.
 *
 * Never returns `mined` on a guess: an entry that was found but cannot be
 * shown to be in a block comes back as `seen`.
 */
export function statusOf(history: unknown, txid: string): TxStatus {
  if (!isTxid(txid)) return 'unreadable'
  const entries = entriesOf(history)
  if (entries === undefined) return 'unreadable'
  const found = entries.find((e) => mentions(e, txid))
  if (found === undefined) return 'absent'
  return isRecord(found) && looksMined(found) ? 'mined' : 'seen'
}

/**
 * A sentence for a log or a screen, so an unreadable history is noticed
 * rather than quietly treated as "nothing has happened yet".
 */
export function describeStatus(status: TxStatus): string {
  switch (status) {
    case 'mined':
      return 'seen in a block'
    case 'seen':
      return 'in the wallet’s history, but nothing there says it is mined yet'
    case 'absent':
      return 'broadcast, and not in the wallet’s history yet'
    case 'unreadable':
      return 'broadcast — the wallet’s history could not be read, so this is unconfirmed here'
  }
}
