import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { SessionStore } from '@/core/store'
import {
  type Vault,
  type VaultRecord,
  addLock,
  findPasskeyLock,
  generateRecoveryPhrase,
  hasLock,
  isValidRecoveryPhrase,
  newVaultRecord,
  normalisePhrase,
  openWithPasskey,
  openWithPassphrase,
  openWithPhrase,
  passkeyLock,
  passphraseLock,
} from '@/core/keys'
import {
  PasskeyUnavailableError,
  createPasskey,
  passkeySupported,
  readPasskeySecret,
} from '@/core/passkey'

/**
 * Getting into the vault.
 *
 * Nobody logs in here: there is no server and no account. This screen only
 * produces the key that decrypts a recovery phrase held in this browser.
 *
 * A passkey is the default, because it is hardware-backed and there is
 * nothing to remember. A passphrase is kept as the way in on browsers
 * without the PRF extension, and the recovery phrase itself is the way back
 * when the device is gone.
 */

type Stage =
  | { kind: 'loading' }
  | { kind: 'create' }
  | { kind: 'backup'; phrase: string; record: VaultRecord }
  | { kind: 'unlock'; record: VaultRecord }
  | { kind: 'recover'; returnTo: Extract<Stage, { kind: 'create' | 'unlock' }> }

export function Unlock({
  store,
  onUnlocked,
}: {
  store: SessionStore
  onUnlocked: (vault: Vault) => void
}) {
  const [stage, setStage] = useState<Stage>({ kind: 'loading' })
  const [canPasskey, setCanPasskey] = useState(false)
  const [passphrase, setPassphrase] = useState('')
  const [confirmPhrase, setConfirmPhrase] = useState('')
  const [phraseInput, setPhraseInput] = useState('')
  const [written, setWritten] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    void (async () => {
      const [record, supported] = await Promise.all([store.vault(), passkeySupported()])
      if (!live) return
      setCanPasskey(supported)
      setStage(record ? { kind: 'unlock', record } : { kind: 'create' })
    })()
    return () => {
      live = false
    }
  }, [store])

  const attempt = useCallback(async (what: string, run: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await run()
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught)
      // A cancelled passkey prompt is the person saying no, not a failure.
      setError(/NotAllowed|abort/i.test(message) ? `${what} was cancelled.` : message)
    } finally {
      setBusy(false)
    }
  }, [])

  /* ------------------------------------------------------------- creating */

  const createWithPasskey = () =>
    attempt('Creating the passkey', async () => {
      const phrase = generateRecoveryPhrase()
      const handle = await createPasskey('Private Perps vault')
      const record = newVaultRecord([
        await passkeyLock(phrase, handle.credentialId, handle.secret, 'This device'),
      ])
      handle.secret.fill(0)
      setStage({ kind: 'backup', phrase, record })
    })

  const createWithPassphrase = () =>
    attempt('Creating the vault', async () => {
      if (passphrase.length < 10) throw new Error('Use at least ten characters.')
      if (passphrase !== confirmPhrase) throw new Error('The two passphrases do not match.')
      const phrase = generateRecoveryPhrase()
      const record = newVaultRecord([await passphraseLock(phrase, passphrase)])
      setStage({ kind: 'backup', phrase, record })
    })

  /** Only now is anything written to disk: before the phrase is safe, there
   *  is nothing worth keeping. */
  const finishCreate = (stageNow: Extract<Stage, { kind: 'backup' }>) =>
    attempt('Saving the vault', async () => {
      await store.saveVault(stageNow.record)
      onUnlocked(openWithPhrase(stageNow.phrase))
    })

  /* ------------------------------------------------------------- unlocking */

  const unlockWithPasskey = (record: VaultRecord) =>
    attempt('The passkey', async () => {
      const lock = findPasskeyLock(record)
      if (!lock) throw new PasskeyUnavailableError('this vault has no passkey')
      const handle = await readPasskeySecret(lock.credentialId)
      const vault = await openWithPasskey(record, handle.secret)
      handle.secret.fill(0)
      onUnlocked(vault)
    })

  const unlockWithPassphrase = (record: VaultRecord) =>
    attempt('The passphrase', async () => {
      onUnlocked(await openWithPassphrase(record, passphrase))
    })

  const recover = () =>
    attempt('The recovery phrase', async () => {
      const phrase = normalisePhrase(phraseInput)
      if (!isValidRecoveryPhrase(phrase)) {
        throw new Error('That is not a valid twelve-word recovery phrase.')
      }
      const existing = await store.vault()
      // Re-lock the restored phrase to this device, so the next visit is a
      // passkey tap rather than twelve words again.
      let record = existing ?? newVaultRecord([await passphraseLock(phrase, phrase)])
      if (canPasskey && !hasLock(record, 'passkey')) {
        try {
          const handle = await createPasskey('Private Perps vault')
          record = await addLock(record, await passkeyLock(phrase, handle.credentialId, handle.secret, 'This device'))
          handle.secret.fill(0)
        } catch {
          // Recovery must work even when the passkey will not be made.
        }
      }
      await store.saveVault(record)
      onUnlocked(openWithPhrase(phrase, record.highestIndex))
    })

  /* ----------------------------------------------------------------- views */

  if (stage.kind === 'loading') {
    return (
      <Gate title="Unlock" lead="Looking for a vault on this device.">
        <div className="skeleton-row" />
        <div className="skeleton-row" />
      </Gate>
    )
  }

  if (stage.kind === 'backup') {
    const words = stage.phrase.split(' ')
    return (
      <Gate
        title="Write these twelve words down"
        lead="They are the only way back if you lose this device. They will not be shown again, and nobody else has a copy."
      >
        <ol className="phrase">
          {words.map((word, i) => (
            <li key={`${i}-${word}`}>
              <span>{i + 1}</span>
              {word}
            </li>
          ))}
        </ol>
        <label className="check">
          <input
            type="checkbox"
            checked={written}
            onChange={(e) => setWritten(e.target.checked)}
          />
          I have written them down somewhere safe.
        </label>
        <button
          className="gate-primary"
          disabled={!written || busy}
          onClick={() => void finishCreate(stage)}
        >
          {busy ? 'Saving…' : 'Open the vault'}
        </button>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </Gate>
    )
  }

  if (stage.kind === 'recover') {
    return (
      <Gate
        title="Enter your recovery phrase"
        lead="Twelve words, in the order they were shown. This restores the vault on this browser."
      >
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (!busy && phraseInput.trim().length >= 20) void recover()
          }}
        >
          <div className="field">
            <label htmlFor="phrase">Recovery phrase</label>
            <textarea
              id="phrase"
              rows={3}
              value={phraseInput}
              onChange={(e) => setPhraseInput(e.target.value)}
              placeholder="word word word …"
              autoComplete="off"
              spellCheck={false}
              autoFocus
            />
          </div>
          <button className="gate-primary" type="submit" disabled={busy || phraseInput.trim().length < 20}>
            {busy ? 'Restoring…' : 'Restore'}
          </button>
        </form>
        <button type="button" className="gate-quiet" onClick={() => setStage(stage.returnTo)}>
          Back
        </button>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </Gate>
    )
  }

  if (stage.kind === 'create') {
    return (
      <Gate
        title="Set up this device"
        lead={
          canPasskey
            ? 'A passkey keeps the vault key in this device’s hardware. You unlock with a fingerprint or face.'
            : 'This browser cannot keep a passkey, so the vault opens with a passphrase you choose.'
        }
      >
        {canPasskey ? (
          <>
            <button className="gate-primary" type="button" disabled={busy} onClick={() => void createWithPasskey()}>
              {busy ? 'Waiting for the passkey…' : 'Create with a passkey'}
            </button>
            <details className="fallback">
              <summary>Use a passphrase instead</summary>
              <PassphraseForm
                passphrase={passphrase}
                confirm={confirmPhrase}
                busy={busy}
                submitLabel="Create with a passphrase"
                onPassphrase={setPassphrase}
                onConfirm={setConfirmPhrase}
                onSubmit={() => void createWithPassphrase()}
              />
            </details>
          </>
        ) : (
          <PassphraseForm
            passphrase={passphrase}
            confirm={confirmPhrase}
            busy={busy}
            autoFocus
            submitLabel={busy ? 'Creating…' : 'Create the vault'}
            onPassphrase={setPassphrase}
            onConfirm={setConfirmPhrase}
            onSubmit={() => void createWithPassphrase()}
          />
        )}
        <button
          type="button"
          className="gate-quiet"
          onClick={() => setStage({ kind: 'recover', returnTo: stage })}
        >
          I already have a recovery phrase
        </button>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </Gate>
    )
  }

  const { record } = stage
  const passkeyOnRecord = Boolean(findPasskeyLock(record))
  const passphraseOnRecord = hasLock(record, 'passphrase')
  return (
    <Gate
      title="Unlock"
      lead={
        passkeyOnRecord
          ? 'The vault is on this browser. A passkey opens it without typing, and the key stays in the device.'
          : 'The vault is on this browser. The passphrase decrypts it here. Nothing is sent.'
      }
    >
      {passkeyOnRecord && (
        <button className="gate-primary" type="button" disabled={busy} onClick={() => void unlockWithPasskey(record)}>
          {busy ? 'Waiting for the passkey…' : 'Unlock with your passkey'}
        </button>
      )}
      {passphraseOnRecord &&
        (passkeyOnRecord ? (
          <details className="fallback">
            <summary>Use your passphrase</summary>
            <PassphraseUnlock
              passphrase={passphrase}
              busy={busy}
              onPassphrase={setPassphrase}
              onSubmit={() => void unlockWithPassphrase(record)}
            />
          </details>
        ) : (
          <PassphraseUnlock
            passphrase={passphrase}
            busy={busy}
            onPassphrase={setPassphrase}
            onSubmit={() => void unlockWithPassphrase(record)}
          />
        ))}
      <button
        type="button"
        className="gate-quiet"
        onClick={() => setStage({ kind: 'recover', returnTo: stage })}
      >
        Use the recovery phrase instead
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </Gate>
  )
}

function Gate({
  title,
  lead,
  children,
}: {
  title: string
  lead?: string
  children: ReactNode
}) {
  return (
    <section className="gate-card">
      <p className="gate-kicker">Private Perps</p>
      <h1>{title}</h1>
      {lead && <p className="gate-lead">{lead}</p>}
      {children}
    </section>
  )
}

function PassphraseForm(props: {
  passphrase: string
  confirm: string
  busy: boolean
  submitLabel: string
  autoFocus?: boolean
  onPassphrase: (v: string) => void
  onConfirm: (v: string) => void
  onSubmit: () => void
}) {
  const mismatch = props.confirm.length > 0 && props.confirm !== props.passphrase
  const ready = props.passphrase.length >= 10 && props.passphrase === props.confirm && !props.busy
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        if (ready) props.onSubmit()
      }}
    >
      <SecretField
        id="new-pass"
        label="Passphrase, at least ten characters"
        autoComplete="new-password"
        value={props.passphrase}
        onChange={props.onPassphrase}
        {...(props.autoFocus ? { autoFocus: true } : {})}
      />
      <div className="field">
        <label htmlFor="confirm-pass">Type it again</label>
        <input
          id="confirm-pass"
          type="password"
          autoComplete="new-password"
          aria-invalid={mismatch}
          aria-describedby={mismatch ? 'confirm-error' : undefined}
          value={props.confirm}
          onChange={(e) => props.onConfirm(e.target.value)}
        />
        {mismatch && (
          <p className="error" id="confirm-error">
            The two do not match.
          </p>
        )}
      </div>
      <button className="gate-primary" type="submit" disabled={!ready}>
        {props.submitLabel}
      </button>
    </form>
  )
}

function PassphraseUnlock(props: {
  passphrase: string
  busy: boolean
  onPassphrase: (value: string) => void
  onSubmit: () => void
}) {
  const ready = props.passphrase.length >= 1 && !props.busy
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        if (ready) props.onSubmit()
      }}
    >
      <SecretField
        id="pass"
        label="Passphrase"
        autoComplete="current-password"
        value={props.passphrase}
        onChange={props.onPassphrase}
        autoFocus
      />
      <button className="gate-primary" type="submit" disabled={!ready}>
        {props.busy ? 'Unlocking…' : 'Unlock'}
      </button>
    </form>
  )
}

function SecretField(props: {
  id: string
  label: string
  autoComplete: string
  value: string
  onChange: (value: string) => void
  autoFocus?: boolean
}) {
  const [visible, setVisible] = useState(false)
  return (
    <div className="field">
      <label htmlFor={props.id}>{props.label}</label>
      <div className="field-control">
        <input
          id={props.id}
          type={visible ? 'text' : 'password'}
          autoComplete={props.autoComplete}
          value={props.value}
          autoFocus={props.autoFocus}
          onChange={(e) => props.onChange(e.target.value)}
        />
        <button
          type="button"
          className="field-reveal"
          aria-pressed={visible}
          onClick={() => setVisible((on) => !on)}
        >
          {visible ? 'Hide' : 'Show'}
        </button>
      </div>
    </div>
  )
}
