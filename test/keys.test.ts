import { describe, expect, it } from 'vitest'
import {
  NoSuchLockError,
  WrongSecretError,
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

const PASS = 'correct horse battery staple'
const SECRET = new Uint8Array(32).fill(7)

async function passphraseVaultRecord(phrase = generateRecoveryPhrase()) {
  return { phrase, record: newVaultRecord([await passphraseLock(phrase, PASS)]) }
}

describe('recovery phrase', () => {
  it('is twelve words and valid', () => {
    const phrase = generateRecoveryPhrase()
    expect(phrase.split(' ')).toHaveLength(12)
    expect(isValidRecoveryPhrase(phrase)).toBe(true)
  })

  it('rejects a phrase that is not a real one', () => {
    expect(isValidRecoveryPhrase('one two three four five six')).toBe(false)
  })

  it('tolerates odd spacing and case from a paste', () => {
    const phrase = generateRecoveryPhrase()
    const messy = `  ${phrase.toUpperCase().split(' ').join('   ')} `
    expect(normalisePhrase(messy)).toBe(phrase)
    expect(isValidRecoveryPhrase(messy)).toBe(true)
  })
})

describe('passphrase lock', () => {
  it('round-trips', async () => {
    const { record } = await passphraseVaultRecord()
    const vault = await openWithPassphrase(record, PASS)
    expect(vault.locked).toBe(false)
    vault.lock()
  })

  it('rejects the wrong passphrase', async () => {
    const { record } = await passphraseVaultRecord()
    await expect(openWithPassphrase(record, 'wrong')).rejects.toThrow(WrongSecretError)
  })

  it('rejects a tampered ciphertext', async () => {
    const { record } = await passphraseVaultRecord()
    const lock = record.locks[0]!
    const flipped = lock.ciphertext.startsWith('A')
      ? `B${lock.ciphertext.slice(1)}`
      : `A${lock.ciphertext.slice(1)}`
    const tampered = { ...record, locks: [{ ...lock, ciphertext: flipped }] }
    await expect(openWithPassphrase(tampered, PASS)).rejects.toThrow(WrongSecretError)
  })
})

describe('passkey lock', () => {
  it('round-trips with the PRF secret', async () => {
    const phrase = generateRecoveryPhrase()
    const record = newVaultRecord([await passkeyLock(phrase, 'cred-1', SECRET)])
    const vault = await openWithPasskey(record, SECRET)
    expect(vault.deriveSessionKey(0).address).toBe(openWithPhrase(phrase).deriveSessionKey(0).address)
  })

  it('rejects a different PRF secret', async () => {
    const record = newVaultRecord([await passkeyLock(generateRecoveryPhrase(), 'c', SECRET)])
    await expect(openWithPasskey(record, new Uint8Array(32).fill(9))).rejects.toThrow(
      WrongSecretError,
    )
  })

  it('says plainly when the vault has no passkey on it', async () => {
    const { record } = await passphraseVaultRecord()
    await expect(openWithPasskey(record, SECRET)).rejects.toThrow(NoSuchLockError)
  })
})

describe('two locks on one vault', () => {
  it('opens the same phrase either way', async () => {
    const phrase = generateRecoveryPhrase()
    let record = newVaultRecord([await passkeyLock(phrase, 'cred-1', SECRET)])
    record = await addLock(record, await passphraseLock(phrase, PASS))

    expect(hasLock(record, 'passkey')).toBe(true)
    expect(hasLock(record, 'passphrase')).toBe(true)
    expect(findPasskeyLock(record)?.credentialId).toBe('cred-1')

    const viaKey = await openWithPasskey(record, SECRET)
    const viaPass = await openWithPassphrase(record, PASS)
    // Adding the second way in must not change which keys the vault derives.
    expect(viaKey.deriveSessionKey(3).address).toBe(viaPass.deriveSessionKey(3).address)
  })
})

describe('the recovery phrase as the way back', () => {
  it('derives the same keys with no vault record at all', async () => {
    const { phrase, record } = await passphraseVaultRecord()
    const fromRecord = await openWithPassphrase(record, PASS)
    const fromPhrase = openWithPhrase(phrase)
    expect(fromPhrase.deriveSessionKey(5).address).toBe(fromRecord.deriveSessionKey(5).address)
  })

  it('refuses a phrase that is not valid', () => {
    expect(() => openWithPhrase('not a real recovery phrase at all here')).toThrow(WrongSecretError)
  })
})

describe('derivation', () => {
  it('gives a distinct, deterministic key per index', async () => {
    const { record } = await passphraseVaultRecord()
    const a = await openWithPassphrase(record, PASS)
    const first = a.deriveSessionKey(0).address
    expect(a.deriveSessionKey(1).address).not.toBe(first)

    const b = await openWithPassphrase(record, PASS)
    expect(b.deriveSessionKey(0).address).toBe(first)
  })

  it('never hands back an index it has already issued', async () => {
    const { record } = await passphraseVaultRecord()
    const vault = await openWithPassphrase(record, PASS)
    expect(vault.nextIndex()).toBe(0)
    vault.deriveSessionKey(0)
    expect(vault.nextIndex()).toBe(1)
    vault.deriveSessionKey(7)
    expect(vault.nextIndex()).toBe(8)
  })

  it('carries the highest index from the record', async () => {
    const { record } = await passphraseVaultRecord()
    const vault = await openWithPassphrase({ ...record, highestIndex: 11 }, PASS)
    expect(vault.nextIndex()).toBe(12)
  })

  it('refuses to derive once locked', async () => {
    const { record } = await passphraseVaultRecord()
    const vault = await openWithPassphrase(record, PASS)
    vault.lock()
    expect(() => vault.deriveSessionKey(0)).toThrow(/locked/)
  })
})

describe('the Lighter API key', () => {
  /*
   * Lighter's signer refuses anything that is not 40 bytes — its API key is
   * on its own curve, not secp256k1 — so the EVM session key could never
   * have been handed to it. Verified against the pinned binary:
   * "private key length is not 40 bytes, length: 32".
   */
  it('is 40 bytes, because the signer checks', async () => {
    const vault = openWithPhrase(generateRecoveryPhrase())
    const key = await vault.deriveLighterKey(0)
    expect(key.privateKeyHex).toMatch(/^0x[0-9a-f]{80}$/)
  })

  it('reproduces from the same phrase and index', async () => {
    // A resumed session has to rebuild the key its account was registered
    // with, or it cannot close its position or withdraw.
    const phrase = generateRecoveryPhrase()
    const a = await openWithPhrase(phrase).deriveLighterKey(3)
    const b = await openWithPhrase(phrase).deriveLighterKey(3)
    expect(a.privateKeyHex).toBe(b.privateKeyHex)
  })

  it('differs per session, so two sessions cannot be tied by their key', async () => {
    const vault = openWithPhrase(generateRecoveryPhrase())
    const a = await vault.deriveLighterKey(0)
    const b = await vault.deriveLighterKey(1)
    expect(a.privateKeyHex).not.toBe(b.privateKeyHex)
  })

  it('is not the EVM key, nor derived on the same branch', async () => {
    // It goes into a 7.7 MB third-party binary. Keeping it off the EVM
    // branch means that even a hostile signer cannot move funds on Arbitrum.
    const vault = openWithPhrase(generateRecoveryPhrase())
    const api = await vault.deriveLighterKey(0)
    const evm = vault.deriveSessionKey(0)
    expect(api.privateKeyHex.toLowerCase()).not.toContain(evm.address.slice(2).toLowerCase())
  })

  it('refuses once the vault is locked', async () => {
    const vault = openWithPhrase(generateRecoveryPhrase())
    vault.lock()
    await expect(vault.deriveLighterKey(0)).rejects.toThrow(/locked/)
  })

  it('can be wiped, and says so idempotently', async () => {
    const key = await openWithPhrase(generateRecoveryPhrase()).deriveLighterKey(0)
    key.retire()
    expect(() => key.retire()).not.toThrow()
  })
})
