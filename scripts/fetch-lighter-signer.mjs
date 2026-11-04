/**
 * Fetch Lighter's WebAssembly signer, and refuse anything that is not
 * exactly what we pinned.
 *
 * Lighter signs with a native library, and its JavaScript packages carry no
 * signer. It does publish an official WASM build, which is what makes
 * browser signing possible at all and keeps this product's "no backend"
 * claim intact.
 *
 * Both artifacts are pinned by SHA-256 and pulled from a fixed commit rather
 * than a branch. This binary will hold session keys, so "probably the right
 * file" is not good enough: a mismatch aborts and writes nothing.
 *
 *   node scripts/fetch-lighter-signer.mjs
 */

import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** From web-wasm/main.manifest.json at the pinned commit. */
const PIN = {
  sourceCommit: 'ca5690f29f51197e844e1b4d7f2e455b56fc4785',
  goVersion: 'go1.26.8',
  protocol: 2,
  wasm: {
    url: 'https://raw.githubusercontent.com/elliottech/lighter-go/ca5690f29f51197e844e1b4d7f2e455b56fc4785/web-wasm/main.wasm',
    sha256: '6e24ad64ecbf16fc35c1a381ddf0acce0e3c564a32fe6c116ffd29e9df723c5b',
    name: 'main.wasm',
  },
  // Go's own runtime, which must match the compiler that built the binary.
  runtime: {
    url: 'https://raw.githubusercontent.com/golang/go/go1.26.8/lib/wasm/wasm_exec.js',
    sha256: '0c949f4996f9a89698e4b5c586de32249c3b69b7baadb64d220073cc04acba14',
    name: 'wasm_exec.js',
  },
}

const OUT = join(process.cwd(), 'public', 'lighter')

async function fetchVerified({ url, sha256, name }) {
  process.stdout.write(`  ${name} … `)
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${name}: ${response.status} from ${url}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  const got = createHash('sha256').update(bytes).digest('hex')
  if (got !== sha256) {
    throw new Error(
      `${name}: refusing to write it.\n    expected ${sha256}\n    got      ${got}\n` +
        '    The published artifact changed. Do not use it until you know why.',
    )
  }
  console.log(`${(bytes.length / 1024 / 1024).toFixed(1)} MB, hash matches`)
  return bytes
}

async function main() {
  console.log(`Lighter signer, from ${PIN.sourceCommit.slice(0, 10)} built with ${PIN.goVersion}`)
  const [wasm, runtime] = await Promise.all([
    fetchVerified(PIN.wasm),
    fetchVerified(PIN.runtime),
  ])

  await mkdir(OUT, { recursive: true })
  await writeFile(join(OUT, PIN.wasm.name), wasm)
  await writeFile(join(OUT, PIN.runtime.name), runtime)
  await writeFile(
    join(OUT, 'pin.json'),
    `${JSON.stringify(PIN, null, 2)}\n`,
  )

  console.log(`\nWritten to public/lighter/. The app verifies these hashes again at load.`)
}

main().catch((error) => {
  console.error(`\n${error.message}`)
  process.exit(1)
})
