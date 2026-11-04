/** Shared helpers so every spike prints a result in the same shape. */

export interface SpikeResult {
  readonly spike: string
  readonly settles: string
  readonly verdict: 'pass' | 'fail' | 'partial'
  readonly findings: Record<string, unknown>
  readonly notes: string
}

export function report(result: SpikeResult): void {
  const line = '='.repeat(72)
  console.log(`\n${line}\nRESULT  ${result.spike}  [${result.verdict.toUpperCase()}]`)
  console.log(`Settles: ${result.settles}`)
  console.log(`Date:    ${new Date().toISOString().slice(0, 10)}`)
  console.log('Findings:')
  for (const [key, value] of Object.entries(result.findings)) {
    console.log(`  ${key}: ${typeof value === 'bigint' ? value.toString() : JSON.stringify(value)}`)
  }
  console.log(`Notes:   ${result.notes}\n${line}\n`)
}

export function required(name: string): string {
  const value = process.env[name]
  if (!value) {
    console.error(`Missing ${name}. Copy .env.example to .env and fill it in.`)
    process.exit(1)
  }
  return value
}

export function optional(name: string): string | undefined {
  return process.env[name] || undefined
}
