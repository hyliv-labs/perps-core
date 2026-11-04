/**
 * Logging that cannot leak key material.
 *
 * Anything resembling a private key, seed phrase, API secret or shielded
 * address is replaced before it reaches a sink. The threat here is mundane:
 * a console log in a browser devtools session, a crash report, a screen
 * share during a demo.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogSink {
  write(level: LogLevel, message: string, fields: Record<string, unknown>): void
}

const REDACTED = '[redacted]'

/** Field names whose values are never logged, at any depth. */
const SECRET_KEYS = new Set([
  'privatekey', 'privkey', 'secret', 'seed', 'mnemonic', 'passphrase',
  'password', 'apisecret', 'apikey', 'signature', 'sig', 'authorization',
  'shieldedaddress', 'refundaddress', 'recipient', 'depositaddress',
])

/** Shapes that are secret wherever they appear, including inside strings. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\b0x[0-9a-fA-F]{64}\b/g,            // 32-byte hex: a private key
  /\bu1[0-9a-z]{30,}\b/g,              // Zcash unified address
  /\bzs1[0-9a-z]{30,}\b/g,             // Sapling shielded address
  /\b[0-9a-f]{64}\b/g,                 // bare 32-byte hex
]

function scrubString(value: string): string {
  return SECRET_PATTERNS.reduce((acc, re) => acc.replace(re, REDACTED), value)
}

export function scrub(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[deep]'
  if (typeof value === 'string') return scrubString(value)
  if (typeof value === 'bigint') return `${value}`
  if (value === null || typeof value !== 'object') return value
  if (value instanceof Uint8Array) return REDACTED
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1))
  if (value instanceof Error) return { name: value.name, message: scrubString(value.message) }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEYS.has(k.toLowerCase().replace(/[_-]/g, ''))
      ? REDACTED
      : scrub(v, depth + 1)
  }
  return out
}

export const consoleSink: LogSink = {
  write(level, message, fields) {
    const line = `[${new Date().toISOString()}] ${message}`
    const payload = scrub(fields) as Record<string, unknown>
     
    console[level === 'debug' ? 'log' : level](line, payload)
  },
}

/** Drops everything. The default in tests. */
export const silentSink: LogSink = { write() {} }

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
  error(message: string, fields?: Record<string, unknown>): void
  child(context: Record<string, unknown>): Logger
}

export function createLogger(sink: LogSink, context: Record<string, unknown> = {}): Logger {
  const at = (level: LogLevel) => (message: string, fields: Record<string, unknown> = {}) =>
    sink.write(level, message, { ...context, ...fields })
  return {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: (extra) => createLogger(sink, { ...context, ...extra }),
  }
}
