import { getSignatures, getEvents, DEFAULT_RPC } from './rpc.js';
import { PriceBook } from './prices.js';
import { buildLedger, fyOf, IN_KINDS, OUT_KINDS } from './ledger.js';
import { loadTokens, symbol, addTokens } from './tokens.js';
import { loadWallet, saveWallet, clearAll } from './cache.js';
import { scheduleVdaCsv, auditCsv, download, istDate } from './export.js';

const $ = (id) => document.getElementById(id);
const MAX_TABLE_ROWS = 500;
const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const fmtInr = (v) => (v == null ? '—' : inr.format(v));
const fmtQty = (q) => (q >= 1000 ? q.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : q.toLocaleString('en-IN', { maximumSignificantDigits: 6 }));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const short = (s) => `${s.slice(0, 4)}…${s.slice(-4)}`;

const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem(`solkar:${k}`);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(`solkar:${k}`, JSON.stringify(v));
    } catch {
      // storage blocked; settings just won't persist
    }
  },
};

const state = { address: '', events: [], prices: null, overrides: {}, ledger: null, demo: false, demoOverrides: {} };

function currentFy() {
  return fyOf(Date.now() / 1000);
}

function fillFyOptions(extra = []) {
  const now = currentFy();
  const start = Number(now.slice(0, 4));
  const set = new Set(extra);
  for (let y = start; y >= 2021; y--) set.add(`${y}-${String((y + 1) % 100).padStart(2, '0')}`);
  const sel = $('fy');
  const prev = sel.value;
  sel.innerHTML = [...set].sort().reverse()
    .map((fy) => `<option value="${fy}">FY ${fy} (AY ${Number(fy.slice(0, 4)) + 1}-${String((Number(fy.slice(0, 4)) + 2) % 100).padStart(2, '0')})${fy === now ? ' · in progress' : ''}</option>`)
    .join('');
  // Default to the most recent completed year, the one people are filing for.
  const lastCompleted = `${start - 1}-${String(start % 100).padStart(2, '0')}`;
  sel.value = prev && set.has(prev) ? prev : lastCompleted;
}

function progress(frac, text) {
  $('progress').hidden = false;
  $('bar').style.width = `${Math.round(frac * 100)}%`;
  $('status').textContent = text;
}

function showError(msg) {
  $('error').hidden = !msg;
  $('error').textContent = msg || '';
}

function busy(on) {
  for (const id of ['run', 'demo']) $(id).disabled = on;
}

const isAddress = (s) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);

async function fetchHistory(address) {
  const url = $('rpc').value.trim() || DEFAULT_RPC;
  const max = Math.max(50, Number($('max').value) || 3000);
  const keyed = url !== DEFAULT_RPC;
  const cached = (await loadWallet(address)) || { events: [], seen: [] };
  const seen = new Set(cached.seen);

  progress(0.02, 'Listing transactions…');
  const sigs = await getSignatures(url, address, max, (n) => progress(0.05, `Found ${n.toLocaleString()} transactions…`));
  const fresh = sigs.filter((s) => !seen.has(s.signature));
  const started = Date.now();
  const events = await getEvents(url, address, fresh, {
    rate: keyed ? 9 : 3,
    onProgress: (done, total) => {
      const elapsed = (Date.now() - started) / 1000;
      const eta = done ? Math.round((elapsed / done) * (total - done)) : null;
      progress(0.05 + 0.8 * (done / Math.max(1, total)),
        `Reading transactions ${done.toLocaleString()} / ${total.toLocaleString()}${eta != null && total - done > 0 ? ` · about ${eta}s left` : ''}${!keyed && total > 200 ? ' · add a free Helius key under Advanced to speed this up' : ''}`);
    },
  });
  const merged = [...cached.events, ...events];
  for (const s of fresh) seen.add(s.signature);
  await saveWallet(address, { events: merged, seen: [...seen] });
  if (sigs.length >= max) {
    showError(`Only the latest ${max.toLocaleString()} transactions were scanned. Older purchases may be missing, so raise the limit under Advanced if this wallet is older.`);
  }
  return merged;
}

async function analyse(address, events) {
  state.address = address;
  state.events = events;
  state.overrides = state.demo ? { ...state.demoOverrides } : store.get(`overrides:${address}`, {});
  progress(0.88, 'Fetching historical prices…');
  state.prices = new PriceBook();
  await state.prices.prepare(events, (d, t) => progress(0.88 + 0.08 * (d / t), `Fetching historical prices ${d}/${t}…`));
  progress(0.97, 'Looking up token names…');
  await loadTokens(events.flatMap((e) => Object.keys(e.deltas)));
  fillFyOptions([...new Set(events.map((e) => fyOf(e.time)))]);
  render();
  progress(1, `Done: ${events.length.toLocaleString()} balance-changing transactions analysed.`);
  $('results').hidden = false;
  $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function render() {
  if (!state.prices) return;
  const fy = $('fy').value;
  const L = buildLedger(state.events, state.prices.valueInr, state.overrides, fy);
  state.ledger = L;
  const s = L.summary;
  $('r-title').textContent = `FY ${fy} report`;
  $('r-sub').textContent = `${state.demo ? 'Sample portfolio: illustrative trades valued at real historical prices' : `Wallet ${short(state.address)}`} · ${L.rows.length} Schedule VDA row${L.rows.length === 1 ? '' : 's'}`;

  $('tiles').innerHTML = [
    ['Tax payable on VDA', fmtInr(s.totalTax), '30% + 4% cess on gains', 'hero-tile'],
    ['Taxable gains', fmtInr(s.gains), 'Sum of profitable transfers'],
    ['Losses (not deductible)', fmtInr(s.losses), 'Can’t offset gains under §115BBH'],
    ['Total sale value', fmtInr(s.consideration), `${s.transfers} transfer${s.transfers === 1 ? '' : 's'}`],
  ].map(([k, v, sub, cls = '']) => `<div class="tile ${cls}"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${sub}</div></div>`).join('');

  const w = [];
  const pendingReview = L.review.filter((r) => r.inFy && !(r.signature in state.overrides)).length;
  if (pendingReview) w.push(`${pendingReview} transfer${pendingReview === 1 ? '' : 's'} this year still use the default treatment. Check them below.`);
  if (L.warnings.noCostBasis) w.push(`${L.warnings.noCostBasis} row${L.warnings.noCostBasis === 1 ? '' : 's'} sell coins this wallet never received (bought before the scanned history or in another wallet). Their cost is taken as ₹0, which overstates tax. Add your other wallets or raise the scan limit.`);
  if (L.warnings.unpriced) w.push(`${L.warnings.unpriced} row${L.warnings.unpriced === 1 ? '' : 's'} involve tokens with no price on either side of the trade and are left out of the totals. Value them manually.`);
  $('warnings').innerHTML = w.length ? `<div class="warn"><strong>Needs your attention</strong><ul>${w.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : '';

  renderReview(L);
  renderVda(L);
  renderIncome(L);
}

function txLink(sig, text, cls = '') {
  if (state.demo) return `<span class="${cls}">${text}</span>`;
  return `<a class="${cls}" href="https://solscan.io/tx/${sig}" target="_blank" rel="noopener">${text}</a>`;
}

function reviewRow(r) {
  const kinds = r.type === 'in' ? IN_KINDS : OUT_KINDS;
  const legs = r.legs.map((l, i) => `${fmtQty(l.qty)} ${esc(symbol(l.mint))}${r.values[i] != null ? ` <span class="muted">(${fmtInr(r.values[i])})</span>` : ''}`).join(', ');
  const opts = Object.entries(kinds).map(([k, label]) => `<option value="${k}"${k === r.kind ? ' selected' : ''}>${esc(label)}</option>`).join('');
  return `<div class="review-item">
    <div><span class="dir ${r.type}">${r.type === 'in' ? '↓ Received' : '↑ Sent'}</span><div class="tx">${istDate(r.time)}</div></div>
    <div>${legs} ${txLink(r.signature, short(r.signature), 'tx')}</div>
    <select data-sig="${r.signature}" aria-label="Treatment">${opts}</select>
  </div>`;
}

function renderReview(L) {
  const cur = L.review.filter((r) => r.inFy);
  const older = L.review.filter((r) => !r.inFy);
  let html = cur.length ? cur.map(reviewRow).join('') : '<p class="muted">No plain transfers in this financial year.</p>';
  if (older.length) {
    html += `<details class="review-more"><summary>${older.length} transfer${older.length === 1 ? '' : 's'} in other years (these affect cost basis)</summary>${older.slice(0, 300).map(reviewRow).join('')}</details>`;
  }
  $('review').innerHTML = html;
}

function renderVda(L) {
  const rows = L.rows.slice(0, MAX_TABLE_ROWS);
  const flagLabel = { 'no-cost-basis': 'no cost basis', unpriced: 'unpriced', 'estimated-cost': 'est. cost' };
  $('vda').innerHTML = `<thead><tr><th>#</th><th>Asset</th><th class="n">Qty</th><th>Acquired</th><th>Transferred</th><th class="n">Cost</th><th class="n">Consideration</th><th class="n">Income</th></tr></thead>
  <tbody>${rows.map((r, i) => `<tr>
    <td class="muted">${i + 1}</td>
    <td>${esc(symbol(r.mint))}${r.flags.map((f) => `<span class="chip">${flagLabel[f] || f}</span>`).join('')}</td>
    <td class="n">${fmtQty(r.qty)}</td>
    <td>${r.acquired == null ? '<span class="muted">unknown</span>' : istDate(r.acquired)}</td>
    <td>${txLink(r.signature, istDate(r.transferred))}</td>
    <td class="n">${fmtInr(r.cost)}</td>
    <td class="n">${fmtInr(r.consideration)}</td>
    <td class="n ${r.income > 0 ? 'pos' : r.income < 0 ? 'neg' : ''}">${fmtInr(r.income)}</td>
  </tr>`).join('') || '<tr><td colspan="8" class="muted">No taxable transfers in this financial year.</td></tr>'}</tbody>`;
  $('vda-note').textContent = L.rows.length > MAX_TABLE_ROWS ? `Showing the first ${MAX_TABLE_ROWS} of ${L.rows.length} rows; the CSV has all of them.` : '';
}

function renderIncome(L) {
  $('income-card').hidden = !L.income.length;
  $('income').innerHTML = `<thead><tr><th>Date</th><th>Asset</th><th class="n">Qty</th><th class="n">Value at receipt</th></tr></thead>
  <tbody>${L.income.map((r) => `<tr><td>${istDate(r.time)}</td><td>${esc(symbol(r.mint))}</td><td class="n">${fmtQty(r.qty)}</td><td class="n">${fmtInr(r.value)}</td></tr>`).join('')}
  <tr><td colspan="3"><strong>Total</strong></td><td class="n"><strong>${fmtInr(L.summary.income)}</strong></td></tr></tbody>`;
}

async function run(address) {
  showError('');
  busy(true);
  try {
    state.demo = false;
    const events = await fetchHistory(address);
    await analyse(address, events);
  } catch (e) {
    showError(`Couldn't finish: ${e.message}`);
  } finally {
    busy(false);
  }
}

async function runDemo() {
  showError('');
  busy(true);
  try {
    progress(0.1, 'Loading demo wallet…');
    const demo = await (await fetch('demo/events.json')).json();
    state.demo = true;
    state.demoOverrides = demo.overrides || {};
    addTokens(demo.tokens || {});
    $('address').value = '';
    await analyse(demo.address, demo.events);
    if ([...$('fy').options].some((o) => o.value === demo.fy)) $('fy').value = demo.fy;
    render();
  } catch (e) {
    showError(`Couldn't load the demo: ${e.message}`);
  } finally {
    busy(false);
  }
}

// --- wiring ---
fillFyOptions();
$('rpc').value = store.get('rpc', '');
$('rpc').addEventListener('change', () => store.set('rpc', $('rpc').value.trim()));
$('form').addEventListener('submit', (e) => {
  e.preventDefault();
  const a = $('address').value.trim();
  if (!isAddress(a)) return showError('That doesn’t look like a Solana address.');
  run(a);
});
$('demo').addEventListener('click', runDemo);
$('fy').addEventListener('change', render);
$('head').addEventListener('change', () => store.set('head', $('head').value));
$('head').value = store.get('head', 'Capital Gain');
$('review').addEventListener('change', (e) => {
  const sig = e.target.dataset.sig;
  if (!sig) return;
  state.overrides[sig] = e.target.value;
  if (!state.demo) store.set(`overrides:${state.address}`, state.overrides);
  render();
});
$('csv').addEventListener('click', () => download(`schedule-vda-FY${$('fy').value}-${short(state.address)}.csv`, scheduleVdaCsv(state.ledger.rows, $('head').value)));
$('audit').addEventListener('click', () => download(`solkar-detail-FY${$('fy').value}-${short(state.address)}.csv`, auditCsv(state.ledger.rows, symbol)));
$('print').addEventListener('click', () => window.print());
$('clear').addEventListener('click', async () => {
  await clearAll();
  showError('');
  progress(0, 'Cached history cleared.');
});
const params = new URLSearchParams(location.search);
if (params.has('demo')) runDemo();
else if (params.get('address') && isAddress(params.get('address'))) {
  $('address').value = params.get('address');
  run(params.get('address'));
}
