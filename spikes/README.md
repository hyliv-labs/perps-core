# Spikes

Each spike settles one dependency the architecture doc lists as **still open**.
Any of them can invalidate the fund flow, so run them before building further
on the happy path.

They are deliberately not part of the app: throwaway scripts, real money,
run by hand.

| Spike | Settles | Budget |
| --- | --- | --- |
| `01-1click-quote.ts` | 1Click quote shapes, ZEC minimums, deadline window | free (quote only) |
| `02-noir-send.ts` | Whether a dApp can make Noir send to an external transparent address | ~$20 |
| `03-paymaster-7702.ts` | Circle Paymaster + EIP-7702 paying gas in USDC on Arbitrum | ~$5 |
| `04-lighter-roundtrip.ts` | Browser-side signing, API key registration, fast-withdrawal fee | ~$10 |

## Running

Copy `.env.example` to `.env` and fill in what each spike needs, then:

```bash
pnpm spike spikes/01-1click-quote.ts
```

`01` costs nothing and touches no funds — start there.

## Recording the result

Each spike prints a block headed `RESULT`. Paste it into the architecture doc's
**External dependencies** table, in the "Still open" column, with the date.
A spike that fails is as useful as one that passes: say which, and why.
