import type { ManualPrompts } from '@/adapters/noir'
import { formatAmount, type ShieldedAddress, type ZcashNetwork } from '@/core/types'
import { isShieldedAddress, shieldedNetwork } from '@/adapters/noir'

/** What to call the chain in a sentence addressed to a person. */
function wording(network: ZcashNetwork): string {
  return network === 'test' ? 'testnet' : 'mainnet'
}

/**
 * Why a pasted address was not accepted, in the words of someone who has
 * just had a paste rejected and wants to know what to paste instead.
 *
 * The wrong-network case is called out separately because it is the one
 * that looks like success: the address is well-formed and shielded, and on
 * mainnet sending to it would put real ZEC somewhere unreachable.
 */
function rejection(value: string, network: ZcashNetwork): string {
  const found = shieldedNetwork(value)
  if (found !== undefined) {
    return (
      `That is a ${wording(found)} address and this app is on ${wording(network)}. ` +
      `Paste a ${wording(network)} one — it begins ` +
      `${network === 'test' ? 'utest1 or ztestsapling1' : 'u1 or zs1'}.`
    )
  }
  return (
    'That is not a shielded address. It has to begin ' +
    `${network === 'test' ? 'utest1 or ztestsapling1' : 'u1 or zs1'} — a transparent ` +
    'address would publish the thing being sent.'
  )
}

/**
 * The manual Zcash path, asked for in the browser.
 *
 * This is the fallback for someone with no Noir Wallet extension: they paste
 * a rotated shielded address, and they send the deposit from whatever wallet
 * they like. The app never sees the send and does not pretend to — it waits
 * on the solver's status instead.
 *
 * `window.prompt` is a poor way to paste a 78-character shielded address and
 * it is a stopgap, not the finished thing. It is here because the honest
 * fallback working badly beats a polished one that does not exist: this path
 * is what the product falls back to the moment spike 02 says the extension
 * is not there. The address is validated before it is accepted, so a typo
 * fails here rather than three steps later when money is already moving.
 */
/**
 * Where a failed inbound swap should send the Zcash back to.
 *
 * Asked rather than assumed, and that is the whole point of it existing.
 * The screen used to pass a constant placeholder on the live path as well
 * as the demo one — so a solver that could not fill would have refunded to
 * an address nobody holds the key to, or, as 1Click actually does with a
 * malformed one, refused the quote outright. Neither is a thing to find out
 * with real ZEC in flight.
 *
 * It is validated here, before any money moves, by the same rule the exit
 * address is held to: a transparent address would publish the refund.
 */
export async function askRefundAddress(network: ZcashNetwork): Promise<ShieldedAddress> {
  for (;;) {
    const given = globalThis.prompt?.(
      `Paste a ${wording(network)} shielded address for refunds.\n\n` +
        'If the swap cannot be filled, the Zcash comes back here. It is not ' +
        'the exit address and should not be the same one.',
    )
    if (given === null || given === undefined) {
      throw new Error('No refund address was given, so nothing was sent.')
    }
    const trimmed = given.trim()
    if (isShieldedAddress(trimmed, network)) return trimmed
    globalThis.alert?.(rejection(trimmed, network))
  }
}

export function createBrowserPrompts(network: ZcashNetwork): ManualPrompts {
  return {
    async askReceiveAddress() {
      for (;;) {
        const given = globalThis.prompt?.(
          `Paste a freshly rotated ${wording(network)} shielded address for the exit.\n\n` +
            'Rotate first: reusing one joins this session to the last.',
        )
        if (given === null || given === undefined) {
          throw new Error('No exit address was given, so the session cannot leave.')
        }
        const trimmed = given.trim()
        if (isShieldedAddress(trimmed, network)) return trimmed
        globalThis.alert?.(rejection(trimmed, network))
      }
    },

    async confirmSent({ to, value, memo }) {
      const lines = [
        `Send exactly ${formatAmount(value)} ${value.asset} to:`,
        '',
        to,
        ...(memo ? ['', `Memo: ${memo}`] : []),
        '',
        `Send it from your own ${wording(network)} shielded wallet, then confirm.`,
        'Nothing here can see the send; the solver reports it.',
      ]
      const said = globalThis.confirm?.(lines.join('\n'))
      if (!said) throw new Error('The deposit was not confirmed, so the session was not started.')
    },
  }
}
