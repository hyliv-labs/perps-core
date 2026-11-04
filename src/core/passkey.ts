/**
 * Passkeys, used only to produce a key.
 *
 * This is not a login. There is no server and nothing to authenticate
 * against: WebAuthn's PRF extension gives us a deterministic 32-byte secret
 * per credential per salt, and that secret encrypts the vault. Nobody
 * verifies an assertion, so no relying party is needed and the "no backend"
 * property holds.
 *
 * PRF is not everywhere yet — Firefox does not implement it — so every
 * caller needs the passphrase path as a fallback.
 */

const PRF_SALT = new TextEncoder().encode('coldtrail/vault/v2')

export interface PasskeyHandle {
  /** Base64url credential id, stored in the vault record. */
  readonly credentialId: string
  /** 32 bytes of key material. Never persisted. */
  readonly secret: Uint8Array
}

export class PasskeyUnavailableError extends Error {
  override readonly name = 'PasskeyUnavailableError'
}

export class PrfUnsupportedError extends Error {
  override readonly name = 'PrfUnsupportedError'
  constructor() {
    super('this browser created a passkey but will not derive a key from it')
  }
}

const b64url = {
  encode(bytes: Uint8Array): string {
    let binary = ''
    for (const b of bytes) binary += String.fromCharCode(b)
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  },
  decode(text: string): Uint8Array {
    const padded = text.replace(/-/g, '+').replace(/_/g, '/')
    return Uint8Array.from(atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '=')), (c) =>
      c.charCodeAt(0),
    )
  },
}

/** True when this browser can both make a platform passkey and derive from it. */
export async function passkeySupported(): Promise<boolean> {
  const PKC = globalThis.PublicKeyCredential as
    | (typeof PublicKeyCredential & {
        isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean>
      })
    | undefined
  if (!PKC?.isUserVerifyingPlatformAuthenticatorAvailable) return false
  try {
    return await PKC.isUserVerifyingPlatformAuthenticatorAvailable()
  } catch {
    return false
  }
}

function prfOf(credential: Credential | null): Uint8Array | null {
  const results = (
    credential as (PublicKeyCredential & { getClientExtensionResults?: () => unknown }) | null
  )?.getClientExtensionResults?.() as { prf?: { results?: { first?: ArrayBuffer } } } | undefined
  const first = results?.prf?.results?.first
  return first ? new Uint8Array(first) : null
}

/**
 * Make a new passkey for this device and read its PRF secret.
 *
 * The secret is read with a second call rather than from the creation
 * result: browsers differ on whether creation returns PRF output at all, and
 * a vault sealed with a secret we cannot reproduce is a vault nobody opens.
 */
export async function createPasskey(label: string): Promise<PasskeyHandle> {
  if (!(await passkeySupported())) {
    throw new PasskeyUnavailableError('no platform authenticator on this device')
  }
  const challenge = crypto.getRandomValues(new Uint8Array(32))
  const userId = crypto.getRandomValues(new Uint8Array(16))

  const created = (await navigator.credentials.create({
    publicKey: {
      challenge,
      // No server, so the relying party is this origin and nothing else.
      rp: { name: 'Private Perps' },
      user: { id: userId, name: label, displayName: label },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 }, // ES256
        { type: 'public-key', alg: -257 }, // RS256
      ],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        residentKey: 'required',
        userVerification: 'required',
      },
      extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
      timeout: 120_000,
    },
  })) as PublicKeyCredential | null

  if (!created) throw new PasskeyUnavailableError('the passkey was not created')
  const credentialId = b64url.encode(new Uint8Array(created.rawId))

  const secret = await readPasskeySecret(credentialId)
  return { credentialId, secret: secret.secret }
}

/** Ask an existing passkey for the same 32 bytes again. */
export async function readPasskeySecret(credentialId: string): Promise<PasskeyHandle> {
  const challenge = crypto.getRandomValues(new Uint8Array(32))
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge,
      allowCredentials: [{ type: 'public-key', id: b64url.decode(credentialId) }],
      userVerification: 'required',
      extensions: {
        prf: { eval: { first: PRF_SALT } },
      } as AuthenticationExtensionsClientInputs,
      timeout: 120_000,
    },
  })

  const secret = prfOf(assertion)
  if (!secret || secret.length < 32) throw new PrfUnsupportedError()
  return { credentialId, secret: secret.slice(0, 32) }
}

export const passkeyEncoding = b64url
