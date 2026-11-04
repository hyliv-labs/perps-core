import { describe, expect, it } from 'vitest'
import { createSessionStore, openDatabase } from '@/core/store'
import {
  generateRecoveryPhrase,
  newVaultRecord,
  openWithPasskey,
  passkeyLock,
} from '@/core/keys'
import { createOrchestrator, nextKeyIndex } from '@/orchestrator/orchestrator'
import { readFileSync } from 'node:fs'
import { createMockAdapters } from '@/adapters/mock'
import { createLogger, silentSink } from '@/core/log'
import { parseAmount } from '@/core/types'

/**
 * The exact path the session screen takes: a passkey-locked vault in
 * IndexedDB, then "Start session". If this passes, a blank screen is a
 * rendering problem and not an engine one.
 */
describe('the screen’s own path', () => {
  it('creates a session from a passkey vault held in IndexedDB', async () => {
    const store = createSessionStore(await openDatabase('coldtrail-ui-path'))
    const secret = new Uint8Array(32).fill(3)
    const record = newVaultRecord([await passkeyLock(generateRecoveryPhrase(), 'cred', secret)])
    await store.saveVault(record)

    const vault = await openWithPasskey((await store.vault())!, secret)
    const orchestrator = createOrchestrator({
      adapters: createMockAdapters(),
      store,
      vault,
      logger: createLogger(silentSink),
    })

    const session = await orchestrator.create(parseAmount('ZEC', '1'))
    expect(session.state).toBe('new')
    expect(session.keyIndex).toBe(0)
    expect(session.exitAddress).toBeTruthy()

    // And it is on disk, so a reload finds it rather than losing it.
    expect((await store.get(session.id))?.state).toBe('new')
    expect((await store.vault())?.highestIndex).toBe(0)
  })

  it('shows the wallet that create will actually derive, after a reload', async () => {
    /*
     * While gas is paid in ETH someone has to send a little to the session
     * wallet, and the screen shows that address before the session exists.
     * It read `vault.nextIndex()`, which is only a lower bound: after a
     * reload the ledger can hold a higher index and `create` takes the max.
     * The gap is silent and costs whatever was sent to the wrong wallet.
     */
    const store = createSessionStore(await openDatabase('coldtrail-next-index'))
    const secret = new Uint8Array(32).fill(4)
    const record = newVaultRecord([await passkeyLock(generateRecoveryPhrase(), 'cred', secret)])
    await store.saveVault(record)
    const vault = await openWithPasskey((await store.vault())!, secret)
    const build = () =>
      createOrchestrator({
        adapters: createMockAdapters(),
        store,
        vault,
        logger: createLogger(silentSink),
      })

    const first = await build().create(parseAmount('ZEC', '1'))
    expect(first.keyIndex).toBe(0)

    // A reload: a fresh vault whose in-memory counter knows nothing, which
    // is exactly the case the ledger exists to cover.
    const reloaded = await openWithPasskey((await store.vault())!, secret)
    const shown = await nextKeyIndex(store, reloaded)
    const next = await createOrchestrator({
      adapters: createMockAdapters(),
      store,
      vault: reloaded,
      logger: createLogger(silentSink),
    }).create(parseAmount('ZEC', '1'))

    expect(next.keyIndex).toBe(shown)
    expect(reloaded.deriveSessionKey(shown).address).toBe(next.sessionWallet)
  })

  it('never passes the demo refund address on the live path', async () => {
    /*
     * A source-level check, because the alternative is a live 1Click call.
     * `DEMO_REFUND` is a constant that nobody holds the key to; 1Click
     * rejects a malformed one outright and would fill to one that parsed.
     * Either way it must only ever reach the mocks, so every use of it has
     * to sit behind `stubAdapters`.
     */
    const source = readFileSync('src/ui/session/SessionScreen.tsx', 'utf8')
    const uses = source.split('DEMO_REFUND').length - 1
    // One declaration, one in the dev drive harness, one guarded ternary.
    expect(uses).toBe(3)
    expect(source).toContain(
      'stubAdapters ? DEMO_REFUND : await askRefundAddress(config.zcashNetwork)',
    )
  })
})
