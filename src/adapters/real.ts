import type { Account } from 'viem'
import type { Logger } from '@/core/log'
import type { EvmAddress, ZcashNetwork } from '@/core/types'
import type { Adapters, NetworkAdapter } from './types'
import { createOneClickAdapter } from './near1click/http'
import { createLighterAdapter } from './lighter/http'
import { createWasmSigner } from './lighter/wasm-signer'
import { PAYMASTER_SEND_READY, createCirclePaymasterGas, createEthGas } from './paymaster'
import { chooseNoir, type ManualPrompts } from './noir'

/**
 * The real adapters, assembled.
 *
 * Until now every real adapter existed and was tested on its own, and nothing
 * put them together — the app ran on mocks end to end. This is the seam
 * between a set of verified components and an application.
 *
 * What it does NOT do is paper over the pieces that are not ready. Each
 * adapter already refuses loudly when its dependency is missing: the Lighter
 * signer, the bundler, the Noir extension. This assembles them as they are
 * and reports, in one place, exactly which movements will work and which will
 * be refused. A demo that quietly swaps in a mock halfway through is worse
 * than one that says what it cannot do.
 */

export interface RealOptions {
  readonly network: NetworkAdapter
  readonly logger: Logger
  /**
   * The session's own key, and the chain it signs for.
   *
   * Required, and that is a real constraint on the caller: the gas adapter
   * signs with the key of the session it belongs to, so a real assembly is
   * built per session rather than once for the app. The mock never minded,
   * which is how the app got this far without noticing.
   */
  readonly account: Account
  readonly rpcUrl: string

  /**
   * Which Zcash network this assembly is for. Defaults to mainnet.
   *
   * It reaches further than address checking: the venues on the other side
   * of the swap are mainnet-only, so this also decides whether a round trip
   * is possible at all. See `quoteSwap` below.
   */
  readonly zcashNetwork?: ZcashNetwork

  /** Raises the 1Click fee from 0.25% to 0.20%. */
  readonly oneClickJwt?: string

  /**
   * Derives this session's Lighter API key, on demand.
   *
   * A callback rather than a key, so the 40 bytes are produced only if a
   * signature is actually needed and can be wiped straight afterwards. It
   * is NOT the EVM key: Lighter's signer refuses anything but 40 bytes.
   */
  readonly lighterApiKey?: () => Promise<{ privateKeyHex: string; retire: () => void }>

  /** Where the pinned WASM artifacts are served from. */
  readonly signerBasePath?: string

  readonly bundlerUrl?: string
  readonly paymasterAddress?: EvmAddress
  readonly delegateAddress?: EvmAddress

  /** How the manual Noir path asks for an address and a txid. */
  readonly noirPrompts: ManualPrompts
  readonly preferManualNoir?: boolean

  readonly now?: () => number
}

/** What this assembly can actually do, named movement by movement. */
export interface Capabilities {
  readonly quoteSwap: Ready
  readonly sendZcash: Ready
  readonly readMarkets: Ready
  readonly placeOrder: Ready
  /**
   * Whether gas can be paid at all. One of the two strategies always can,
   * so this is about the transaction landing, not about who sees it.
   */
  readonly payGas: Ready
  /**
   * Whether paying for it costs the session its unlinkability.
   *
   * Split from `payGas` because they fail for different reasons and deserve
   * different answers. A session that cannot pay gas is stuck; a session
   * paying in ETH works perfectly and merely carries a link the user can
   * see and decide about. Rolling the two into one capability meant the
   * second one silently blocked Start, which is how this app reached a
   * state where no configuration could complete a round trip.
   */
  readonly gasIsPrivate: Ready
  readonly withdraw: Ready
}

export interface Ready {
  readonly ok: boolean
  /** Plain words for the UI. Present whether it is ready or not. */
  readonly why: string
}

export interface RealAdapters {
  readonly adapters: Adapters
  readonly capabilities: Capabilities
  /** 'extension' when a Noir Wallet answered, 'manual' when it did not. */
  readonly noirKind: 'extension' | 'manual'
  /**
   * The wallet this session will use, known before it starts.
   *
   * Surfaced so a screen can show it while gas is being paid in ETH: that
   * strategy needs the wallet funded first, and an address only revealed
   * once the session is running cannot be funded in time.
   */
  readonly sessionWallet: EvmAddress
}

const ready = (why: string): Ready => ({ ok: true, why })
const missing = (why: string): Ready => ({ ok: false, why })

export async function createRealAdapters(options: RealOptions): Promise<RealAdapters> {
  const { network, logger } = options

  const near = createOneClickAdapter({
    network,
    logger,
    ...(options.oneClickJwt ? { jwt: options.oneClickJwt } : {}),
    ...(options.now ? { now: options.now } : {}),
  })

  /*
   * Is the signer actually deployed?
   *
   * `public/lighter/` is gitignored — the 7.7 MB binary is fetched by
   * `pnpm fetch:signer`, not committed — so a deploy that skips that step
   * produces an app that looks ready and fails at the first write, with the
   * money already on Lighter. A capability that says "ready" because a
   * callback was passed would be reporting the configuration, not the world.
   *
   * The manifest is a few hundred bytes, so this asks for that rather than
   * pulling the binary on a screen nobody has pressed anything on yet. The
   * binary itself is hash-verified when it is first used.
   */
  const signerBasePath = options.signerBasePath ?? '/lighter'
  const signerDeployed = options.lighterApiKey
    ? await fetch(`${signerBasePath}/pin.json`)
        .then((r) => r.ok)
        .catch(() => false)
    : false

  const canSign = Boolean(options.lighterApiKey) && signerDeployed

  const lighter = createLighterAdapter({
    network,
    logger,
    ...(canSign && options.lighterApiKey
      ? {
          /*
           * Built per account, because Lighter's signing client is created
           * against an account index that does not exist until the deposit
           * has landed. That ordering is why nothing could ever pass a
           * ready-made signer, and why every write refused.
           */
          createSigner: async ({ accountIndex, apiKeyIndex }) => {
            const key = await options.lighterApiKey!()
            try {
              return await createWasmSigner({
                basePath: signerBasePath,
                accountIndex,
                apiKeyIndex,
                privateKey: key.privateKeyHex,
              })
            } finally {
              // The copy inside WASM is beyond reach; this one is not.
              key.retire()
            }
          },
          /*
           * Registering the API key needs the wallet that owns the account
           * to authorise it. The message is plain text, so personal_sign —
           * verified against the pinned binary, which returns a body
           * beginning "Register Lighter Account".
           */
          l1Sign: (message: string) => options.account.signMessage!({ message }),
        }
      : {}),
  })

  const zcashNetwork: ZcashNetwork = options.zcashNetwork ?? 'main'

  const noir = await chooseNoir({
    logger,
    network: zcashNetwork,
    prompts: options.noirPrompts,
    ...(options.preferManualNoir ? { preferManual: true } : {}),
  })

  /*
   * Gas has two real paths and no mock.
   *
   * With a bundler and a paymaster, the session pays its gas in USDC and
   * never holds ETH, which is the whole point. Without them it falls back to
   * paying in ETH, which works but means the wallet has to be funded with
   * ETH from somewhere — and wherever that somewhere is, it links the
   * session. The fallback is offered, and the cost of taking it is stated.
   */
  const paymasterConfigured = Boolean(
    options.bundlerUrl && options.paymasterAddress && options.delegateAddress,
  )
  /*
   * Configured is not the same as working. `PAYMASTER_SEND_READY` sits next
   * to `send()`, so the capability cannot get ahead of the code that builds
   * the user operation. A session that takes that path has no ETH to fall
   * back on once the Zcash is converted.
   */
  const canPaymaster = paymasterConfigured && PAYMASTER_SEND_READY
  const gas = canPaymaster
    ? createCirclePaymasterGas({
        network,
        logger,
        account: options.account,
        rpcUrl: options.rpcUrl,
        ...(options.bundlerUrl ? { bundlerUrl: options.bundlerUrl } : {}),
        ...(options.paymasterAddress ? { paymasterAddress: options.paymasterAddress } : {}),
        ...(options.delegateAddress ? { delegateAddress: options.delegateAddress } : {}),
      })
    : createEthGas({ network, logger, account: options.account, rpcUrl: options.rpcUrl })

  const capabilities: Capabilities = {
    /*
     * On testnet there is nothing on the other side of the swap. 1Click
     * prices mainnet assets, and the Lighter and Arbitrum endpoints here are
     * mainnet too, so a testnet deployment can hold shielded TAZ and go no
     * further. Reporting this as ready would be the capability claiming more
     * than the code does — and `quoteSwap` is not exempted in
     * `cannotRoundTrip`, so saying it plainly is also what stops a session
     * starting down a path with no end.
     */
    quoteSwap:
      zcashNetwork === 'test'
        ? missing(
            'NEAR 1Click has no Zcash testnet, and the Lighter and Arbitrum endpoints are ' +
              'mainnet, so no round trip can run on testnet.',
          )
        : ready('1Click quotes and deposit addresses are live.'),
    sendZcash:
      noir.kind === 'extension'
        ? ready('A Noir Wallet answered and will send the shielded deposit.')
        : missing(
            noir.reason ??
              'No Noir Wallet is installed, so the shielded send has to be made by hand.',
          ),
    readMarkets: ready("Lighter's book, trades, candles and account reads are live."),
    placeOrder: canSign
      ? ready('Lighter orders will be signed by the pinned WASM signer.')
      : missing(
          options.lighterApiKey
            ? `The Lighter signer is not deployed at ${signerBasePath}, so orders will be refused. Run \`pnpm fetch:signer\` — public/lighter is not in git.`
            : 'No Lighter API key is available, so orders will be refused.',
        ),
    payGas: canPaymaster
      ? ready('Gas is paid in USDC through the paymaster.')
      : ready(
          `Gas is paid in ETH by the session wallet ${options.account.address}. Send it about a dollar of ETH on Arbitrum. The balance is not read until the gas step, which is after the Zcash has already been converted — so if it is empty then, the USDC waits in that wallet until it is funded rather than being lost.`,
        ),
    gasIsPrivate: canPaymaster
      ? ready('The session never holds ETH, so nothing had to fund it.')
      : missing(
          paymasterConfigured
            ? 'A paymaster is configured, but PAYMASTER_SEND_READY is off, so gas is paid in ETH. Whatever funds that wallet links this session.'
            : 'No bundler or paymaster is configured, so gas falls back to ETH — which the session wallet must be funded with, and that funding links it.',
        ),
    withdraw: canSign
      ? ready('Lighter withdrawals will be signed.')
      : missing(
          options.lighterApiKey
            ? `The Lighter signer is not deployed at ${signerBasePath}, so the withdrawal — the way out — would be refused.`
            : 'No Lighter API key is available, so the withdrawal would be refused.',
        ),
  }

  logger.info('real adapters assembled', {
    noir: noir.kind,
    signer: canSign,
    paymaster: canPaymaster,
  })

  return {
    adapters: { near, noir: noir.adapter, lighter, gas, network },
    capabilities,
    noirKind: noir.kind,
    sessionWallet: options.account.address as EvmAddress,
  }
}

/** The movements that will be refused, for a screen that wants to say so. */
export function notReady(capabilities: Capabilities): readonly string[] {
  return Object.values(capabilities)
    .filter((c) => !c.ok)
    .map((c) => c.why)
}

/**
 * The refusals that would strand a session part-way, so Start can be gated
 * on them rather than discovered three steps in.
 *
 * Two are deliberately left out, for the same reason. `sendZcash` without a
 * Noir extension still completes the leg by hand, badly but honestly, and
 * `gasIsPrivate` without a paymaster still completes it in ETH. Both cost
 * the user something they can see and weigh; neither strands them.
 *
 * The others are a different kind of missing. A session that cannot sign an
 * order or a withdrawal can still take real ZEC in, convert it, and then
 * have no way out — and the only recovery is to fund that wallet with ETH
 * from somewhere, which is exactly the link this product exists to break.
 */
export function cannotRoundTrip(capabilities: Capabilities): readonly string[] {
  const { sendZcash: _manualIsFine, gasIsPrivate: _ethIsFine, ...fatal } = capabilities
  return Object.values(fatal)
    .filter((c) => !c.ok)
    .map((c) => c.why)
}
