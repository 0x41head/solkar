// Token symbols/names from Jupiter's token API, cached in localStorage.
import { fetchJson } from './http.js';
import { SOL_MINT } from './parse.js';

const KEY = 'solkar:tokens:v1';
const known = { [SOL_MINT]: { symbol: 'SOL', name: 'Solana' } };

function load() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || {};
  } catch {
    return {};
  }
}
function save(cache) {
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    // storage unavailable; metadata is refetched next time
  }
}

const cache = { ...load(), ...known };

export async function loadTokens(mints) {
  const missing = [...new Set(mints)].filter((m) => !cache[m]);
  for (let i = 0; i < missing.length; i += 50) {
    const chunk = missing.slice(i, i + 50);
    try {
      const res = await fetchJson(`https://lite-api.jup.ag/tokens/v2/search?query=${chunk.join(',')}`, {}, { retries: 2 });
      for (const t of res) cache[t.id] = { symbol: t.symbol, name: t.name };
    } catch {
      // fall back to shortened mints
    }
    for (const m of chunk) if (!cache[m]) cache[m] = { symbol: `${m.slice(0, 4)}…${m.slice(-4)}`, name: 'Unknown token' };
  }
  save(cache);
}

export const symbol = (mint) => cache[mint]?.symbol || `${mint.slice(0, 4)}…`;
export const tokenName = (mint) => cache[mint]?.name || mint;
