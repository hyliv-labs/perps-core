/**
 * Key manager.
 *
 * The secret is a twelve-word recovery phrase. Everything else is derived
 * from it: one EVM session key per session, at m/44'/60'/0'/0/<index>. A
 * session key signs Arbitrum transactions and Lighter orders and is then
 * retired, because reusing one across sessions would link them on-chain,
 * which is the whole property this product sells.
 *
 * The phrase is stored encrypted under one or more **locks**. A lock is
 * anything that can reproduce a wrapping key:
 *
 *   - a passkey, through WebAuthn's PRF extension (the default), or
 *   - a passphrase, through PBKDF2 (the fallback, and the way in on
 *     browsers without PRF).
 *
 * Each lock wraps its own copy of the same phrase, so adding a passphrase
 * later does not disturb the passkey, and losing the device still leaves
 * the phrase itself as the way back. ZEC keys are never here: those stay in
 * the user's Noir Wallet.
 */

import { HDKey, english, generateMnemonic, mnemonicToAccount, privateKeyToAccount } from 'viem/accounts'
import type { Account } from 'viem'
import { type EvmAddress, evmAddress, hex } from './types'

/** BIP-44. Sessions differ only in the final index. */
export const SESSION_PATH = (index: number) => `m/44'/60'/0'/0/${index}`

/**
 * Lighter's API key, on a branch of its own.
 *
 * Separate from the EVM key for two reasons, one forced and one chosen.
 *
 * Forced: Lighter's signer refuses anything that is not **40 bytes** — its
 * API key lives on its own curve, not secp256k1 — so a 32-byte EVM key
 * could never have been used, whatever we wanted. (Verified against the
 * pinned WASM: `private key length is not 40 bytes, length: 32`.)
 *
 * Chosen: the API key is handed to a 7.7 MB third-party binary. Keeping it
 * on its own branch means that even if that binary were replaced with
 * something hostile, what it holds cannot move funds on Arbitrum — it can
 * only trade an account the session was leaving anyway.
 */
export const LIGHTER_API_PATH = (index: number) => `m/44'/60'/1'/0/${index}`

/** Lighter's API key length, in bytes. Not negotiable; the signer checks. */
export const LIGHTER_KEY_BYTES = 40

export interface LighterApiKey {
  /** 80 hex characters, 0x-prefixed, as `_createClientByPrv` wants it. */
  readonly privateKeyHex: string
  /** Wipes the derived bytes. Idempotent. */
  readonly retire: () => void
}

const KDF_ITERATIONS = 600_000

export type LockKind = 'passkey' | 'passphrase'

interface LockBase {
  readonly kind: LockKind
  readonly iv: string
  readonly ciphertext: string
  /** For the person choosing between two passkeys on a shared machine. */
  readonly label?: string
  readonly addedAt: number
}

export interface PasskeyLock extends LockBase {
  readonly kind: 'passkey'
  readonly kdf: 'HKDF-SHA256'
  readonly credentialId: string
  readonly salt: string
}

export interface PassphraseLock extends LockBase {
  readonly kind: 'passphrase'
  readonly kdf: 'PBKDF2-SHA512'
  readonly iterations: number
  readonly salt: string
}

export type Lock = PasskeyLock | PassphraseLock

export interface VaultRecord {
  readonly version: 2
  /** At least one. Each opens the same phrase. */
  readonly locks: readonly Lock[]
  /** Highest session index ever derived. Never decreases. */
  readonly highestIndex: number
}

export interface SessionKey {
  readonly index: number
  readonly address: EvmAddress
  readonly account: Account
  /** Wipes the private key from memory. Idempotent. */
  readonly retire: () => void
}

export interface Vault {
  readonly highestIndex: number
  readonly locked: boolean
  deriveSessionKey(index: number): SessionKey
  /**
   * The Lighter API key for this session.
   *
   * Async because the 32 bytes BIP-32 yields are expanded to 40 with HKDF
   * rather than padded: padding would put a constant in a key.
   */
  deriveLighterKey(index: number): Promise<LighterApiKey>
  nextIndex(): number
  lock(): void
}

export class WrongSecretError extends Error {
  override readonly name = 'WrongSecretError'
  constructor() {
    super('that passphrase or passkey does not open this vault')
  }
}

export class NoSuchLockError extends Error {
  override readonly name = 'NoSuchLockError'
  constructor(kind: LockKind) {
    super(`this vault has no ${kind} lock`)
  }
}

const b64 = {
  encode: (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)),
  decode: (text: string): Uint8Array => Uint8Array.from(atob(text), (c) => c.charCodeAt(0)),
}

function crypto_(): Crypto {
  const c = globalThis.crypto
  if (!c?.subtle) throw new Error('WebCrypto unavailable: refusing to handle key material')
  return c
}

/** A passphrase is low entropy, so it is stretched. */
async function passphraseKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const subtle = crypto_().subtle
  const material = await subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-512' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/**
 * A passkey's PRF output is already 32 uniform bytes, so it is expanded
 * rather than stretched. Running PBKDF2 over it would cost time and add
 * nothing.
 */
async function passkeyKey(secret: Uint8Array, salt: Uint8Array): Promise<CryptoKey> {
  const subtle = crypto_().subtle
  const material = await subtle.importKey('raw', secret as BufferSource, 'HKDF', false, [
    'deriveKey',
  ])
  return subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: salt as BufferSource,
      info: new TextEncoder().encode('coldtrail/vault'),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

async function wrap(phrase: string, key: CryptoKey): Promise<{ iv: string; ciphertext: string }> {
  const c = crypto_()
  const iv = c.getRandomValues(new Uint8Array(12))
  const ciphertext = new Uint8Array(
    await c.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      key,
      new TextEncoder().encode(phrase),
    ),
  )
  return { iv: b64.encode(iv), ciphertext: b64.encode(ciphertext) }
}

async function unwrap(lock: Lock, key: CryptoKey): Promise<string> {
  try {
    const plain = await crypto_().subtle.decrypt(
      { name: 'AES-GCM', iv: b64.decode(lock.iv) as BufferSource },
      key,
      b64.decode(lock.ciphertext) as BufferSource,
    )
    return new TextDecoder().decode(plain)
  } catch {
    // AES-GCM authentication failed: wrong secret, or a tampered record.
    throw new WrongSecretError()
  }
}

/** A fresh twelve-word recovery phrase. This is the thing to write down. */
export function generateRecoveryPhrase(): string {
  return generateMnemonic(english)
}

export function isValidRecoveryPhrase(phrase: string): boolean {
  try {
    mnemonicToAccount(normalisePhrase(phrase))
    return true
  } catch {
    return false
  }
}

/** Trims and collapses whitespace, so a pasted phrase with odd spacing works. */
export function normalisePhrase(phrase: string): string {
  return phrase.trim().toLowerCase().split(/\s+/).join(' ')
}

export async function passphraseLock(
  phrase: string,
  passphrase: string,
  label?: string,
): Promise<PassphraseLock> {
  const salt = crypto_().getRandomValues(new Uint8Array(32))
  const key = await passphraseKey(passphrase, salt, KDF_ITERATIONS)
  const { iv, ciphertext } = await wrap(phrase, key)
  return {
    kind: 'passphrase',
    kdf: 'PBKDF2-SHA512',
    iterations: KDF_ITERATIONS,
    salt: b64.encode(salt),
    iv,
    ciphertext,
    addedAt: Date.now(),
    ...(label ? { label } : {}),
  }
}

export async function passkeyLock(
  phrase: string,
  credentialId: string,
  secret: Uint8Array,
  label?: string,
): Promise<PasskeyLock> {
  const salt = crypto_().getRandomValues(new Uint8Array(32))
  const key = await passkeyKey(secret, salt)
  const { iv, ciphertext } = await wrap(phrase, key)
  return {
    kind: 'passkey',
    kdf: 'HKDF-SHA256',
    credentialId,
    salt: b64.encode(salt),
    iv,
    ciphertext,
    addedAt: Date.now(),
    ...(label ? { label } : {}),
  }
}

export function newVaultRecord(locks: readonly Lock[]): VaultRecord {
  if (!locks.length) throw new Error('a vault needs at least one lock')
  return { version: 2, locks, highestIndex: -1 }
}

/** Add a second way in without disturbing the first. */
export async function addLock(record: VaultRecord, lock: Lock): Promise<VaultRecord> {
  return { ...record, locks: [...record.locks, lock] }
}

export function findPasskeyLock(record: VaultRecord): PasskeyLock | undefined {
  return record.locks.find((l): l is PasskeyLock => l.kind === 'passkey')
}

export function hasLock(record: VaultRecord, kind: LockKind): boolean {
  return record.locks.some((l) => l.kind === kind)
}

/** Open with a passphrase. Tries every passphrase lock on the record. */
export async function openWithPassphrase(
  record: VaultRecord,
  passphrase: string,
): Promise<Vault> {
  const locks = record.locks.filter((l): l is PassphraseLock => l.kind === 'passphrase')
  if (!locks.length) throw new NoSuchLockError('passphrase')
  let lastError: unknown
  for (const lock of locks) {
    try {
      const key = await passphraseKey(passphrase, b64.decode(lock.salt), lock.iterations)
      return openPhrase(await unwrap(lock, key), record.highestIndex)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new WrongSecretError()
}

/** Open with the PRF secret read from the passkey named on the record. */
export async function openWithPasskey(
  record: VaultRecord,
  secret: Uint8Array,
): Promise<Vault> {
  const lock = findPasskeyLock(record)
  if (!lock) throw new NoSuchLockError('passkey')
  const key = await passkeyKey(secret, b64.decode(lock.salt))
  return openPhrase(await unwrap(lock, key), record.highestIndex)
}

/** Open with the recovery phrase itself. The way back after losing a device. */
export function openWithPhrase(phrase: string, highestIndex = -1): Vault {
  const normalised = normalisePhrase(phrase)
  if (!isValidRecoveryPhrase(normalised)) throw new WrongSecretError()
  return openPhrase(normalised, highestIndex)
}

function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

function openPhrase(phrase: string, highestIndex: number): Vault {
  let locked = false
  let highest = highestIndex
  const master: HDKey = mnemonicToAccount(phrase).getHdKey()

  return {
    get highestIndex() {
      return highest
    },
    get locked() {
      return locked
    },
    nextIndex: () => highest + 1,
    deriveSessionKey(index: number): SessionKey {
      if (locked) throw new Error('vault is locked')
      if (index < 0 || !Number.isInteger(index)) throw new RangeError('bad index')
      const child = master.derive(SESSION_PATH(index))
      if (!child.privateKey) throw new Error('derivation produced no private key')
      const pk = `0x${toHex(child.privateKey)}` as const
      hex(pk) // validate the shape before it reaches viem
      const account = privateKeyToAccount(pk)
      if (index > highest) highest = index
      let retired = false
      return {
        index,
        address: evmAddress(account.address),
        account,
        retire() {
          if (retired) return
          retired = true
          child.wipePrivateData()
        },
      }
    },
    async deriveLighterKey(index: number): Promise<LighterApiKey> {
      if (locked) throw new Error('vault is locked')
      if (index < 0 || !Number.isInteger(index)) throw new RangeError('bad index')
      const child = master.derive(LIGHTER_API_PATH(index))
      if (!child.privateKey) throw new Error('derivation produced no private key')
      const subtle = crypto_().subtle
      try {
        const material = await subtle.importKey(
          'raw',
          child.privateKey as BufferSource,
          'HKDF',
          false,
          ['deriveBits'],
        )
        const bits = await subtle.deriveBits(
          {
            name: 'HKDF',
            hash: 'SHA-256',
            // The path already separates this key; the salt is fixed so the
            // same vault and index always reproduce it, which is what lets
            // a resumed session prove the key matches the registered one.
            salt: new Uint8Array(0),
            info: new TextEncoder().encode(`coldtrail/lighter-api/${index}`),
          },
          material,
          LIGHTER_KEY_BYTES * 8,
        )
        const bytes = new Uint8Array(bits)
        const privateKeyHex = `0x${toHex(bytes)}`
        if (index > highest) highest = index
        let retired = false
        return {
          privateKeyHex,
          retire() {
            if (retired) return
            retired = true
            bytes.fill(0)
          },
        }
      } finally {
        child.wipePrivateData()
      }
    },
    lock() {
      if (locked) return
      locked = true
      master.wipePrivateData()
    },
  }
}
