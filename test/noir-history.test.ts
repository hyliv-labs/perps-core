import { describe, expect, it } from 'vitest'
import { describeStatus, entriesOf, statusOf } from '@/adapters/noir/history'

/**
 * Reading a history whose shape nobody published.
 *
 * The thing being tested is restraint: that a transaction is called mined
 * only on positive evidence, and that an unreadable history is distinguished
 * from an empty one. Both of the lazy answers — "assume pending", "assume
 * mined" — are wrong in a way that matters, because the transaction id is
 * the only evidence a shielded payment leaves.
 */

const TXID = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)

describe('finding the list', () => {
  it('takes the response when it is itself the list', () => {
    expect(entriesOf([{ txid: TXID }])).toHaveLength(1)
  })

  it('takes the single array inside a wrapper, whatever it is called', () => {
    // The point of being structural: `transactions`, `items`, `history` and
    // whatever else it may be called all work without being guessed at.
    expect(entriesOf({ anythingAtAll: [{ txid: TXID }], page: 1 })).toHaveLength(1)
  })

  it('refuses to choose when two arrays are equally plausible', () => {
    // With two candidates there is no structural reason to prefer either,
    // and preferring one would be the guess this avoids.
    expect(entriesOf({ sent: [{ txid: TXID }], received: [{ txid: OTHER }] })).toBeUndefined()
  })

  it('gives nothing for a response that is not a container at all', () => {
    expect(entriesOf(null)).toBeUndefined()
    expect(entriesOf('a string')).toBeUndefined()
    expect(entriesOf(undefined)).toBeUndefined()
  })
})

describe('what can be said about a transaction', () => {
  it('finds the entry by the id already held, in whatever field carries it', () => {
    expect(statusOf([{ id: TXID, height: 10 }], TXID)).toBe('mined')
    expect(statusOf([{ transactionId: TXID, blockHeight: 3 }], TXID)).toBe('mined')
  })

  it('says seen, not mined, when nothing shows it is in a block', () => {
    /*
     * The important refusal. The entry exists, so the wallet knows about the
     * transaction — but knowing about it is not the same as it being mined,
     * and a screen that said "mined" here would be claiming the one thing
     * it cannot see.
     */
    expect(statusOf([{ txid: TXID, status: 'pending' }], TXID)).toBe('seen')
    expect(statusOf([{ txid: TXID }], TXID)).toBe('seen')
  })

  it('reads a zero height and a zero confirmation count as no evidence', () => {
    // A field named `height` is not evidence; a positive value in it is.
    expect(statusOf([{ txid: TXID, height: 0 }], TXID)).toBe('seen')
    expect(statusOf([{ txid: TXID, confirmations: 0 }], TXID)).toBe('seen')
    expect(statusOf([{ txid: TXID, confirmations: 1 }], TXID)).toBe('mined')
  })

  it('accepts a boolean or a word that says it plainly', () => {
    expect(statusOf([{ txid: TXID, mined: true }], TXID)).toBe('mined')
    expect(statusOf([{ txid: TXID, mined: false }], TXID)).toBe('seen')
    expect(statusOf([{ txid: TXID, state: 'confirmed' }], TXID)).toBe('mined')
  })

  it('tells an empty history apart from one it could not read', () => {
    // Both mean "do not claim this was paid", but only one of them is worth
    // waiting through; the other needs a person to look at it.
    expect(statusOf([], TXID)).toBe('absent')
    expect(statusOf([{ txid: OTHER, height: 9 }], TXID)).toBe('absent')
    expect(statusOf({ sent: [], received: [] }, TXID)).toBe('unreadable')
    expect(statusOf('nonsense', TXID)).toBe('unreadable')
  })

  it('does not go looking on behalf of an id that is not one', () => {
    expect(statusOf([{ txid: 'unknown' }], 'unknown')).toBe('unreadable')
  })

  it('matches regardless of case or padding', () => {
    expect(statusOf([{ txid: ` ${TXID.toUpperCase()} `, height: 1 }], TXID)).toBe('mined')
  })

  it('never describes an unreadable history as nothing having happened', () => {
    // The sentence a person reads has to carry the uncertainty too.
    expect(describeStatus('unreadable')).toMatch(/could not be read/)
    expect(describeStatus('seen')).toMatch(/nothing there says it is mined/)
    expect(describeStatus('mined')).toMatch(/seen in a block/)
  })
})
