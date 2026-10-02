// Pulls a wallet's transaction history over plain Solana JSON-RPC.
import { fetchJson } from './http.js';
import { parseTx } from './parse.js';

export const DEFAULT_RPC = 'https://api.mainnet-beta.solana.com';

async function rpc(url, body) {
  return fetchJson(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** All successful signatures for `address`, newest first, up to `max`. */
export async function getSignatures(url, address, max, onProgress = () => {}) {
  const out = [];
  let before;
  while (out.length < max) {
    const res = await rpc(url, {
      jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress',
      params: [address, { limit: 1000, before }],
    });
    if (res.error) throw new Error(res.error.message);
    const page = res.result;
    for (const s of page) if (!s.err) out.push(s);
    onProgress(out.length);
    if (page.length < 1000) break;
    before = page[page.length - 1].signature;
  }
  return out.slice(0, max);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetches and parses transactions in small JSON-RPC batches, paced for rate-limited
 * endpoints. Items rejected inside a batch are retried with backoff.
 * @param rate max getTransaction calls per second (public RPC allows ~4; keyed RPCs far more)
 * @returns parsed events (failed or irrelevant transactions dropped)
 */
export async function getEvents(url, address, signatures, { rate = 3.5, onProgress = () => {} } = {}) {
  const batch = Math.max(1, Math.min(20, Math.floor(rate)));
  const events = [];
  let done = 0;
  for (let i = 0; i < signatures.length; i += batch) {
    const started = Date.now();
    let pending = signatures.slice(i, i + batch).map((s) => s.signature);
    for (let attempt = 0; pending.length; attempt++) {
      if (attempt > 6) throw new Error('RPC kept rate-limiting; try again later or use your own RPC URL.');
      if (attempt) await sleep(1000 * 2 ** (attempt - 1));
      const body = pending.map((sig, id) => ({
        jsonrpc: '2.0', id, method: 'getTransaction',
        params: [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'finalized' }],
      }));
      let res = await rpc(url, body);
      if (!Array.isArray(res)) res = [res];
      const retry = [];
      for (const r of res) {
        const sig = pending[r.id];
        if (r.error) {
          retry.push(sig);
          continue;
        }
        const ev = parseTx(r.result, address, sig);
        if (ev && Object.keys(ev.deltas).length) events.push(ev);
        done++;
      }
      pending = retry;
      onProgress(done, signatures.length);
    }
    const minGap = (batch / rate) * 1000;
    const elapsed = Date.now() - started;
    if (elapsed < minGap) await sleep(minGap - elapsed);
  }
  return events;
}
