# The Noir wallet provider, as it actually is

Verified against the shipped `[Testnet] Noir Wallet v1.0.41` bundle by loading
the extension and inspecting the injected object — not against the SDK
documentation, which describes a wrapper rather than the wallet.

This file exists because `src/adapters/noir/index.ts` has been wrong about
this provider twice. The first version probed `window.noir ?? window.zcash`
for `getNewAddress`/`send`; neither the names nor the object were real. The
second coded against `connect()`, `sendTransaction()` and `getAccounts()`,
which belong to `@noir-wallet/sdk` and do not exist on the extension. Both
would have thrown on a real send.

## 1. What the real extension exposes

Loaded the extension in Chromium and inspected the injected object on a page:

```
window.noirwallet.zcash → { request, on, removeListener, disconnect }

typeof zcash.sendTransaction        → undefined
typeof zcash.getAccounts            → undefined
typeof zcash.connect                → undefined
typeof zcash.getBalance             → undefined
typeof zcash.getTransactionHistory  → undefined
```

It is an **EIP-1193-style provider**. The named methods in the SDK
documentation (`connect()`, `sendTransaction()`, `getAccounts()`) belong to
the `@noir-wallet/sdk` **wrapper**, which maps them onto `request()`. The
wallet itself has none of them.

This is the second time this file has been wrong about the provider. It
originally probed `window.noir ?? window.zcash` for `getNewAddress`/`send`.
Neither the names nor the object were real then either.

## 2. The authoritative method list

Extracted from the extension's own allow-list in the shipped bundle:

```
zcash_requestAccounts   zcash_getAccounts    zcash_getAddresses
zcash_getBalance        zcash_getMaxTransfer zcash_getPublicKey
zcash_sendTransaction   zcash_signMessage    zcash_shieldFunds
zcash_switchNetwork     zcash_disconnect     zcash_checkLendingMcaAccount
```

Dispatch is positional, one object:

```js
// from the bundle's own handler
case "zcash_sendTransaction": return this.sendTransaction(origin, t.params?.[0])
case "zcash_getBalance":      return this.getBalance(origin, t.params?.[0]?.accountId)
case "zcash_signMessage":     return this.signMessage(origin, t.params?.[0], t.params?.[1])
```

Send payload destructured in the bundle as
`{ walletId, accountId, to, amount, memo, fundingSource = "shielded", marginalFeeZats, feeQuoteId }`,
with the memo put through `new TextEncoder()` — so the 512 limit is **bytes**.

## 3. There is no transaction history, at all

**No history method exists in the allow-list or anywhere in the bundle.** The
SDK documents `getTransactionHistory()`; nothing backs it on this build.

So a page cannot learn whether a transaction it broadcast was mined. Make
`history()` **throw a stated reason**. Do not return an empty list: an empty
history reads as "not mined yet" and becomes a permanent "broadcast" that
nothing ever resolves. Also stop the poll once it has thrown, rather than
asking again every twenty seconds for the life of the page.

The txid is still valid submission evidence. Mining gets verified on the
explorer, not in the app.

## 4. The working implementation

It is already written and tested in
`/home/jiojohny/Desktop/private-perps/src/adapters/noir/index.ts`
(331 tests green). Port that file and the matching `test/noir.test.ts`.
The shape:

- `injected()` returns the provider only when `typeof found.request === 'function'`.
- An `RPC` constant holds the four method names actually used.
- **`pickShielded(reply, network)`** walks a reply structurally and returns the
  first string that is a shielded address on that network. The reply shape is
  not published, so matching a field name would be the same guess that put
  `getNewAddress` in this file. An address carries its network in its prefix,
  so the key it arrives under does not matter. It guards against self-
  referencing replies.
- **`findTxid(reply)`** does the same for a 64-hex id, so the reply may be the
  id itself or an object carrying it.
- `freshReceiveAddress()` tries `zcash_getAccounts`, then `zcash_requestAccounts`.
  If neither yields an address **on this network**, it looks for one on the
  *other* network and throws `NotShieldedError` naming both — because mainnet
  and testnet ship as separate extensions, a page cannot ask which it is
  talking to, and "you have the wrong build installed" is both the likeliest
  cause and far more useful than "no address".
- `connect()` is `zcash_requestAccounts` and needs a user gesture — button
  press, never a render.
- `connectedAddress()` is `zcash_getAccounts` only and **never falls back to
  requestAccounts**, so it is safe to call on mount to restore a connection.
- `send()` passes `fundingSource: 'shielded'` explicitly rather than relying
  on the default, checks the memo in UTF-8 bytes, and refuses a reply with no
  valid 64-hex txid instead of returning `'unknown'`.
- `balance()` prefers `available` over `total` and refuses when `synced` is
  `false` — that zero is a sync placeholder, not an empty wallet.

`chooseNoir` must no longer probe for a `sendTransaction` method. With a
single `request` entry point, which RPCs will be answered is not knowable in
advance; a page finds out by asking. Take the extension whenever a `request`
provider is present, and keep the stated reason about address rotation.

## 5. Keep this caveat

Noir has **no rotate-address call** anywhere in its method list. The exit
lands on the account's primary shielded address, so a second session on the
same address links the two. Address rotation is this product's unit of
unlinkability, so this is a real limitation. `chooseNoir` returns the
extension path *with that reason attached* — keep it. It is also exactly what
the hackathon's "Private" criterion rewards: being honest about what leaks
and who must be trusted.

## 6. Two upstream findings worth filing

Both came out of this work and both are genuine:

1. The SDK documents `getTransactionHistory()` with no RPC method behind it.
2. The provider surface is `request`-based; the docs describe only the wrapper,
   so a dApp written from the docs fails against the extension.

One issue on `NoirWallet/noir-wallet` covers both. That is the hackathon's
"Continuing" criterion, which is also the first tie-break.

## 8. Operational note

`VITE_ZCASH_NETWORK` is read at **build** time and folded in. Passing it to
`vite preview` silently gives a mainnet page. Build with
`VITE_ZCASH_NETWORK=test pnpm build`.

The verified testnet extension is unpacked at
`/home/jiojohny/Desktop/noir-testnet-wallet/extension` — SHA-256 checked
against the published `SHA256SUMS`, manifest reads `[Testnet] Noir Wallet`
v1.0.41.
