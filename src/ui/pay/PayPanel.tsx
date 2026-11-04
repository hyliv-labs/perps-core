/**
 * Send a shielded payment, and keep the evidence.
 *
 * This is the smallest honest thing the product can do end to end: connect
 * a wallet, send shielded ZEC, and come away with a transaction id that
 * someone else can check. It does not go through the session machine, and
 * deliberately so — on testnet the capability report refuses to start a
 * session, because 1Click and Lighter are mainnet and there is nothing on
 * the far side of the swap. A screen that depended on Start would therefore
 * have nothing to show on the only network where this can be demonstrated.
 *
 * Three things it is careful about, all of them learned rather than assumed:
 *
 *  - `connect()` needs a user gesture, so it hangs off a button and never a
 *    render.
 *  - A dApp cannot ask which network the wallet is on. The prefix of the
 *    address it hands back is the only evidence, so that is checked before
 *    anything is offered to send.
 *  - A returned txid means broadcast, not payment. It is recorded and shown
 *    as "broadcast" until it has actually been seen in a block.
 */

import { useCallback, useEffect, useState } from 'react'
import {
  MEMO_MAX_BYTES,
  createNoirExtensionAdapter,
  isShieldedAddress,
  memoByteLength,
  shieldedNetwork,
} from '@/adapters/noir'
import { describeStatus, statusOf, type TxStatus } from '@/adapters/noir/history'
import { createReceiptStore, openReceipts, type Receipt, type ReceiptStore } from '@/core/receipts'
import { createLogger, consoleSink } from '@/core/log'
import { parseAmount, type ZcashNetwork } from '@/core/types'

/**
 * How often to ask the wallet whether a broadcast transaction has landed.
 *
 * Zcash blocks are about seventy-five seconds apart, so polling faster than
 * this learns nothing and only burns the wallet's sync budget.
 */
const POLL_MS = 20_000

/** Where a transaction can be looked up, by network. */
export function explorerUrl(txid: string, network: ZcashNetwork): string {
  const host = network === 'test' ? 'testnet.zcashexplorer.app' : 'mainnet.zcashexplorer.app'
  return `https://${host}/transactions/${txid}`
}

function wording(network: ZcashNetwork): string {
  return network === 'test' ? 'testnet' : 'mainnet'
}

type Stage = 'idle' | 'connecting' | 'ready' | 'sending'

export function PayPanel({ network }: { network: ZcashNetwork }) {
  const [store, setStore] = useState<ReceiptStore | null>(null)
  const [receipts, setReceipts] = useState<readonly Receipt[]>([])
  const [from, setFrom] = useState<string | null>(null)
  const [stage, setStage] = useState<Stage>('idle')
  const [error, setError] = useState<string | null>(null)

  const [to, setTo] = useState('')
  const [amount, setAmount] = useState('')
  const [memo, setMemo] = useState('')
  /** What the last poll could tell about each broadcast transaction. */
  const [statuses, setStatuses] = useState<Readonly<Record<string, TxStatus>>>({})

  const logger = createLogger(consoleSink)
  const noir = createNoirExtensionAdapter(logger, network)

  useEffect(() => {
    let alive = true
    void openReceipts().then(async (db) => {
      if (!alive) return
      const made = createReceiptStore(db)
      setStore(made)
      setReceipts(await made.list())
    })
    return () => {
      alive = false
    }
  }, [])

  /*
   * Restore an existing connection without asking again.
   *
   * `getAccounts()` is documented as needing no approval and returning null
   * when the site is not connected, so this is not a connection attempt
   * wearing a disguise — it reads a permission already granted. Without it a
   * reload shows "Connect Noir Wallet" to someone who connected a minute
   * ago, and the receipts below it stop being polled.
   */
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const already = await noir.connectedAddress?.()
        if (!already || !alive) return
        setFrom(already)
        setStage('ready')
      } catch {
        // Not connected, or a wallet on the other network. Either way the
        // button is the right thing to show, and it will say why when it is
        // pressed.
      }
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [network])

  /*
   * Turn broadcasts into confirmations, or say that it could not be done.
   *
   * Only `mined` is written to the receipt, because only `mined` is
   * evidence. `seen` and `unreadable` are shown on screen and left out of
   * the record: a receipt that said "mined" because the history was
   * unparseable would be inventing the one thing this screen exists to
   * produce honestly.
   */
  useEffect(() => {
    if (!store || from === null) return
    const pending = receipts.filter((r) => r.minedAt === undefined)
    if (pending.length === 0) return

    let alive = true
    const poll = async () => {
      let history: unknown
      try {
        history = await noir.history?.()
      } catch {
        // A wallet that will not answer is not a transaction that failed.
        if (alive) {
          setStatuses((prev) => ({
            ...prev,
            ...Object.fromEntries(pending.map((r) => [r.txid, 'unreadable' as TxStatus])),
          }))
        }
        return
      }
      if (!alive) return
      const seen: Record<string, TxStatus> = {}
      let landed = false
      for (const r of pending) {
        const status = statusOf(history, r.txid)
        seen[r.txid] = status
        if (status === 'mined') {
          await store.markMined(r.txid, Date.now())
          landed = true
        }
      }
      if (!alive) return
      setStatuses((prev) => ({ ...prev, ...seen }))
      if (landed) setReceipts(await store.list())
    }

    void poll()
    const timer = setInterval(() => void poll(), POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [store, from, receipts, noir])

  const connect = useCallback(async () => {
    setStage('connecting')
    setError(null)
    try {
      await noir.connect()
      // This both reads the address and enforces the network, because
      // `freshReceiveAddress` refuses one from the other chain.
      setFrom(await noir.freshReceiveAddress())
      setStage('ready')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setStage('idle')
    }
  }, [noir])

  const send = useCallback(async () => {
    if (!store) return
    setStage('sending')
    setError(null)
    try {
      const value = parseAmount('ZEC', amount.trim())
      const trimmedTo = to.trim()
      if (!isShieldedAddress(trimmedTo, network)) {
        const found = shieldedNetwork(trimmedTo)
        throw new Error(
          found
            ? `That is a ${wording(found)} address and this app is on ${wording(network)}.`
            : `That is not a ${wording(network)} shielded address.`,
        )
      }
      const trimmedMemo = memo.trim()
      const { txid } = await noir.send(trimmedTo, value, trimmedMemo || undefined)
      // Written before anything else is done with it. A reload between the
      // wallet returning and this landing would lose the only evidence the
      // payment happened.
      await store.save({
        txid,
        to: trimmedTo,
        amount: amount.trim(),
        ...(trimmedMemo ? { memo: trimmedMemo } : {}),
        network,
        sentAt: Date.now(),
      })
      setReceipts(await store.list())
      setAmount('')
      setMemo('')
      setStage('ready')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setStage('ready')
    }
  }, [store, noir, to, amount, memo, network])

  const memoBytes = memoByteLength(memo)
  const memoTooLong = memoBytes > MEMO_MAX_BYTES

  return (
    <section className="pay">
      <header className="pay-head">
        <h2>Send shielded ZEC</h2>
        <p className="pay-net">
          This build is on <strong>{wording(network)}</strong>. Addresses begin{' '}
          <code>{network === 'test' ? 'utest1' : 'u1'}</code>.
        </p>
      </header>

      {from === null ? (
        <div className="pay-connect">
          <p>
            Noir Wallet holds the keys; this page never sees them. Connecting asks the extension
            for the account’s shielded address, which is also the only way to tell whether it is
            on {wording(network)}.
          </p>
          <button type="button" onClick={() => void connect()} disabled={stage === 'connecting'}>
            {stage === 'connecting' ? 'Waiting for the wallet…' : 'Connect Noir Wallet'}
          </button>
        </div>
      ) : (
        <>
          <p className="pay-from">
            Sending from <code>{from}</code>
          </p>

          <label className="pay-field">
            <span>To</span>
            <input
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder={network === 'test' ? 'utest1…' : 'u1…'}
              spellCheck={false}
            />
          </label>

          <label className="pay-field">
            <span>Amount, in ZEC</span>
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.001"
              inputMode="decimal"
            />
          </label>

          <label className="pay-field">
            <span>
              Memo, optional — {memoBytes} of {MEMO_MAX_BYTES} bytes
            </span>
            <input
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              placeholder="Shielded recipients only"
            />
          </label>

          <button
            type="button"
            onClick={() => void send()}
            disabled={stage === 'sending' || !to.trim() || !amount.trim() || memoTooLong}
          >
            {stage === 'sending' ? 'Approve it in the wallet…' : 'Send'}
          </button>
        </>
      )}

      {error ? <p className="error">{error}</p> : null}

      {receipts.length > 0 ? (
        <div className="pay-receipts">
          <h3>Payments this app made</h3>
          <p className="pay-note">
            A transaction id is the only evidence a shielded payment happened — the amount and
            both parties are encrypted. Broadcast is not the same as mined.
          </p>
          <ul>
            {receipts.map((r) => (
              <li key={r.txid}>
                <a href={explorerUrl(r.txid, r.network)} target="_blank" rel="noreferrer">
                  <code>{r.txid}</code>
                </a>
                <span className="pay-meta">
                  {r.amount} ZEC · {wording(r.network)} ·{' '}
                  {r.minedAt !== undefined
                    ? 'seen in a block'
                    : describeStatus(statuses[r.txid] ?? 'absent')}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  )
}
