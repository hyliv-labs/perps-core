/**
 * The session reducer.
 *
 * Pure: (session, event) -> (session, commands). No I/O, no clock, no
 * randomness; the caller passes `now`. This is what makes a crash survivable
 * — rehydrate the session from storage, replay nothing, and the machine is
 * exactly where it was.
 *
 * An event that does not apply to the current state is ignored rather than
 * throwing: duplicate events arrive routinely from pollers that ran twice.
 */

import type { Command, CompletedEffect, Session, SessionEvent, SessionState } from './session'
import { TERMINAL_STATES } from './session'

export interface Transition {
  readonly session: Session
  readonly commands: readonly Command[]
}

/** Legal state transitions. Anything absent here cannot happen. */
const ALLOWED: Readonly<Record<SessionState, readonly SessionState[]>> = {
  new: ['swap_in_pending', 'failed'],
  swap_in_pending: ['funded', 'refunding', 'failed'],
  funded: ['converted', 'failed'],
  converted: ['trading', 'failed'],
  trading: ['withdrawing', 'failed'],
  withdrawing: ['swap_out_pending', 'failed'],
  swap_out_pending: ['closed', 'refunding', 'failed'],
  // An outbound refund lands back on the session wallet, which retries the exit.
  refunding: ['failed', 'closed', 'withdrawing'],
  closed: [],
  failed: [],
}

/** Merge an effect into the journal, preserving an existing confirmation. */
function withEffect(
  session: Session,
  effect: CompletedEffect | undefined,
): Session['completed'] {
  if (!effect) return session.completed
  const previous = session.completed[effect.key]
  if (previous?.confirmed) return session.completed
  return { ...session.completed, [effect.key]: effect }
}

export function canTransition(from: SessionState, to: SessionState): boolean {
  return from === to || (ALLOWED[from] ?? []).includes(to)
}

export function isTerminal(state: SessionState): boolean {
  return TERMINAL_STATES.includes(state)
}

function advance(
  session: Session,
  to: SessionState,
  patch: Partial<Session>,
  now: number,
): Session {
  if (!canTransition(session.state, to)) return session
  return {
    ...session,
    ...patch,
    state: to,
    updatedAt: now,
    revision: session.revision + 1,
  }
}

export function reduce(session: Session, event: SessionEvent, now: number): Transition {
  // A terminal session accepts nothing. Late pollers land here constantly.
  if (isTerminal(session.state) && event.type !== 'effect_completed') {
    return { session, commands: [] }
  }

  switch (event.type) {
    case 'effect_completed': {
      // Recorded in every state, including terminal ones: the journal is how
      // we know not to send the same transaction twice after a crash.
      const previous = session.completed[event.effect.key]
      // An unconfirmed entry is upgraded in place once the effect lands; a
      // repeat of an already-confirmed one changes nothing.
      if (previous?.confirmed) return { session, commands: [] }
      return {
        session: {
          ...session,
          completed: { ...session.completed, [event.effect.key]: event.effect },
          updatedAt: now,
          revision: session.revision + 1,
        },
        commands: [],
      }
    }

    case 'quote_in_received': {
      if (session.state !== 'new') return { session, commands: [] }
      // Still 'new': the quote exists but no ZEC has moved, so cancelling
      // here costs nothing. The leg and its journal entry land together —
      // split across two writes, a crash between them would mark the step
      // done with no quote to show for it.
      return {
        session: {
          ...session,
          swapIn: event.leg,
          completed: withEffect(session, event.effect),
          updatedAt: now,
          revision: session.revision + 1,
        },
        commands: [],
      }
    }

    case 'zec_sent': {
      if (session.state !== 'new' || !session.swapIn) return { session, commands: [] }
      return {
        session: advance(
          session,
          'swap_in_pending',
          { custody: 'near_solver', swapIn: { ...session.swapIn, status: 'deposited' } },
          now,
        ),
        commands: [{ type: 'poll_swap', leg: 'in' }],
      }
    }

    case 'swap_in_settled': {
      if (session.state !== 'swap_in_pending' || !session.swapIn) return { session, commands: [] }
      return {
        session: advance(
          session,
          'funded',
          {
            custody: 'session_wallet',
            swapIn: { ...session.swapIn, status: 'settled', settledAmount: event.received },
          },
          now,
        ),
        commands: [{ type: 'setup_gas' }],
      }
    }

    case 'gas_ready': {
      if (session.state !== 'funded') return { session, commands: [] }
      return {
        session: advance(session, 'converted', {}, now),
        commands: [{ type: 'open_lighter' }],
      }
    }

    case 'lighter_ready': {
      if (session.state !== 'converted') return { session, commands: [] }
      return {
        session: advance(session, 'trading', { custody: 'lighter', lighter: event.account }, now),
        commands: [],
      }
    }

    case 'withdraw_requested': {
      if (session.state !== 'trading') return { session, commands: [] }
      return { session: advance(session, 'withdrawing', {}, now), commands: [] }
    }

    case 'withdraw_settled': {
      if (session.state !== 'withdrawing') return { session, commands: [] }
      // Custody is back on the session wallet, but the exit swap waits out a
      // random delay: an immediate swap out ties the exit to the entry by
      // timing alone.
      return {
        session: advance(
          session,
          'withdrawing',
          { custody: 'session_wallet', exitNotBefore: event.exitNotBefore },
          now,
        ),
        commands: [{ type: 'request_exit_quote' }],
      }
    }

    case 'quote_out_received': {
      if (session.state !== 'withdrawing') return { session, commands: [] }
      return {
        session: {
          ...session,
          swapOut: event.leg,
          completed: withEffect(session, event.effect),
          updatedAt: now,
          revision: session.revision + 1,
        },
        commands: [],
      }
    }

    case 'usdc_sent': {
      if (session.state !== 'withdrawing' || !session.swapOut) return { session, commands: [] }
      return {
        session: advance(
          session,
          'swap_out_pending',
          { custody: 'near_solver', swapOut: { ...session.swapOut, status: 'deposited' } },
          now,
        ),
        commands: [{ type: 'poll_swap', leg: 'out' }],
      }
    }

    case 'swap_out_settled': {
      if (session.state !== 'swap_out_pending' || !session.swapOut) return { session, commands: [] }
      return {
        session: advance(
          session,
          'closed',
          {
            custody: 'user_shielded',
            swapOut: { ...session.swapOut, status: 'settled', settledAmount: event.received },
          },
          now,
        ),
        // Dust is never swept: a later sweep from a retired session wallet
        // would link this session to the next one.
        commands: [{ type: 'retire_key', keyIndex: session.keyIndex }],
      }
    }

    case 'swap_expired': {
      // Already refunding: a refunded leg is also past its deadline, and
      // re-firing here would loop the session in `refunding` forever.
      if (session.state === 'refunding') return { session, commands: [] }
      const leg = event.leg === 'in' ? session.swapIn : session.swapOut
      if (!leg) return { session, commands: [] }
      const expired = { ...leg, status: 'expired' as const }
      return {
        session: advance(
          session,
          'refunding',
          event.leg === 'in' ? { swapIn: expired } : { swapOut: expired },
          now,
        ),
        commands: [{ type: 'await_refund' }],
      }
    }

    case 'refund_confirmed': {
      if (session.state !== 'refunding') return { session, commands: [] }
      // An inbound refund goes to the user's shielded address, so the session
      // is over; an outbound refund lands back on the session wallet, which
      // must try the exit again rather than stranding USDC there.
      const inbound = session.swapIn?.status === 'expired'
      return inbound
        ? {
            session: advance(session, 'closed', { custody: 'user_shielded' }, now),
            commands: [{ type: 'retire_key', keyIndex: session.keyIndex }],
          }
        : {
            session: advance(
              session,
              'withdrawing',
              { custody: 'session_wallet', swapOut: null },
              now,
            ),
            commands: [{ type: 'request_exit_quote' }],
          }
    }

    case 'failed': {
      return {
        session: advance(session, 'failed', { failure: event.failure, custody: 'unknown' }, now),
        commands: [],
      }
    }
  }
}

/** Fold a batch of events. Used on rehydrate and in tests. */
export function reduceAll(
  session: Session,
  events: readonly SessionEvent[],
  now: number,
): Transition {
  let current = session
  const commands: Command[] = []
  for (const event of events) {
    const next = reduce(current, event, now)
    current = next.session
    commands.push(...next.commands)
  }
  return { session: current, commands }
}
