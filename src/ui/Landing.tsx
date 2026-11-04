import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Route } from './router'

/**
 * The landing page.
 *
 * Direction: "The product performs" (tasteskill seed 18749665). The idea:
 * the checker's refusal is the hero. Every picture on this page is a real
 * fragment of the product, built in HTML at interface size and marked
 * data-ui, because the subject is software and has no photographs.
 *
 * The rule names, messages and remedies below are the ones in
 * src/core/checker.ts. They are not marketing copy and should be changed
 * there, not here.
 */

const REPO = 'https://github.com/hyliv-labs/private-perps-testing-zec-standard'

/* ------------------------------------------------------------ the live thing */

interface Condition {
  readonly id: string
  readonly label: string
  /** The rule that fires when this condition is false. */
  readonly rule: string
  readonly severity: 'block' | 'warn'
  readonly message: string
  readonly remedy: string
}

const CONDITIONS: readonly Condition[] = [
  {
    id: 'network',
    label: 'Over Tor or Nym',
    rule: 'private_network',
    severity: 'block',
    message: 'Outbound requests are going out over the clear network.',
    remedy: 'Your IP would link the Zcash deposit to the Lighter account.',
  },
  {
    id: 'address',
    label: 'Fresh exit address',
    rule: 'fresh_exit_address',
    severity: 'block',
    message: 'This shielded address has already received an exit.',
    remedy: 'Ask the wallet to rotate before withdrawing.',
  },
  {
    id: 'delay',
    label: 'Delay elapsed',
    rule: 'exit_delay_elapsed',
    severity: 'block',
    message: 'The exit delay has 37 minutes left.',
    remedy: 'Exiting now ties the exit to the entry by timing alone.',
  },
  {
    id: 'amount',
    label: 'Exit amount varied',
    rule: 'amount_fingerprint',
    severity: 'warn',
    message: 'The exit amount equals the entry amount exactly.',
    remedy: 'An observer can pair the two legs by value.',
  },
]

function Checker({ compact = false }: { compact?: boolean }) {
  const [met, setMet] = useState<Record<string, boolean>>({
    network: false,
    address: true,
    delay: true,
    amount: true,
  })

  const findings = CONDITIONS.filter((c) => !met[c.id])
  const blocked = findings.some((f) => f.severity === 'block')
  const shown = compact ? CONDITIONS.slice(0, 2) : CONDITIONS

  return (
    <div data-ui>
      <div className="ui-head">
        <span className="ui-title">Checker</span>
        <span className={`ui-verdict ${blocked ? 'block' : 'pass'}`}>
          {blocked ? 'Blocked' : findings.length ? 'Passed with a warning' : 'Passed'}
        </span>
      </div>

      <div className="switches">
        {CONDITIONS.map((c) => (
          <button
            key={c.id}
            type="button"
            className="switch"
            aria-pressed={met[c.id] ? 'true' : 'false'}
            onClick={() => setMet((prev) => ({ ...prev, [c.id]: !prev[c.id] }))}
          >
            {c.label}
          </button>
        ))}
      </div>

      {/* The real checker runs every rule and reports each one, so the panel
          shows all four rather than only the ones that fired. */}
      {shown.map((c) => {
        const failed = !met[c.id]
        const verdict = !failed ? 'Pass' : c.severity === 'block' ? 'Stop' : 'Warn'
        return (
          <div className="ui-rule" key={c.rule} data-failed={failed}>
            <span className={`ui-verdict ${failed && c.severity === 'block' ? 'block' : 'pass'}`}>
              {verdict}
            </span>
            <span className="ui-rule-name">
              {failed ? c.message : c.rule.replace(/_/g, ' ')}
              <span className="ui-rule-why">
                {failed ? c.remedy : 'Nothing here would link this session.'}
              </span>
            </span>
          </div>
        )
      })}

      <p className="ui-foot">
        Four of the eight rules. The other four run on the session&rsquo;s key and its
        dust.
      </p>
    </div>
  )
}

/* ------------------------------------------------------ fragments of the app */


function SwapRows() {
  return (
    <div data-ui>
      <div className="ui-head">
        <span className="ui-title">Inbound swap</span>
        <span className="ui-meta">1Click</span>
      </div>
      <div className="ui-row"><span>Sent</span><span>1.00000000 ZEC</span></div>
      <div className="ui-row"><span>Quoted</span><span>1,227.04 USDC</span></div>
      <div className="ui-row"><span>Fee</span><span>0.20%</span></div>
      <div className="ui-row"><span>Refunds at</span><span>in 1h 52m</span></div>
      <div className="ui-row"><span>Refunds to</span><span>your shielded address</span></div>
    </div>
  )
}

function OrderTicket() {
  return (
    <div data-ui>
      <div className="ui-head">
        <span className="ui-title">ETH-PERP</span>
        <span className="ui-meta">Lighter · 0 / 0 fees</span>
      </div>
      <div className="ui-row"><span>Side</span><span>Long</span></div>
      <div className="ui-row"><span>Size</span><span>0.38 ETH</span></div>
      <div className="ui-row"><span>Entry</span><span>3,118.40</span></div>
      <div className="ui-row"><span>Unrealised</span><span>+18.90 USDC</span></div>
      <button className="ui-primary" type="button" tabIndex={-1} aria-hidden="true">
        Close position
      </button>
    </div>
  )
}

function ClosedRows() {
  return (
    <div data-ui>
      <div className="ui-head">
        <span className="ui-title">Session</span>
        <span className="ui-verdict pass">Closed</span>
      </div>
      <div className="ui-row"><span>Came back as</span><span>1.02 ZEC</span></div>
      <div className="ui-row"><span>Sent to</span><span>a rotated address</span></div>
      <div className="ui-row"><span>Key index 7</span><span>retired</span></div>
      <div className="ui-row"><span>Dust left behind</span><span>0.41 USDC</span></div>
      <div className="ui-row"><span>Swept</span><span>never</span></div>
    </div>
  )
}


/* ----------------------------------------------------------- past sessions
   Sample data, shaped the way the product's own records are: the key index
   only ever goes up, and no exit address is ever used twice. */

interface SessionRow {
  readonly index: number
  readonly inAmount: string
  readonly outAmount: string
  readonly status: 'Closed' | 'Refunded' | 'Trading'
  readonly detail: string
}

const SESSIONS: readonly SessionRow[] = [
  { index: 0, inAmount: '2.50', outAmount: '2.54', status: 'Closed',
    detail: 'Two orders, forty minutes. Retired.' },
  { index: 1, inAmount: '12.00', outAmount: '11.86', status: 'Closed',
    detail: 'Came out behind by the solver spread.' },
  { index: 2, inAmount: '5.00', outAmount: '5.00', status: 'Refunded',
    detail: 'The deposit arrived after the two-hour deadline, so it went back to the shielded address it came from. Nothing reached the venue.' },
  { index: 3, inAmount: '20.00', outAmount: '20.31', status: 'Closed',
    detail: 'Key 03 signed eleven orders over four hours and was then retired. Its exit address has received nothing since, and 0.62 USDC of dust stays in the wallet because collecting it would join this session to the next.' },
  { index: 4, inAmount: '8.00', outAmount: '8.12', status: 'Closed',
    detail: 'Exit held ninety minutes before the swap went out.' },
  { index: 5, inAmount: '1.00', outAmount: '1.00', status: 'Refunded',
    detail: 'Below the solver minimum. Returned untouched.' },
  { index: 6, inAmount: '15.00', outAmount: '14.77', status: 'Closed',
    detail: 'Two positions, both closed before the exit.' },
  { index: 7, inAmount: '10.00', outAmount: '\u2014', status: 'Trading',
    detail: 'Open now. The exit address is already rotated and waiting.' },
]

/* ---------------------------------------------------------- the eight rules */

const RULES: readonly { name: string; says: string }[] = [
  { name: 'fresh_session_key', says: 'A key that signed before cannot sign again.' },
  { name: 'fresh_exit_address', says: 'An address that received before cannot receive again.' },
  { name: 'shielded_refund', says: 'A refund may not land on a transparent address.' },
  { name: 'exit_delay_elapsed', says: 'The exit waits out its delay first.' },
  { name: 'private_network', says: 'No money moves over the clear network.' },
  { name: 'deadline_sane', says: 'A swap window that is too wide or too short is flagged.' },
  { name: 'amount_fingerprint', says: 'Leaving with exactly what you brought is flagged.' },
  { name: 'no_dust_sweep', says: 'Residue in a retired wallet is never collected.' },
]

/* ------------------------------------------------------------------- helpers */

function Arrow() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor"
      strokeWidth="2" aria-hidden="true" focusable="false">
      <path d="M4 11h14M12 5l6 6-6 6" />
    </svg>
  )
}

/** Marks children as seen once, for the section entrance. */
function useSeen<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  useEffect(() => {
    const root = ref.current
    if (!root) return
    const items = [...root.querySelectorAll('.enter')]
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add('seen')
            io.unobserve(e.target)
          }
        }
      },
      { rootMargin: '0px 0px -12% 0px' },
    )
    for (const item of items) io.observe(item)
    return () => io.disconnect()
  }, [])
  return ref
}

function go(navigate: (to: Route) => void, to: Route) {
  return (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
    event.preventDefault()
    navigate(to)
  }
}

/* ---------------------------------------------------------------- the page */

export function Landing({ navigate }: { navigate: (to: Route) => void }) {
  const root = useSeen<HTMLDivElement>()
  const [step, setStep] = useState(0)
  const [amount, setAmount] = useState('1')
  const [openRow, setOpenRow] = useState(3)
  const [notional, setNotional] = useState(1000)

  const statements = useRef<(HTMLDivElement | null)[]>([])

  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue
          const index = statements.current.indexOf(e.target as HTMLDivElement)
          if (index >= 0) setStep(index)
        }
      },
      { rootMargin: '-45% 0px -45% 0px' },
    )
    for (const el of statements.current) if (el) io.observe(el)
    return () => io.disconnect()
  }, [])

  /* Two swaps at 0.20% each, the paymaster's gas, and Lighter's fast
     withdrawal fee. The solver's spread on Zcash is not in here,
     because it has not been measured yet. */
  const cost = useMemo(() => {
    const swaps = notional * 0.004
    const gas = 1
    const withdrawal = 1
    return Math.round(swaps + gas + withdrawal)
  }, [notional])

  const start = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault()
      navigate('/app')
    },
    [navigate],
  )

  const stageFragments = [<SwapRows key="a" />, <OrderTicket key="b" />, <ClosedRows key="c" />]

  // data-motion is set here in the render, not in an effect: set it
  // afterwards and the first paint shows the content, which then snaps to
  // hidden before animating. The page is client-rendered, so if the script
  // never runs there is nothing to reveal in the first place.
  return (
    <div className="page" data-motion="on" ref={root}>
      <section className="hero">
        <div className="hero-bar">
          <a className="hero-mark" href="/" onClick={go(navigate, '/')}>
            Private Perps
          </a>
          <a className="hero-enter" href="/app" onClick={go(navigate, '/app')}>
            Open a session
          </a>
        </div>

        <div className="hero-body">
          <div className="hero-column">
            <h1 className="enter">Perps nobody can link to you.</h1>
            <p className="enter d1">
              Shielded Zcash in, perpetual futures on Lighter, shielded Zcash back out.
              The app runs on your device and stops itself when a move would give you away.
            </p>
            <div className="hero-actions enter d2">
              <a className="action" href="/app" onClick={go(navigate, '/app')}>
                Start a session
              </a>
              <a className="textlink" href="#rules">
                See the eight rules <Arrow />
              </a>
            </div>
          </div>

          <figure className="hero-fragment enter d3">
            <Checker />
            <figcaption>
              This is the checker that ships, with four of its eight rules. Turn a
              condition off and it refuses the movement, naming the rule.
            </figcaption>
          </figure>
        </div>
      </section>

      <section className="showcase" aria-labelledby="sessions-head">
        <h2 id="sessions-head">Eight sessions, no two alike</h2>
        <div className="sessions" data-ui>
          {SESSIONS.map((row) => (
            <div
              className={`srow${row.index === openRow ? ' open' : ''}`}
              key={row.index}
              role="button"
              tabIndex={0}
              aria-expanded={row.index === openRow}
              onClick={() => setOpenRow(row.index)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  setOpenRow(row.index)
                }
              }}
            >
              <span className="srow-name">Key {row.index}</span>
              <span className="srow-fact">{row.inAmount} ZEC in</span>
              <span className="srow-fact">{row.outAmount} ZEC out</span>
              <span className={`srow-status ${row.status.toLowerCase()}`}>{row.status}</span>
              {row.index === openRow && <p className="srow-detail">{row.detail}</p>}
            </div>
          ))}
        </div>
      </section>

      <section className="pinned" aria-labelledby="session">
        <h2 id="session">One session, start to finish</h2>

        <div className="statements">
          {[
            {
              head: 'Send shielded Zcash.',
              body: 'It goes to a swap address and comes back as dollars in a wallet that has never been used before. Two hours to arrive, then it refunds itself.',
            },
            {
              head: 'Trade.',
              body: 'The wallet opens a Lighter account and pays its gas in dollars, so it never needs a funding history. The venue sees an account and no person.',
            },
            {
              head: 'Leave by a new door.',
              body: 'Positions close, the balance waits out a delay of up to ninety minutes, and the Zcash returns to an address the wallet has just rotated to.',
            },
          ].map((s, i) => (
            <div
              className="statement enter"
              key={s.head}
              data-active={step === i}
              ref={(el) => {
                statements.current[i] = el
              }}
            >
              <h3>{s.head}</h3>
              <p>{s.body}</p>
            </div>
          ))}
        </div>

        <div className="stage" aria-hidden="true">{stageFragments[step]}</div>
      </section>

      <section className="record" aria-labelledby="record-head">
        <h2 id="record-head">An account is a card in a drawer</h2>
        <div className="record-say">
          <p className="enter d1">
            Every exchange account you have ever opened is a record with your name on
            it, filed where someone else decides who may read it. This one is a key
            that signs a few orders and is then thrown away.
          </p>
        </div>
        <figure className="enter d2">
          <img
            src="/record.jpg"
            width={1920}
            height={1280}
            alt="An open drawer of a library card catalogue, its cards filed alphabetically behind a brass label."
            loading="lazy"
            decoding="async"
          />
          <figcaption>
            The alphabetical main catalogue, 1973 to 2005, at the National Archives of
            Finland.
          </figcaption>
        </figure>
      </section>

      <section className="board" id="rules" aria-labelledby="rules-head">
        <div className="tile heading">
          <h2 id="rules-head">Eight rules</h2>
          <p>Each one stops a money movement and says which it was.</p>
        </div>
        {RULES.map((r, i) => (
          <div className={`tile enter${i === 2 || i === 5 ? ' wide' : ''}`} key={r.name}>
            <h3>{r.name.replace(/_/g, ' ')}</h3>
            <p>{r.says}</p>
          </div>
        ))}
      </section>

      <section className="cost" aria-labelledby="cost-head">
        <div className="enter">
          <h2 id="cost-head">What does a session cost?</h2>
        <div className="cost-control">
          <div data-ui>
            <div className="ui-head">
              <span className="ui-title">Amount</span>
              <span className="ui-meta">{notional.toLocaleString('en-US')} USDC</span>
            </div>
            <label htmlFor="notional" className="ui-rule-why">
              What you put in
            </label>
            <input
              id="notional"
              type="range"
              min={250}
              max={25000}
              step={250}
              value={notional}
              onChange={(e) => setNotional(Number(e.target.value))}
            />
          </div>
        </div>

          <p className="cost-working">
            Two swaps at 0.20% each, about a dollar of gas, and Lighter&rsquo;s one-dollar
            fast withdrawal. The solver&rsquo;s spread on Zcash is not in this figure,
            because it has not been measured yet.
          </p>
        </div>

        <p className="cost-figure enter d1">
          <b>{cost}</b>
          <span>USDC</span>
        </p>
      </section>

      <section className="faq" aria-labelledby="faq-head">
        <div className="faq-side">
          <h2 id="faq-head">Before you start</h2>
          <figure className="enter d1">
            <img
              src="/passbook.jpg"
              width={1920}
              height={1460}
              alt="Two pages of a savings passbook from 1912, the depositor's surname written at the head of each page and every movement dated and stamped."
              loading="lazy"
              decoding="async"
            />
            <figcaption>
              A savings passbook, 1912 to 1916. The surname is at the top of every page.
            </figcaption>
          </figure>
        </div>
        <div className="faq-list">
          {[
            {
              q: 'What can Lighter still see?',
              a: 'Every trade you make, and an account with no history making them. It does not see who funded that account or where the money went afterwards. That is the whole of what this buys you.',
            },
            {
              q: 'What can the swap solver see?',
              a: 'That an amount of Zcash became an amount of dollars. It does not see the trading in between, and it never learns the two sides belong to one person unless the amounts or the timing say so.',
            },
            {
              q: 'So what gives me away?',
              a: 'Leaving with exactly what you brought, exiting the moment you withdraw, reusing an address, or running without Tor. Those are four of the eight rules, and each one stops the movement rather than warning you afterwards.',
            },
            {
              q: 'Do you hold my funds?',
              a: 'No. There is no server, no account and no password to reset. The keys are encrypted on your device and the page is static files.',
            },
            {
              q: 'What happens if I close the tab?',
              a: 'Reopen it. Each step is written down before it is attempted, so the app works out what already happened instead of repeating it. A swap that runs out of time refunds to your shielded address.',
            },
            {
              q: 'Is it audited?',
              a: 'No. It is a hackathon build with real money at stake. Read the code before you trust it with an amount you would miss.',
            },
          ].map((item) => (
            <details key={item.q} name="faq" className="enter">
              <summary>
                {item.q}
                <span className="plus" aria-hidden="true" />
              </summary>
              <p>{item.a}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="start" aria-labelledby="start-head">
        <h2 id="start-head" className="visually-hidden">Start a session</h2>
        <form onSubmit={start} className="enter">
          <span>Start a session with</span>
          <input
            type="text"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            aria-label="Amount of Zcash to trade"
            placeholder="1"
          />
          <span>ZEC.</span>
          <button type="submit">Start</button>
        </form>
        <p className="start-note enter d1">
          Nothing moves until you approve it, and the checker runs before every movement.
        </p>
      </section>

      <footer className="foot">
        <div className="foot-say enter">
          <p>The only number we can read is the total everyone trades.</p>
          <p className="foot-legal">Apache-2.0. No analytics and no third-party requests.</p>
        </div>
        <nav className="foot-nav enter d1" aria-label="Footer">
          <ul>
            <li><a href="#rules">The eight rules</a></li>
            <li><a href="#faq-head">Before you start</a></li>
            <li><a href={REPO} rel="noreferrer noopener" target="_blank">Source</a></li>
          </ul>
        </nav>
        <div className="foot-number enter d2">
          <b>None yet</b>
          <span>Traded through Private Perps. Updated daily.</span>
        </div>
        <div className="foot-credit enter d3">
          <p>
            Pictures:{' '}
            <a
              href="https://commons.wikimedia.org/wiki/File:Kansallisarkisto_Helsinki_Rauhankatu_17_luettelohuone_kortistokaappi_2026_02_23.jpg"
              rel="noreferrer noopener"
              target="_blank"
            >
              the catalogue
            </a>{' '}
            by Fuje23, CC BY-SA 4.0, and{' '}
            <a
              href="https://commons.wikimedia.org/wiki/File:%D0%9A%D0%BD%D0%B8%D0%B6%D0%BA%D0%B0_%D1%81%D0%B1%D0%B5%D1%80%D0%B5%D0%B3%D0%B0%D1%82%D0%B5%D0%BB%D1%8C%D0%BD%D0%B0%D1%8F_%D0%BF%D0%BE%D1%87%D1%82%D0%BE%D0%B2%D0%BE-%D1%82%D0%B5%D0%BB%D0%B5%D0%B3%D1%80%D0%B0%D1%84%D0%BD%D0%BE%D0%B9_%D0%B3%D0%BE%D1%81%D1%83%D0%B4%D0%B0%D1%80%D1%81%D1%82%D0%B2%D0%B5%D0%BD%D0%BD%D0%BE%D0%B9_%D1%81%D0%B1%D0%B5%D1%80%D0%B5%D0%B3%D0%B0%D1%82%D0%B5%D0%BB%D1%8C%D0%BD%D0%BE%D0%B9_%D0%BA%D0%B0%D1%81%D1%81%D1%8B._%D0%A1._2%E2%80%933--moneymuseum-by.jpg"
              rel="noreferrer noopener"
              target="_blank"
            >
              the passbook
            </a>
            , public domain, both via Wikimedia Commons.
          </p>
        </div>
        <div className="foot-name enter">Private Perps</div>
        <a className="foot-go enter d1" href="/app" onClick={go(navigate, '/app')}>
          <span>Open a session</span>
          <Arrow />
        </a>
      </footer>
    </div>
  )
}
