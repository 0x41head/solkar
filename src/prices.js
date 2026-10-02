// Historical USD prices (stablecoins, Binance hourly candles) and USD→INR reference rates.
import { SOL_MINT } from './parse.js';
import { fetchJson } from './http.js';

export const STABLES = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', // PYUSD
  '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH', // USDG
  'USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA', // USDS
]);

// Mint -> Binance USDT pair.
export const BINANCE = {
  [SOL_MINT]: 'SOLUSDT',
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: 'JUPUSDT',
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: 'BONKUSDT',
  EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm: 'WIFUSDT',
  jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL: 'JTOUSDT',
  HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3: 'PYTHUSDT',
  '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R': 'RAYUSDT',
  '85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ': 'WUSDT',
  rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof: 'RENDERUSDT',
  '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN': 'TRUMPUSDT',
  '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs': 'ETHUSDT', // Wormhole ETH
  '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh': 'BTCUSDT', // Wormhole WBTC
  cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij: 'BTCUSDT', // cbBTC
  '27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4': 'JLPUSDT',
  METAewgxyPbgwsseH8T16a39CQ5VyVxZi9zXiDPY18m: 'MPLXUSDT',
  TNSRxcUxoT9xBG3de7PiJyTDYu7kskLqcpddxnEJAS6: 'TNSRUSDT',
  orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE: 'ORCAUSDT',
};

const HOUR = 3600 * 1000;
const CHUNK = 1000; // candles per Binance request
const BINANCE_API = 'https://data-api.binance.vision/api/v3/klines';
const FX_API = 'https://api.frankfurter.dev/v1';

const istDate = (timeSec) => new Date(timeSec * 1000 + 5.5 * HOUR).toISOString().slice(0, 10);

export class PriceBook {
  constructor() {
    this.candles = new Map(); // symbol -> Map(hourMs -> open price)
    this.fetchedChunks = new Set();
    this.fx = new Map(); // YYYY-MM-DD -> INR per USD
    this.fxDates = [];
  }

  /** Fetches every price needed to value `events`. */
  async prepare(events, onProgress = () => {}) {
    const jobs = new Map();
    let minT = Infinity;
    let maxT = -Infinity;
    for (const ev of events) {
      minT = Math.min(minT, ev.time);
      maxT = Math.max(maxT, ev.time);
      for (const mint of Object.keys(ev.deltas)) {
        const sym = BINANCE[mint];
        if (!sym) continue;
        const chunk = Math.floor((ev.time * 1000) / HOUR / CHUNK);
        const key = `${sym}:${chunk}`;
        if (!this.fetchedChunks.has(key)) jobs.set(key, { sym, chunk });
      }
    }
    if (!events.length) return;
    let done = 0;
    const total = jobs.size + 1;
    await this.#loadFx(minT, maxT);
    onProgress(++done, total);
    for (const { sym, chunk } of jobs.values()) {
      await this.#loadCandles(sym, chunk);
      onProgress(++done, total);
    }
  }

  async #loadCandles(sym, chunk) {
    const start = chunk * CHUNK * HOUR;
    const url = `${BINANCE_API}?symbol=${sym}&interval=1h&startTime=${start}&limit=${CHUNK}`;
    let data = [];
    try {
      data = await fetchJson(url);
    } catch {
      // Pair may not exist for that period; leave unpriced.
    }
    if (!this.candles.has(sym)) this.candles.set(sym, new Map());
    const m = this.candles.get(sym);
    for (const k of data) m.set(k[0], Number(k[1]));
    this.fetchedChunks.add(`${sym}:${chunk}`);
  }

  async #loadFx(minT, maxT) {
    // Pad a week back so early-April or weekend dates have a prior rate.
    const from = istDate(minT - 7 * 86400);
    const to = istDate(maxT);
    const data = await fetchJson(`${FX_API}/${from}..${to}?base=USD&symbols=INR`);
    for (const [d, r] of Object.entries(data.rates)) this.fx.set(d, r.INR);
    this.fxDates = [...this.fx.keys()].sort();
  }

  usd(mint, timeSec) {
    if (STABLES.has(mint)) return 1;
    const sym = BINANCE[mint];
    if (!sym) return null;
    const m = this.candles.get(sym);
    if (!m) return null;
    const hour = Math.floor((timeSec * 1000) / HOUR) * HOUR;
    return m.get(hour) ?? m.get(hour - HOUR) ?? null;
  }

  /** INR per USD on the IST date of `timeSec`, or the most recent earlier published rate. */
  inrPerUsd(timeSec) {
    const d = istDate(timeSec);
    if (this.fx.has(d)) return this.fx.get(d);
    let lo = 0;
    let hi = this.fxDates.length - 1;
    let best = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.fxDates[mid] <= d) {
        best = this.fxDates[mid];
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return best ? this.fx.get(best) : this.fx.get(this.fxDates[0]) ?? null;
  }

  valueInr = (mint, qty, timeSec) => {
    const p = this.usd(mint, timeSec);
    const fx = this.inrPerUsd(timeSec);
    return p == null || fx == null ? null : p * qty * fx;
  };
}
