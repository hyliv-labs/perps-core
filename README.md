# Coldtrail — shielded ZEC in, perps, shielded ZEC out

Trade perpetual futures without the venue, the solver, or anyone reading the
chain being able to join your trading to you. You enter with shielded ZEC,
trade on Lighter, and leave as shielded ZEC at a fresh address. There is no
backend: the app is static files, and every key, proof and policy decision
runs on your device.

Built for the Free Society Hack, 4 November 2026. The repository was created
the same day and the commit history is the record.

---

## What actually ran

Executed live on 2026-11-04, most of it for the first time. Every figure
below is from that run.

| Leg | Amount | Evidence |
| --- | --- | --- |
| **Shielded ZEC sent** | 0.0094 ZEC ($12.08) | **`d2ac2c8de214788577066798af3ee081d9739ed09bac3883f84857cf977a30e5`** |
| 1Click swap settled | 11.997192 USDC | `0xcbef4d9e7a67a320a396ddc96891ee5d9792757d3abf39e73ab9533edbff2ce5` |
| Deposit to Lighter | 11.900000 USDC, gas **0.011813 USDC** | `0x08c7f304481482d587db88796f7423af0f0b41909d5eb53ff492db9678cf86f8` |
| Lighter account created | index **766821** | by the deposit itself, not a signup |
| API key registered | first live WASM signature | `782fc8744fe048d5292ed4d10ff4a3922aebc15c80fd36d098eb19ec9152cd0c0101e54bda9ed1df` |
| ETH perp opened | 0.005 @ $2,320.81 | `e2b45b060c70031ae88347e2a76c9f102157bda8d8133bde29070c6624f2fce0790d7dbd3cb243cc` |
| Position flattened | reduce-only, positions `[]` | `614d7918be5a8482f95c209c60feeaf3c16fca1a526583a7a888532661bc08a785c9756289b6e0d1` |

The ZEC was sent to the 1Click deposit address
`t1dmpdr8jfbxiuwZu8uCPtLBAxq67ZrPQdP`, with refunds pointed at a shielded
address the sender controls.

The paymaster transaction is the one worth checking:
`0xae3558fc08346181faf040c598c1f1dc0e3a0edae56ee21803c1ce33f5de1c47` — a
wallet holding **zero ETH**, before and after, transacting on Arbitrum with
the gas paid in USDC.

---

## Who this is for, and the evidence

**The user:** someone who already trades perpetuals and already holds ZEC, and
does not want the two facts joined.

**The problem, stated only as far as the evidence goes.** A perpetuals account
is a durable identity: deposits, positions and withdrawals are public on
Arbitrum and attributable to one address. Funding that address from an
exchange or an existing wallet links the trading to everything else that
address has ever done. That is a property of the chain, not a claim about how
many people mind.

**What this project can honestly say.** The mechanism works. A session wallet
that has never held ETH can deposit, trade and withdraw, so no funding
transaction ever links it to anything. That is demonstrated above, with
transaction hashes.

**What it cannot say.** No user research was done during the hack and no users
were interviewed. Presenting the demand as established would be inventing it.
The honest position: the mechanism is proven, the demand is not.

---

## Privacy and trust

### What stays private

- **The session key.** Derived on the device, never transmitted, never reused.
  Retired at the end rather than swept — a sweep is itself a transaction
  linking the old wallet to the new one.
- **The vault.** Encrypted on the device, opened by a passkey or a passphrase.
  Nothing about it is sent anywhere.
- **The amounts and counterparties of the Zcash legs**, which are shielded.

### What is revealed, and to whom

| Party | What they see |
| --- | --- |
| **NEAR 1Click solver** | the deposit address, the amount, and the destination on Arbitrum. The deposit address is **transparent** — a solver has to see the deposit to act on it |
| **Lighter** | a session account, its deposits, orders and withdrawal. Not who owns it |
| **Circle paymaster + bundler** | the session wallet address and the operations it pays for |
| **The Arbitrum RPC provider** | the addresses it is asked about. Rotated by key index, so one provider is not asked about two of your session wallets |
| **Anyone reading the chain** | the session wallet's entire history. That is the point: it has none before the session and none after |

### Who you must trust

- **The venues**, to behave as their APIs describe. Four places where they did
  not are fixed here and listed below.
- **Your network**, not to be the link. The checker refuses to move money when
  the connection is not private.
- **The Noir wallet**, to send what you asked it to send.

### The known limitation

**Noir has no rotate-address call.** The exit lands on the account's primary
shielded address, so a second session on the same wallet links the two.
Address rotation is this product's unit of unlinkability, so this is a real
limitation, not a rough edge. The adapter returns the extension path *with
that reason attached* rather than hiding it.

### What we would fix next

Route every venue call through the mixnet before funding anything. The
`/gate` screen asks all four venues through the real transport, read-only,
and nothing moves until they answer. It was built during the hack and has not
yet been run against a live Nym tunnel — every reachability probe on record
was clearnet from localhost.

---

## Technologies, and why each is here

| Technology | Why |
| --- | --- |
| **Zcash (shielded)** | the entry and exit asset; shielded sends are what make the round trip unlinkable at the edges |
| **Noir Wallet extension** | the Zcash side in a browser. Falls back to showing the deposit address for a manual send, which is the path that certainly works |
| **NEAR 1Click** | ZEC ↔ USDC with no account and no custodian |
| **Lighter** | perpetuals where the account is created *by a deposit* rather than a signup, with a WASM signer that runs in the browser |
| **Circle Paymaster v0.8 + EIP-7702** | gas paid in USDC, so the session wallet never holds ETH and nothing ever funds it |
| **Pimlico public bundler** | ERC-4337 EntryPoint v0.8 on Arbitrum. Keyless on purpose — a static app has nowhere to keep a secret |
| **Nym mixnet** | the one arrangement that makes a browser page private by itself. 18 MB of WASM, kept in its own lazy chunk |
| **viem 2.57** | EIP-7702 support. Pinned, like everything else |
| **React 18 · Vite · TypeScript (strict)** | static output, no server |
| **IndexedDB** | sessions survive a reload, which matters when money is in flight against a deadline nobody set |
| **WebCrypto · WebAuthn PRF** | key derivation and the vault, with a passphrase fallback because Tor Browser often has no passkey |

### Design decisions worth knowing

- **The reducer is pure and the session is persisted after every transition.**
  A reload mid-swap leaves real money in flight; recovery cannot depend on
  anything held in memory.
- **Every externally visible effect is journaled before it runs**, written
  unconfirmed first. A crash mid-flight reads as "attempted, unconfirmed"
  rather than vanishing, and a retry reconciles against the world instead of
  sending the ZEC twice.
- **No key is reused across sessions.** Reuse joins two sessions, which
  defeats the product.
- **The exit is gated before it is quoted.** Asking a solver for a quote is
  itself a signal, so a random 10–90 minute delay runs first.
- **A capability must never claim more than the code does.** `payGas` and
  `gasIsPrivate` are separate, because paying in ETH *works* and merely costs
  unlinkability.
- **Amounts are bigint in the asset's smallest unit.** ZEC has 8 decimals and
  USDC 6; a float here is lost money.

---

## Four bugs found by running it for real

All four were invisible to a fully green test suite, because each concerns
what a venue *accepts* rather than what the code builds — and a mock accepts
whatever it is handed.

| Bug | Consequence if unfixed |
| --- | --- |
| `confidentiality: 'basic'` sent on quotes | `400 Error saving a quote to DB`, 3/3. **No session could start at all** |
| `sendTx` posted as JSON | `400 invalid param`, 3/3. **Every write refused** — orders, withdrawals, key registration |
| `cancelAllOrders` sent a timestamp | `CancelAllTime should be nil`. **Cannot flatten before withdrawing** |
| `withdrawalStatus` threw on a not-yet-indexed tx | a successful withdrawal reads as failed, and **the retry withdraws twice** |

Each is fixed with a regression test encoding the venue's real behaviour.

---

## Continuing

Two findings from this work belong upstream. Both are recorded in
[`docs/noir-provider.md`](docs/noir-provider.md), verified against the shipped
`[Testnet] Noir Wallet v1.0.41` bundle by loading the extension and reading
the injected object:

1. The SDK documents `getTransactionHistory()` with **no RPC method behind
   it** — it is absent from the extension's own allow-list.
2. The documented surface is the **SDK wrapper**, not the provider. The
   extension exposes only an EIP-1193 `request()`, so a dApp written from the
   documentation throws on a real send. This adapter was wrong about it twice
   before the bundle was read directly.

### Next 30 days

- File the Noir issue covering both findings above.
- **Integrate further venues.** The adapter interface in
  [`src/adapters/types.ts`](src/adapters/types.ts) was written so a venue is
  one implementation behind one interface, each with a mock. Adding a second
  perps venue and spot DEX routing is the test of whether that shape holds,
  and it widens where a session can go without widening what anyone learns
  about it.
- **Put it in front of beta users.** The mechanism is proven and the demand
  is not, which is the honest gap in this README. A small group of people who
  already trade perps and already hold ZEC, watched through a first session,
  answers questions no amount of further building will: whether the vault
  step is understood, whether the exit delay is tolerable, and whether the
  manual Zcash send is a wall or a shrug.
- **Security-test the whole flow.** The parts that would hurt are known and
  specific: key derivation and the vault, the journal that is supposed to make
  every effect safe to repeat, the checker that gates each movement, and the
  hash pinning on a WebAssembly signer fetched at runtime. Each needs
  adversarial testing rather than the unit tests it has now — a crash injected
  at every journal point, a tampered signer, a checker asked to approve a
  movement it should refuse. The privacy claims need a reader who is trying to
  break them, not confirm them.
- Run `/gate` against a live Nym tunnel and record which venues accept mixnet
  traffic.
- Publish the complete round trip end to end with its transaction hashes.

---

## Running it

```bash
pnpm install
pnpm fetch:signer   # REQUIRED before build: public/lighter/ is gitignored
pnpm test           # 333 tests, no network
pnpm dev            # landing at /, session at /app, venue gate at /gate
pnpm build          # → dist/, static files
```

Configuration is documented in [`.env.example`](.env.example). Leave a value
out and the movement that needs it refuses with a reason, which is intended
rather than a failure.

Routing is by path, so a static host must fall back to `index.html`.
`public/_redirects` covers Netlify and Cloudflare Pages.

## Licence

See [LICENSE](LICENSE).
