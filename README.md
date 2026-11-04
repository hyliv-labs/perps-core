# Coldtrail — Zcash entry path

Private perpetual trading. You enter with shielded ZEC, trade perps on
Lighter, and leave as shielded ZEC at a fresh rotated address. Nothing about
the session is visible to us, because there is no us: the app is static files
and every key, proof and policy decision runs on your device.

This is **Project A** of the architecture doc — the Zcash entry path, built
for the Zcash Free Society Hack (Nov 4). Project B (Ethereum / ETHGlobal) is
a separate repository with no code shared across, deliberately.

## Status

Scaffold with a complete, tested session engine running against mock
adapters. No real adapter is implemented yet, because four dependencies are
still unverified — see [Blockers](#blockers).

```bash
pnpm install
pnpm test        # 62 tests, no network
pnpm dev         # landing page at /, the session flow at /app
```

## Routes

| Path | What it is |
| --- | --- |
| `/` | the landing page: what the product claims, and what it does not hide |
| `/app` | the session UI, running on mock adapters |

Paths rather than hashes, so a static host must fall back to `index.html`
for unknown paths or `/app` 404s on a hard refresh. `public/_redirects`
covers Netlify; Cloudflare Pages reads the same file. On Vercel add a
rewrite of `/(.*)` to `/index.html`; on S3/CloudFront set the error document
to `index.html`; for IPFS, publish a copy of `index.html` as `404.html`.

The volume figure on the landing page is read from `public/stats.json`.
The daily job that writes it — builder-fee earnings off Lighter's public API,
divided by the fee rate — is **not built yet**, so the file currently
reports no volume and the page says so rather than inventing a number.

## How a session works

One session is one unit of unlinkability: one derived key, one Lighter
account, one round trip. Keys are never reused across sessions, and dust is
never swept out of a retired wallet — a sweep would link the two.

```
new ──▶ swap_in_pending ──▶ funded ──▶ converted ──▶ trading
             │                                           │
             │ deadline lapses                           ▼
             ▼                                      withdrawing ◀──┐
         refunding ──▶ closed                            │         │
                                                         ▼         │
                                                 swap_out_pending  │
                                                   │         │     │
                                          settles  │         │ lapses, refunds
                                                   ▼         └─────┘
                                                 closed
```

An inbound refund ends the session. An outbound one lands back on the session
wallet, so the exit is re-quoted and retried rather than leaving USDC stranded.

| State | Entered when | If it fails |
| --- | --- | --- |
| `new` | the checker approves and a key is derived | cancel; nothing has moved |
| `swap_in_pending` | ZEC is sent to the NEAR deposit address | after ~2h, 1Click refunds to your shielded address |
| `funded` | USDC lands in the session wallet | — |
| `converted` | 7702 delegation and paymaster permit are set | retry; funds stay in the session wallet |
| `trading` | the Lighter account is live | — |
| `withdrawing` | positions flat, withdrawal requested | fall back to the slow withdrawal (~27 min) |
| `swap_out_pending` | USDC sent back to NEAR after a random delay | refund to the session wallet, retry the exit |
| `closed` | ZEC received; the session key is retired | — |

## Layout

| Path | What lives there |
| --- | --- |
| `src/core/machine.ts` | the reducer: `(session, event) -> (session, commands)`, pure |
| `src/core/session.ts` | session, state and event types |
| `src/core/store.ts` | IndexedDB persistence, revision guards, the linkability ledger |
| `src/core/keys.ts` | encrypted seed, one derived EVM key per session |
| `src/core/checker.ts` | the pass/fail privacy rules that gate every movement |
| `src/core/log.ts` | logging that redacts key material before it reaches a sink |
| `src/adapters/types.ts` | the interface for each external system |
| `src/adapters/mock.ts` | deterministic mocks: a whole session, no network |
| `src/adapters/near1click/` | the real 1Click adapter, verified against the live API |
| `src/adapters/network/` | what is actually private, and the refusal when nothing is |
| `src/adapters/lighter/` | reads, the hash-pinned WASM signer, and the writes through it |
| `src/adapters/noir/` | the Zcash side: the extension, and doing it by hand |
| `src/adapters/paymaster/` | gas in USDC through Circle, and the ETH fallback |
| `src/orchestrator/` | drives the machine; idempotent effects; `resume()` |
| `src/ui/Landing.tsx` | the landing page |
| `src/ui/App.tsx` | the session screen, and the route shell |
| `brand.md` | palette, type and voice; tokens live in `src/ui/styles.css` |
| `test/` | 62 tests; the orchestrator suite runs against both stores |
| `spikes/` | throwaway scripts that settle the unverified dependencies |

## Design decisions worth knowing

**The reducer is pure and the session is persisted after every transition.**
A reload during `swap_in_pending` leaves real money in flight against a
deadline we did not set, so recovery cannot depend on anything in memory.
`resume()` reconciles every unfinished session against the outside world
before the UI offers a new action.

**Every externally visible effect is journaled before it runs.** The entry is
written unconfirmed first, so a crash between the write and the effect shows
up as "attempted, unconfirmed" rather than vanishing. A retry then reconciles
against the outside world — for `send_zec`, by asking 1Click whether the
deposit arrived — instead of sending the user's ZEC a second time. There is a
test that kills the confirming write mid-flight and asserts exactly one send.

**The exit is gated before it is quoted.** Asking the solver for a quote is
itself a signal that reaches the network, so requesting one at withdrawal time
would defeat the random delay the check exists to enforce. The delay can also
outlast a quote's deadline, so a lapsed quote is re-requested rather than
reused.

**The orchestrator always reloads the session from the store.** Methods take
a `SessionId`, not a `Session`. A caller holding a snapshot across a thrown
checker error or another tab's write would otherwise save over newer state —
which is how the stale-write bug in the first draft of this code was found.

**Amounts are bigint in the asset's smallest unit.** ZEC has 8 decimals and
USDC has 6; a float rounding error here is lost user money. Fees round up so
they are never understated.

**The checker's rules are inferred.** The architecture doc commits to a
pass/fail checker gating every movement but does not enumerate the rules.
Each rule in `src/core/checker.ts` cites the privacy claim it enforces.
Treat the list as the place to add rules, not as settled.

## Blockers

Four dependencies are unverified, and any of them can change the fund flow.
Run `spikes/` before building further.

| Spike | State | What it still needs |
| --- | --- | --- |
| `01-1click-quote.ts` | **partial**, run 2026-10-26 | a real Zcash address; the request shape, asset ids and response shape are settled |
| `02-noir-send.ts` | not run | a browser with the Noir extension; this is the blocker |
| `03-paymaster-7702.ts` | not run | a throwaway key holding USDC and zero ETH |
| `04-lighter-roundtrip.ts` | **partial**, run 2026-10-26 | a funded session wallet for the live half |

### Settled on 2026-10-26

- **1Click** answers `201` on `POST /v0/quote`, not 200. `depositType`,
  `recipientType` and `refundType` are all required, each taking ORIGIN_CHAIN /
  DESTINATION_CHAIN, `INTENTS` or `CONFIDENTIAL_INTENTS` — the last being the
  confidential swap the architecture doc records as invite-only.
- Asset ids confirmed: ZEC `nep141:zec.omft.near` (8dp), USDC on Arbitrum
  `nep141:arb-0xaf88…5831.omft.near` (6dp).
- Addresses are validated **at quote time**, per chain, so neither Zcash leg can
  even be priced without a real Zcash address. The solver spread and the
  per-asset minimum stay open because of it.
- A control leg with no Zcash (USDC to ETH) costs **0.227% all in** without an
  API key, which matches the documented 0.25%.
- **ZEC was quoted at $1,230.92**, not the ~$45 the first scaffold assumed. The
  mock rate and the page's sample figures were corrected.
- **Lighter** publishes 246 markets, every one of them `0.0000/0.0000` taker and
  maker. ETH is `market_id 0`, minimum 0.0020 base and 10 USDC quote, 4dp size
  and 2dp price. `/api/v1/status` answers 403 without credentials, so it is no
  use as a reachability check; the order books are public.

Spike 02 is the one to run first: the doc's fund flow has the Noir Wallet
sending shielded ZEC to a transparent 1Click deposit address, and if the SDK
will not do that from a dApp, step 3 collapses and the documented fallback —
paste an address, send from any wallet — is what ships.

## The network layer, and what it cannot do

A web page cannot route its own requests over Tor. There is no browser API
for it. So the adapter does not make a connection private; it reports whether
it is, and the checker refuses to move money when it is not.

| Arrangement | `isPrivate` | How we know |
| --- | --- | --- |
| Served from a `.onion` origin | yes | read off the origin: `verified` |
| The Nym mixnet (`mixFetch`) | yes | the traffic really leaves through a gateway: `verified` |
| Tor confirmed by the connection check | yes | measured through our own transport: `verified` |
| A forwarder the user runs | yes, if they say so | their word: `asserted` |
| Anything else | no | nothing: `none` |

**Nym** is the one arrangement that makes a browser page private by itself.
`@nymproject/mix-fetch` runs a mixnet client in a Web Worker and the request
leaves through an IPR gateway. Three consequences shape
`src/adapters/network/mixnet.ts`: it has no `AbortController`, so the
deadline is a race rather than a cancel; a cold tunnel takes fifteen to
thirty seconds, so `warmMixnet()` pays that before anyone is waiting on a
quote; and it is a large WASM payload, so the import is dynamic and stays
out of the main bundle. Its other limits — no cookies, no cache, HTTPS only
— are things this product already wanted.

**The connection check** (`src/adapters/network/verify.ts`) exists because
reading the origin only recognises an onion service. Someone running the app
in a Tor browser window is just as private and would otherwise be blocked.
It asks a check service through the app's own transport and believes the
answer. It never runs on its own — a privacy product that calls a third
party on every load is doing the thing it warns about — and the exit address
is never returned, logged or stored; only the yes or no is read out of the
reply.

It never guesses upwards. When nothing can be confirmed it returns the direct
adapter and the session stops, rather than proceeding on an assumption.

Whatever the arrangement, every request made through it drops cookies, drops
the referrer, skips the cache, refuses cross-origin redirects and carries a
deadline. Timeout messages keep the URL's path out of the text, because a
path can name a deposit address.

**The onion service is not built yet.** Until it is, `pnpm dev` runs on
localhost, `isPrivate` is false, and the checker blocks every movement. That
is the system working, not a bug.

## Signing on Lighter, and why it works

Lighter signs with a Go library, and none of its JavaScript packages carry a
signer: its own `zklighter-perps` is an OpenAPI client that submits
transactions signed elsewhere, and the only TypeScript SDK that signs reaches
a native binary through FFI, which a browser cannot do.

It does, though, publish an **official WebAssembly build of that same Go
signer**, in `elliottech/lighter-go/web-wasm`, with a manifest that pins the
binary's SHA-256 and the Go runtime it needs. That is what keeps the "no
backend, keys on device" claim standing.

```bash
pnpm fetch:signer     # downloads and verifies, into public/lighter/
```

Both artifacts are pinned by hash and pulled from a fixed commit rather than
a branch, and **the hashes are checked twice**: once on download, and again
in the browser before the binary is instantiated. The download check says
nothing about what a CDN serves a month later, and this binary is handed
session keys.

The session key crosses into the module once, when the client is made, and
is not kept on the JavaScript side. There are tests for both: that the key
appears in exactly one call, and that a binary with the wrong hash is
refused.

## The Zcash side has two paths on purpose

The biggest open question in this product is whether a dApp can make the
Noir Wallet send to an external address at all (`spikes/02-noir-send.ts`).
Rather than wait for the answer, both paths are built:

- **The extension**, when one is installed and will send for a page.
- **By hand**, which is the fallback the architecture doc names: the person
  pastes a shielded address and sends the ZEC from any wallet they like.

`chooseNoir()` probes before anything needs to move, because an extension
that is present but refuses dApp sends is no better than an absent one, and
finding that out at the moment money should move would strand the session.
So spike 02 now decides which path runs, not whether the product works.

The manual path cannot witness the send and does not pretend to: it returns
no transaction id, and the session waits on the solver's status instead,
which is how the orchestrator already learns a swap settled.

Neither path ever sees a Zcash key.

## Gas, without ever holding ETH

A session wallet is born holding USDC and no ETH, deliberately: funding it
with ETH from anywhere would be the link this product exists to break. So it
has to transact without the chain's native coin.

| Strategy | State |
| --- | --- |
| **Circle Paymaster** (doc's strategy C) — delegate under EIP-7702, permit the paymaster, pay gas in USDC with a 10% surcharge | delegation built; **the call path refuses until spike 03 runs** |
| **A little ETH** (doc's strategy A) — swap a small amount and pay the ordinary way | works today; one more hop, and the hop is visible |

The paymaster's `send` deliberately throws rather than building a
UserOperation: Circle's exact `paymasterAndData` encoding is what
`spikes/03-paymaster-7702.ts` settles, and an operation guessed wrong is
rejected by a bundler at best and mined wrongly at worst. Every missing
piece of configuration is named individually rather than defaulted.

`prepare()` is idempotent — it reads the account's code first, because the
orchestrator may call it again after a crash and delegating twice spends gas
the wallet cannot spare.

## What is deliberately absent

- **A backend.** There is nothing to run and nothing that sees user data.
- **Analytics, fonts, and third-party requests.** Every request the page makes
  is one a user can account for.
- **Dust sweeping.** Residue in a retired session wallet stays there forever.
- **Key export.** Not until there is a recovery design worth trusting.

## Licence

Apache-2.0.
