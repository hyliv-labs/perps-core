# Brand — Private Perps (Coldtrail)

_Status: active. Derived from the agreed landing-page design, not from a
generated palette._

## Voice

Plain, concrete, slightly severe. The product's claim is negative — what
nobody can see — so the copy states limits rather than promises. No
exclamation marks, no "revolutionary", no emoji.

- Say "no one can link these accounts to you", not "ultimate privacy".
- Name the thing that would break the claim, in the same breath as the claim.
- Numbers carry units and an as-of date. A figure without a source is a claim.

## Palette

Near-black, cool-tempered greys, one mint accent. Dark only: a light theme
would undercut the product's register, and there is no theme switch.

| Token | Value | Used for |
| --- | --- | --- |
| `--bg` | `#0b0d10` | page background |
| `--panel` | `#14181d` | cards, nav |
| `--panel-raised` | `#1a1f26` | hover, elevated surfaces |
| `--line` | `#242a31` | 1px borders, dividers |
| `--text` | `#e7ecf1` | body text (13.9:1 on `--bg`) |
| `--muted` | `#8b97a5` | secondary text (6.6:1 on `--bg`) |
| `--faint` | `#5a6472` | redacted/placeholder text, decorative only |
| `--accent` | `#5ad1a0` | the single accent: CTA, active state, shield |
| `--accent-ink` | `#06130d` | text on `--accent` |
| `--warn` | `#e0b341` | checker warnings only |
| `--block` | `#e0614a` | checker blocks and errors only |

One accent. `--warn` and `--block` are semantic, reserved for the checker;
never decorative.

## Typography

Monospace throughout, from the system stack — no Google Fonts, no webfont
request. Every request the page makes should be one a user can account for.

```
ui-monospace, "SF Mono", Menlo, Consolas, monospace
```

| Role | Size | Treatment |
| --- | --- | --- |
| Display (volume figure) | `clamp(2.5rem, 8vw, 4.5rem)` | 700, `tabular-nums` |
| Page heading | 20px | 500, `0.02em` |
| Section label | 13px | uppercase, `0.08em`, `--muted` |
| Body | 15px | 400, line-height 1.55 |
| Caption | 13px | 400, `--muted` |

Figures that change use `tabular-nums` so digits do not jitter.

## Shape and motion

- Radius: 8px on cards and panels, 6px on buttons. No other values.
- 1px borders. Borders separate surfaces, not shadows — flat, not floating.
- Durations: 100ms for hover and focus feedback, 150ms for enter, 200ms for
  larger changes. Nothing over 250ms.
- `ease-out` entering, `ease-in` leaving.
- Transitions name their properties. Never `transition: all`.
- Everything non-essential is off under `prefers-reduced-motion: reduce`.

## Tokens live in

`src/ui/styles.css`, on `:root`. Nothing hardcodes a hex outside that file.
