import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MANUAL_TXID,
  NotShieldedError,
  NoirUnavailableError,
  chooseNoir,
  createManualNoirAdapter,
  createNoirExtensionAdapter,
  isShieldedAddress,
  isTxid,
  memoByteLength,
  parseZec,
  shieldedNetwork,
  MEMO_MAX_BYTES,
  type ManualPrompts,
} from '@/adapters/noir'
import { testLogger, ZEC } from './helpers'

afterEach(() => {
  delete (globalThis as { noirwallet?: unknown }).noirwallet
  vi.restoreAllMocks()
})

const SHIELDED = `u1${'q'.repeat(40)}`
const TEST_SHIELDED = `utest1${'q'.repeat(40)}`
const TXID = 'a'.repeat(64)

/** Stand in for what the extension injects at `window.noirwallet`. */
function inject(zcash: Record<string, unknown>): void {
  ;(globalThis as { noirwallet?: unknown }).noirwallet = { zcash }
}

const prompts = (over: Partial<ManualPrompts> = {}): ManualPrompts => ({
  askReceiveAddress: async () => SHIELDED,
  confirmSent: async () => {},
  ...over,
})

describe('address checking', () => {
  it('accepts unified and sapling addresses', () => {
    expect(isShieldedAddress(SHIELDED, 'main')).toBe(true)
    expect(isShieldedAddress(`zs1${'a'.repeat(40)}`, 'main')).toBe(true)
  })

  it('accepts the testnet forms of both', () => {
    expect(isShieldedAddress(TEST_SHIELDED, 'test')).toBe(true)
    expect(isShieldedAddress(`ztestsapling1${'a'.repeat(40)}`, 'test')).toBe(true)
  })

  it('rejects transparent addresses', () => {
    // A transparent exit publishes the amount and the link while still
    // looking like it worked.
    expect(isShieldedAddress('t1abcdefghijklmnopqrstuvwxyz0123', 'main')).toBe(false)
    expect(isShieldedAddress(`0x${'5e'.repeat(20)}`, 'main')).toBe(false)
  })

  it('refuses an address from the other network, either way round', () => {
    /*
     * The dangerous case, and the reason the network is a required
     * argument. A testnet address is well-formed and shielded; accepting one
     * on mainnet would send real ZEC to a chain it does not exist on, and
     * the mistake looks exactly like success until the funds are gone.
     */
    expect(isShieldedAddress(TEST_SHIELDED, 'main')).toBe(false)
    expect(isShieldedAddress(SHIELDED, 'test')).toBe(false)
  })

  it('does not mistake regtest for testnet', () => {
    // Regtest is a private chain anyone can mint on, so an address or a
    // transaction from it is not evidence of anything.
    expect(isShieldedAddress(`uregtest1${'q'.repeat(40)}`, 'test')).toBe(false)
    expect(shieldedNetwork(`uregtest1${'q'.repeat(40)}`)).toBeUndefined()
  })

  it('reads the network off an address it recognises', () => {
    expect(shieldedNetwork(SHIELDED)).toBe('main')
    expect(shieldedNetwork(TEST_SHIELDED)).toBe('test')
    expect(shieldedNetwork('t1abcdefghijklmnopqrstuvwxyz0123')).toBeUndefined()
  })

  it('says which mistake was made', () => {
    expect(new NotShieldedError('t1abc', 'main').message).toMatch(/transparent/)
    expect(new NotShieldedError('nonsense', 'main').message).toMatch(/not a Zcash address/)
  })

  it('names the network rather than calling a good address nonsense', () => {
    // "That is not a Zcash address" about a perfectly valid testnet address
    // sends someone hunting for a typo that is not there.
    const wrong = new NotShieldedError(TEST_SHIELDED, 'main').message
    expect(wrong).toMatch(/testnet/)
    expect(wrong).toMatch(/mainnet/)
    expect(wrong).not.toMatch(/not a Zcash address/)
  })
})

describe('the manual path', () => {
  it('takes a pasted address once it is shielded', async () => {
    const noir = createManualNoirAdapter(prompts(), testLogger, 'main')
    expect(await noir.freshReceiveAddress()).toBe(SHIELDED)
  })

  it('refuses a transparent address rather than using it', async () => {
    const noir = createManualNoirAdapter(
      prompts({ askReceiveAddress: async () => 't1abcdefghijklmnopqrstuvwxyz01' }),
      testLogger,
      'main',
    )
    await expect(noir.freshReceiveAddress()).rejects.toThrow(NotShieldedError)
  })

  it('tolerates whitespace around a paste', async () => {
    const noir = createManualNoirAdapter(
      prompts({ askReceiveAddress: async () => `  ${SHIELDED}\n` }),
      testLogger,
      'main',
    )
    expect(await noir.freshReceiveAddress()).toBe(SHIELDED)
  })

  it('asks for confirmation before reporting a send', async () => {
    let asked: { to: string } | null = null
    const noir = createManualNoirAdapter(
      prompts({
        confirmSent: async (r) => {
          asked = { to: r.to }
        },
      }),
      testLogger,
      'main',
    )
    const result = await noir.send('t1deposit', ZEC('1'))
    expect(asked).toEqual({ to: 't1deposit' })
    // Nothing witnessed a transaction, so nothing invents an id for one.
    expect(result.txid).toBe(MANUAL_TXID)
  })

  it('propagates a cancellation instead of claiming a send', async () => {
    const noir = createManualNoirAdapter(
      prompts({
        confirmSent: async () => {
          throw new Error('cancelled')
        },
      }),
      testLogger,
      'main',
    )
    await expect(noir.send('t1deposit', ZEC('1'))).rejects.toThrow('cancelled')
  })
})

describe('the extension path', () => {
  it('reports absence rather than throwing on a probe', async () => {
    expect(await createNoirExtensionAdapter(testLogger, 'main').isAvailable()).toBe(false)
  })

  it('takes the connected address without asking twice', async () => {
    // `getAccounts` needs no approval, so an already-connected site must not
    // make someone approve again just to read the address it was given.
    let connects = 0
    inject({
      getAccounts: async () => ({ shielded: SHIELDED }),
      connect: async () => {
        connects += 1
        return { shielded: SHIELDED }
      },
    })
    expect(await createNoirExtensionAdapter(testLogger, 'main').freshReceiveAddress()).toBe(SHIELDED)
    expect(connects).toBe(0)
  })

  it('connects when the site is not connected yet', async () => {
    inject({ getAccounts: async () => null, connect: async () => ({ shielded: SHIELDED }) })
    expect(await createNoirExtensionAdapter(testLogger, 'main').freshReceiveAddress()).toBe(SHIELDED)
  })

  it('refuses an unshielded address even from the wallet', async () => {
    inject({ getAccounts: async () => ({ shielded: 't1transparentaddresshere00000' }) })
    await expect(
      createNoirExtensionAdapter(testLogger, 'main').freshReceiveAddress(),
    ).rejects.toThrow(NotShieldedError)
  })

  it('refuses a testnet wallet on a mainnet build', async () => {
    /*
     * The documented reality: mainnet and testnet are separate extensions
     * and a dApp cannot ask which one it is talking to. The address prefix
     * is the only evidence, so this check is the whole defence.
     */
    inject({ getAccounts: async () => ({ shielded: TEST_SHIELDED }) })
    await expect(
      createNoirExtensionAdapter(testLogger, 'main').freshReceiveAddress(),
    ).rejects.toThrow(NotShieldedError)
    expect(await createNoirExtensionAdapter(testLogger, 'test').freshReceiveAddress()).toBe(
      TEST_SHIELDED,
    )
  })

  it('says plainly when the wallet will not send for a page', async () => {
    inject({ getAccounts: async () => ({ shielded: SHIELDED }) })
    await expect(
      createNoirExtensionAdapter(testLogger, 'main').send('t1deposit', ZEC('1')),
    ).rejects.toThrow(NoirUnavailableError)
  })

  it('sends from shielded funds, and says so rather than relying on a default', async () => {
    let sent: Record<string, unknown> | null = null
    inject({
      sendTransaction: async (p: Record<string, unknown>) => {
        sent = p
        return TXID
      },
    })
    const result = await createNoirExtensionAdapter(testLogger, 'main').send(
      TEST_SHIELDED,
      ZEC('0.5'),
      'hello',
    )
    expect(result.txid).toBe(TXID)
    expect(sent).toEqual({
      to: TEST_SHIELDED,
      amount: '0.5',
      memo: 'hello',
      fundingSource: 'shielded',
    })
  })

  it('refuses to invent a transaction id when the wallet returns none', async () => {
    // The old code answered 'unknown' here. A submission whose evidence is
    // the word "unknown" is worse than one that admits it has none.
    inject({ sendTransaction: async () => undefined })
    await expect(
      createNoirExtensionAdapter(testLogger, 'main').send(SHIELDED, ZEC('1')),
    ).rejects.toThrow(/no usable transaction id/)
  })

  it('refuses a memo over the byte limit, counted in bytes', async () => {
    inject({ sendTransaction: async () => TXID })
    const noir = createNoirExtensionAdapter(testLogger, 'main')
    // 512 three-byte characters is 1536 bytes while being 512 characters.
    await expect(noir.send(SHIELDED, ZEC('1'), '☃'.repeat(MEMO_MAX_BYTES))).rejects.toThrow(
      /1536 bytes/,
    )
    await expect(noir.send(SHIELDED, ZEC('1'), 'a'.repeat(MEMO_MAX_BYTES))).resolves.toBeTruthy()
  })

  it('reports the spendable balance, and refuses a syncing one', async () => {
    inject({ getBalance: async () => ({ total: '9', available: '1.5', synced: true }) })
    expect(await createNoirExtensionAdapter(testLogger, 'main').balance()).toEqual(ZEC('1.5'))

    // A zero while syncing is a placeholder, not an empty wallet. Showing it
    // tells someone their funds are gone.
    inject({ getBalance: async () => ({ total: '0', available: '0', synced: false }) })
    await expect(createNoirExtensionAdapter(testLogger, 'main').balance()).rejects.toThrow(
      /still syncing/,
    )
  })
})

describe('reading what the wallet says', () => {
  it('accepts a 64-character hex transaction id and nothing else', () => {
    expect(isTxid(TXID)).toBe(true)
    expect(isTxid(TXID.toUpperCase())).toBe(true)
    expect(isTxid(`0x${TXID}`)).toBe(false)
    expect(isTxid('unknown')).toBe(false)
    expect(isTxid('a'.repeat(63))).toBe(false)
    expect(isTxid(undefined)).toBe(false)
  })

  it('parses ZEC through the string, never a float', () => {
    // 0.1 + 0.2 territory: eight decimals do not survive a double.
    expect(parseZec('0.00000001')).toEqual(ZEC('0.00000001'))
    expect(parseZec('21000000')).toEqual(ZEC('21000000'))
    expect(parseZec(' 1.5 ')).toEqual(ZEC('1.5'))
  })

  it('refuses more precision than the chain has, rather than rounding it', () => {
    // A ninth decimal means the reading is wrong somewhere, and picking a
    // direction to round it is not this code's decision to make.
    expect(() => parseZec('1.000000001')).toThrow(NoirUnavailableError)
    expect(() => parseZec('1,5')).toThrow(NoirUnavailableError)
    expect(() => parseZec('')).toThrow(NoirUnavailableError)
  })

  it('counts memo bytes rather than characters', () => {
    expect(memoByteLength('abc')).toBe(3)
    expect(memoByteLength('☃')).toBe(3)
  })
})

describe('choosing a path', () => {
  it('falls back to the manual path when nothing is installed', async () => {
    const chosen = await chooseNoir({ prompts: prompts(), logger: testLogger, network: 'main' })
    expect(chosen.kind).toBe('manual')
    expect(chosen.reason).toMatch(/no Noir Wallet is installed/)
  })

  it('falls back when the wallet is there but cannot send', async () => {
    // Finding this out when money should move would strand the session.
    inject({ getAccounts: async () => ({ shielded: SHIELDED }) })
    const chosen = await chooseNoir({ prompts: prompts(), logger: testLogger, network: 'main' })
    expect(chosen.kind).toBe('manual')
    expect(chosen.reason).toMatch(/send on its behalf/)
  })

  it('takes the extension when it will send', async () => {
    inject({ sendTransaction: async () => TXID, getAccounts: async () => ({ shielded: SHIELDED }) })
    expect((await chooseNoir({ prompts: prompts(), logger: testLogger, network: 'main' })).kind).toBe('extension')
  })

  it('honours a preference for doing it by hand', async () => {
    inject({ sendTransaction: async () => TXID })
    const chosen = await chooseNoir({
      prompts: prompts(),
      logger: testLogger,
      network: 'main',
      preferManual: true,
    })
    expect(chosen.kind).toBe('manual')
  })
})

describe('restoring a connection without asking again', () => {
  it('reads an already-granted connection and never calls connect', async () => {
    /*
     * `connect()` needs a user gesture, so a mount-time restore that fell
     * back to it would be a popup nobody asked for — and one the browser
     * would refuse anyway.
     */
    let connects = 0
    inject({
      getAccounts: async () => ({ shielded: SHIELDED }),
      connect: async () => {
        connects += 1
        return { shielded: SHIELDED }
      },
    })
    const noir = createNoirExtensionAdapter(testLogger, 'main')
    expect(await noir.connectedAddress?.()).toBe(SHIELDED)
    expect(connects).toBe(0)
  })

  it('answers null rather than prompting when nothing is connected', async () => {
    inject({ getAccounts: async () => null, connect: async () => ({ shielded: SHIELDED }) })
    expect(await createNoirExtensionAdapter(testLogger, 'main').connectedAddress?.()).toBeNull()
  })

  it('treats a wallet on the other network as no connection at all', async () => {
    // Restoring it would show a testnet address on a mainnet page as though
    // the two were interchangeable.
    inject({ getAccounts: async () => ({ shielded: TEST_SHIELDED }) })
    expect(await createNoirExtensionAdapter(testLogger, 'main').connectedAddress?.()).toBeNull()
    expect(await createNoirExtensionAdapter(testLogger, 'test').connectedAddress?.()).toBe(
      TEST_SHIELDED,
    )
  })
})
