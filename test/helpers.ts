import type { Session, SessionId } from '@/core/session'
import { type Amount, evmAddress, parseAmount, type ShieldedAddress } from '@/core/types'
import { createLogger, silentSink } from '@/core/log'

export const T0 = 1_700_000_000_000

export const testLogger = createLogger(silentSink)

export function makeSession(patch: Partial<Session> = {}): Session {
  return {
    id: 'session-1' as SessionId,
    state: 'new',
    custody: 'user_shielded',
    createdAt: T0,
    updatedAt: T0,
    revision: 1,
    keyIndex: 0,
    sessionWallet: evmAddress(`0x${'5e'.repeat(20)}`),
    notional: parseAmount('ZEC', '10'),
    exitAddress: `u1${'q'.repeat(40)}` as ShieldedAddress,
    swapIn: null,
    swapOut: null,
    lighter: null,
    exitNotBefore: null,
    completed: {},
    failure: null,
    ...patch,
  }
}

export const USDC = (decimal: string): Amount => parseAmount('USDC', decimal)
export const ZEC = (decimal: string): Amount => parseAmount('ZEC', decimal)
