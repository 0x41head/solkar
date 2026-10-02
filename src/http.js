// fetch with retry/backoff for public, rate-limited APIs.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fetchJson(url, init = {}, { retries = 5, baseDelay = 800 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get('retry-after'));
        lastErr = new Error(`HTTP ${res.status} from ${new URL(url).host}`);
        await sleep(retryAfter > 0 ? retryAfter * 1000 : baseDelay * 2 ** attempt);
        continue;
      }
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} from ${new URL(url).host}`), { fatal: true });
      return await res.json();
    } catch (e) {
      if (e.fatal) throw e;
      lastErr = e;
      await sleep(baseDelay * 2 ** attempt);
    }
  }
  throw lastErr;
}
