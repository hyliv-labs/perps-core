/**
 * Spike 02 — can a dApp make Noir Wallet send to an external address?
 *
 * This is the single biggest unknown in Project A. The doc's fund flow has
 * the user's Noir Wallet sending shielded ZEC to a 1Click deposit address,
 * which is transparent and not a Zcash address at all in the USDC direction.
 * If the SDK will not do that from a dApp, step 3 of the flow collapses and
 * the fallback — the user pastes an address and sends from any wallet — is
 * what ships.
 *
 * Noir is a browser extension, so this spike cannot run in Node: it is a
 * page you open with `pnpm dev` and drive by hand. This file prints the
 * checklist and the exact calls to try in the console.
 */

import { report } from './_report'

const CHECKLIST = `
Open the app with \`pnpm dev\`, install Noir Wallet, and in the page console:

  1. Is it injected at all?
       window.noir ?? window.zcash ?? Object.keys(window).filter(k => /noir|zcash/i.test(k))

  2. Connect, and see what the dApp surface actually exposes:
       const api = await window.noir.connect()
       Object.keys(api)

  3. Can it hand over a rotated receive address?
       await api.getReceiveAddress?.()      // or whatever (2) revealed
     Call it twice. A different address each time is what the exit depends on.

  4. THE QUESTION. Ask it to send to an external transparent address
     (use the deposit address spike 01 printed, with a small real amount):
       await api.send?.({ to: '<1click deposit address>', amount: '0.5' })

     Record exactly which of these happens:
       a. it sends                      -> the doc's flow works as written
       b. it refuses non-shielded       -> flow breaks; fallback ships
       c. no send method on the dApp API -> flow breaks; fallback ships
       d. it prompts but the tx fails   -> capture the error verbatim

  5. Whatever happened, check the balance is where you expect before moving on.
`

report({
  spike: '02-noir-send',
  settles: 'Whether a dApp can make Noir send to an external transparent address',
  verdict: 'partial',
  findings: { runsIn: 'browser, by hand', blocksFundFlowStep: 3 },
  notes: 'Manual spike. Checklist printed below; record outcome (a/b/c/d).',
})

console.log(CHECKLIST)
