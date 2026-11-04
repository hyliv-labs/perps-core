/**
 * A real snapshot of Lighter's ZEC perp, captured 2026-10-27.
 *
 * It exists so the preview route, the tests and the screenshot inspector all
 * draw the same window without a live network. It is a RECORD, not a stand-in:
 * the UI that shows it says when it was captured, so a reader is never left to
 * assume these prices are current.
 */

import type { MarketCard, RawDetails, RawOrder, RawTrade } from './market'
import { aggregate, makeBook, parseTicker, parseTrades, type MarketSnapshot } from './market'

export const FIXTURE_CAPTURED_AT = '2026-10-27'

const DETAILS: RawDetails = {
  symbol: "ZEC",
  market_id: 90,
  status: "active",
  min_base_amount: "0.004",
  min_quote_amount: "10.000000",
  supported_size_decimals: 3,
  supported_price_decimals: 3,
  taker_fee: "0.0000",
  maker_fee: "0.0000",
  mark_price: "1239.520",
  index_price: "1240.056",
  last_trade_price: 1239.174,
  daily_price_low: 1210.8,
  daily_price_high: 1267.828,
  daily_price_change: 0.3767447022048192,
  daily_base_token_volume: 30434.331,
  daily_quote_token_volume: 37536651.736039,
  daily_trades_count: 43548,
  open_interest: 11295.353,
  open_interest_usd: "28001631.901120",
  default_initial_margin_fraction: 666,
  min_initial_margin_fraction: 500,
  maintenance_margin_fraction: 300,
}

const ASKS: readonly RawOrder[] = [
    { price: '1239.627', remaining_base_amount: '0.807' },
    { price: '1239.628', remaining_base_amount: '12.877' },
    { price: '1239.708', remaining_base_amount: '0.403' },
    { price: '1239.708', remaining_base_amount: '0.328' },
    { price: '1239.758', remaining_base_amount: '0.690' },
    { price: '1239.767', remaining_base_amount: '0.708' },
    { price: '1239.829', remaining_base_amount: '9.651' },
    { price: '1239.838', remaining_base_amount: '0.932' },
    { price: '1239.840', remaining_base_amount: '24.187' },
    { price: '1239.843', remaining_base_amount: '0.048' },
    { price: '1239.845', remaining_base_amount: '1.613' },
    { price: '1239.891', remaining_base_amount: '2.904' },
    { price: '1239.893', remaining_base_amount: '4.032' },
    { price: '1239.945', remaining_base_amount: '32.363' },
    { price: '1239.950', remaining_base_amount: '8.157' },
    { price: '1239.966', remaining_base_amount: '0.328' },
    { price: '1239.990', remaining_base_amount: '0.328' },
    { price: '1240.002', remaining_base_amount: '0.328' },
    { price: '1240.039', remaining_base_amount: '33.237' },
    { price: '1240.077', remaining_base_amount: '2.904' },
    { price: '1240.145', remaining_base_amount: '1.520' },
    { price: '1240.153', remaining_base_amount: '6.806' },
    { price: '1240.215', remaining_base_amount: '1.071' },
    { price: '1240.224', remaining_base_amount: '0.806' },
]

const BIDS: readonly RawOrder[] = [
    { price: '1239.594', remaining_base_amount: '0.466' },
    { price: '1239.477', remaining_base_amount: '2.479' },
    { price: '1239.475', remaining_base_amount: '0.403' },
    { price: '1239.473', remaining_base_amount: '0.466' },
    { price: '1239.426', remaining_base_amount: '0.806' },
    { price: '1239.423', remaining_base_amount: '0.466' },
    { price: '1239.404', remaining_base_amount: '0.160' },
    { price: '1239.385', remaining_base_amount: '0.538' },
    { price: '1239.373', remaining_base_amount: '0.429' },
    { price: '1239.346', remaining_base_amount: '0.321' },
    { price: '1239.345', remaining_base_amount: '22.725' },
    { price: '1239.341', remaining_base_amount: '3.156' },
    { price: '1239.320', remaining_base_amount: '12.236' },
    { price: '1239.311', remaining_base_amount: '1.520' },
    { price: '1239.266', remaining_base_amount: '0.731' },
    { price: '1239.238', remaining_base_amount: '2.906' },
    { price: '1239.231', remaining_base_amount: '0.402' },
    { price: '1239.199', remaining_base_amount: '32.363' },
    { price: '1239.192', remaining_base_amount: '1.613' },
    { price: '1239.172', remaining_base_amount: '2.328' },
    { price: '1239.094', remaining_base_amount: '8.157' },
    { price: '1239.093', remaining_base_amount: '5.462' },
    { price: '1239.071', remaining_base_amount: '1.613' },
    { price: '1239.066', remaining_base_amount: '34.140' },
]

const TRADES: readonly RawTrade[] = [
    { price: '1239.174', size: '0.011', timestamp: 1793090885280, is_maker_ask: true },
    { price: '1239.174', size: '0.011', timestamp: 1793090885280, is_maker_ask: true },
    { price: '1238.908', size: '0.242', timestamp: 1793090883843, is_maker_ask: false },
    { price: '1239.153', size: '0.242', timestamp: 1793090882937, is_maker_ask: false },
    { price: '1239.343', size: '0.155', timestamp: 1793090879849, is_maker_ask: false },
    { price: '1239.345', size: '0.241', timestamp: 1793090879532, is_maker_ask: false },
    { price: '1239.313', size: '0.174', timestamp: 1793090875260, is_maker_ask: false },
    { price: '1239.160', size: '0.366', timestamp: 1793090870126, is_maker_ask: false },
    { price: '1239.113', size: '0.055', timestamp: 1793090864786, is_maker_ask: true },
    { price: '1238.627', size: '0.034', timestamp: 1793090863258, is_maker_ask: false },
    { price: '1239.053', size: '0.055', timestamp: 1793090861992, is_maker_ask: true },
    { price: '1239.398', size: '0.083', timestamp: 1793090861975, is_maker_ask: false },
    { price: '1239.579', size: '0.252', timestamp: 1793090861317, is_maker_ask: false },
    { price: '1239.587', size: '0.174', timestamp: 1793090861317, is_maker_ask: false },
]

/** The captured market, shaped exactly as a live snapshot. */
export function fixtureSnapshot(depth = 9, tape = 14): MarketSnapshot {
  return {
    ticker: parseTicker(DETAILS),
    book: makeBook(aggregate(ASKS, 'ask', depth), aggregate(BIDS, 'bid', depth)),
    trades: parseTrades(TRADES, tape),
    fundingRate: 8.800000000000001e-05,
    at: Date.parse('2026-10-27T14:28:00Z'),
    stale: true,
  }
}

/**
 * The nine busiest markets and a day of their hourly closes, captured with
 * the book above.
 *
 * The strip is a picker, so it has to draw something even when the ranking
 * read fails. These are real closes from Lighter's `/api/v1/candles`, not a
 * shape invented to look like a market.
 */
export function fixtureMarkets(): MarketCard[] {
  return CARDS.map((c) => ({ ...c, spark: [...c.spark] }))
}

const CARDS: readonly MarketCard[] = [
  {
    symbol: "BTC",
    marketId: 1,
    last: 79642.9,
    changePct: -0.9457282368674774,
    quoteVolume: 864012317.912614,
    spark: [80382.5, 80315.0, 79677.0, 80395.8, 80412.3, 80203.3, 80305.1, 79966.3, 80000.5, 79841.1, 80080.9, 79992.8, 80131.1, 80180.9, 80038.7, 79792.2, 79802.2, 79734.4, 79951.1, 79646.8, 79792.5, 79843.6, 79765.3, 79643.2],
  },
  {
    symbol: "ETH",
    marketId: 0,
    last: 2304.54,
    changePct: -1.24723550892352,
    quoteVolume: 446186468.084705,
    spark: [2333.16, 2323.11, 2302.7, 2326.48, 2327.6, 2320.15, 2325.22, 2313.8, 2317.41, 2305.42, 2310.54, 2313.36, 2323.76, 2325.76, 2322.57, 2312.59, 2313.85, 2312.25, 2315.03, 2304.49, 2314.04, 2312.64, 2312.1, 2304.95],
  },
  {
    symbol: "HYPE",
    marketId: 24,
    last: 77.3385,
    changePct: 0.009574949860904444,
    quoteVolume: 64020940.715587996,
    spark: [77.285, 77.439, 77.0278, 78.2128, 78.4289, 78.4445, 79.7161, 78.9253, 78.524, 77.6756, 77.7088, 77.9134, 78.3251, 78.6156, 78.2438, 77.9005, 77.7284, 77.5482, 77.6606, 77.509, 78.049, 77.9884, 77.6745, 77.3385],
  },
  {
    symbol: "SOL",
    marketId: 2,
    last: 99.717,
    changePct: -1.9853873914625393,
    quoteVolume: 56983100.237523,
    spark: [101.693, 101.634, 100.847, 102.116, 101.899, 101.314, 101.387, 100.441, 100.479, 100.303, 100.533, 100.386, 100.935, 100.835, 100.627, 100.244, 100.172, 100.132, 100.173, 99.579, 100.091, 99.95, 99.916, 99.722],
  },
  {
    symbol: "US100",
    marketId: 181,
    last: 29272.0,
    changePct: 0.542694236449818,
    quoteVolume: 45339525.568514,
    spark: [29114.0, 29134.0, 29052.0, 29374.0, 29313.0, 29328.0, 29371.0, 29317.0, 29288.0, 29314.0, 29325.0, 29330.0, 29384.0, 29385.0, 29361.0, 29275.0, 29299.0, 29272.0, 29236.0, 29170.0, 29163.0, 29280.0, 29327.0, 29265.0],
  },
  {
    symbol: "ZEC",
    marketId: 90,
    last: 1242.69,
    changePct: 1.233209082993357,
    quoteVolume: 38572887.977214,
    spark: [1226.556, 1237.221, 1222.352, 1251.853, 1247.46, 1236.805, 1241.151, 1226.127, 1227.444, 1220.522, 1225.001, 1221.765, 1232.301, 1234.337, 1232.787, 1223.509, 1221.457, 1220.871, 1221.731, 1218.794, 1235.71, 1242.466, 1247.848, 1243.885],
  },
  {
    symbol: "QQQ",
    marketId: 129,
    last: 711.75,
    changePct: 0.4672567371080902,
    quoteVolume: 26336489.425247,
    spark: [708.39, 708.65, 706.76, 714.6, 713.04, 713.33, 714.47, 712.84, 712.1, 712.84, 713.0, 713.34, 714.62, 714.67, 713.98, 711.83, 712.37, 711.86, 710.91, 709.57, 709.37, 712.19, 713.22, 711.76],
  },
  {
    symbol: "GOOGL",
    marketId: 116,
    last: 317.81,
    changePct: -1.4603745504154781,
    quoteVolume: 25021590.333696,
    spark: [322.52, 322.33, 318.35, 321.24, 319.96, 319.26, 318.57, 317.17, 317.17, 317.96, 317.91, 318.0, 318.36, 318.78, 318.81, 318.53, 318.77, 318.73, 318.26, 317.65, 317.63, 318.53, 318.7, 317.81],
  },
  {
    symbol: "SNDK",
    marketId: 139,
    last: 1265.57,
    changePct: 0.5239550668836581,
    quoteVolume: 18672604.629889,
    spark: [1259.65, 1264.08, 1247.97, 1260.86, 1261.57, 1265.19, 1286.6, 1265.63, 1256.83, 1261.28, 1265.33, 1262.42, 1270.24, 1282.0, 1281.43, 1266.26, 1268.46, 1267.29, 1262.08, 1257.19, 1258.76, 1268.09, 1274.37, 1265.92],
  },
]
