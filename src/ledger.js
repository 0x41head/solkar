// Classifies wallet events, tracks FIFO cost lots in INR, and builds Schedule VDA rows.
// Pure: all prices are supplied through `valueInr`.

const EPS = 1e-12;
const IST_OFFSET_MS = 5.5 * 3600 * 1000;
export const TAX_RATE = 0.3;
export const CESS = 0.04;

export const IN_KINDS = {
  buy: 'Bought / own transfer (cost = value at receipt)',
  income: 'Reward, airdrop or payment for work (income)',
  zero: 'Gift or unknown (cost = ₹0)',
};
export const OUT_KINDS = {
  transfer: 'Moved to my own wallet / exchange (not a sale)',
  sale: 'Spent or sold (taxable transfer)',
};

/** Indian financial year "2025-26" -> [startSec, endSec) in unix seconds, IST boundaries. */
export function fyRange(fy) {
  const y = Number(fy.slice(0, 4));
  const start = (Date.UTC(y, 3, 1) - IST_OFFSET_MS) / 1000;
  const end = (Date.UTC(y + 1, 3, 1) - IST_OFFSET_MS) / 1000;
  return [start, end];
}

export function fyOf(timeSec) {
  const d = new Date(timeSec * 1000 + IST_OFFSET_MS);
  const y = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
}

export function classify(ev) {
  const ins = [];
  const outs = [];
  for (const [mint, d] of Object.entries(ev.deltas)) {
    if (d > EPS) ins.push({ mint, qty: d });
    else if (d < -EPS) outs.push({ mint, qty: -d });
  }
  const type = ins.length && outs.length ? 'swap' : ins.length ? 'in' : outs.length ? 'out' : 'none';
  return { type, ins, outs };
}

/** Splits `total` across legs by their own values when all are known, else equally. */
function allocate(total, values) {
  const known = values.every((v) => v != null);
  const sum = known ? values.reduce((a, b) => a + b, 0) : 0;
  return values.map((v) => (known && sum > 0 ? (total * v) / sum : total / values.length));
}

const sumOrNull = (vals) => (vals.every((v) => v != null) ? vals.reduce((a, b) => a + b, 0) : null);

/**
 * @param events parsed events (any order)
 * @param valueInr (mint, qty, timeSec) => INR value or null if unpriced
 * @param overrides { [signature]: kind } user classification of plain receipts/sends
 * @param fy "2025-26"
 */
export function buildLedger(events, valueInr, overrides = {}, fy) {
  const [fyStart, fyEnd] = fyRange(fy);
  const inFy = (t) => t >= fyStart && t < fyEnd;
  const lots = new Map(); // mint -> [{qty, unitCost, time, unknownCost}]
  const rows = [];
  const income = [];
  const review = [];
  const warnings = { unpriced: 0, noCostBasis: 0 };

  const acquire = (mint, qty, cost, time, unknownCost = false) => {
    if (!lots.has(mint)) lots.set(mint, []);
    lots.get(mint).push({ qty, unitCost: cost == null ? 0 : cost / qty, time, unknownCost: unknownCost || cost == null });
  };

  // Removes qty from FIFO lots; returns the consumed segments (including an uncovered remainder).
  const consume = (mint, qty) => {
    const q = lots.get(mint) || [];
    const segs = [];
    let left = qty;
    while (left > EPS && q.length) {
      const lot = q[0];
      const take = Math.min(lot.qty, left);
      segs.push({ qty: take, cost: take * lot.unitCost, acquired: lot.time, unknownCost: lot.unknownCost });
      lot.qty -= take;
      left -= take;
      if (lot.qty <= EPS * Math.max(1, take)) q.shift();
    }
    if (left > EPS) segs.push({ qty: left, cost: 0, acquired: null, unknownCost: true });
    return segs;
  };

  const dispose = (ev, mint, qty, consideration) => {
    const segs = consume(mint, qty);
    if (!inFy(ev.time)) return;
    for (const s of segs) {
      const c = consideration == null ? null : (consideration * s.qty) / qty;
      const flags = [];
      if (c == null) flags.push('unpriced');
      if (s.acquired == null) flags.push('no-cost-basis');
      else if (s.unknownCost) flags.push('estimated-cost');
      if (c == null) warnings.unpriced++;
      if (s.acquired == null) warnings.noCostBasis++;
      rows.push({
        signature: ev.signature, mint, qty: s.qty,
        acquired: s.acquired, transferred: ev.time,
        cost: s.cost, consideration: c,
        income: c == null ? null : c - s.cost, flags,
      });
    }
  };

  const sorted = [...events].sort((a, b) => a.time - b.time);
  for (const ev of sorted) {
    const { type, ins, outs } = classify(ev);
    if (type === 'none') continue;

    if (type === 'swap') {
      const vin = ins.map((l) => valueInr(l.mint, l.qty, ev.time));
      const vout = outs.map((l) => valueInr(l.mint, l.qty, ev.time));
      // Consideration for a crypto-to-crypto trade is the value of what was received.
      const total = sumOrNull(vin) ?? sumOrNull(vout);
      const outShares = total == null ? outs.map(() => null) : allocate(total, vout);
      const inShares = total == null ? ins.map(() => null) : allocate(total, vin);
      outs.forEach((l, i) => dispose(ev, l.mint, l.qty, outShares[i]));
      ins.forEach((l, i) => acquire(l.mint, l.qty, inShares[i], ev.time));
      continue;
    }

    const legs = type === 'in' ? ins : outs;
    const values = legs.map((l) => valueInr(l.mint, l.qty, ev.time));
    const kind = overrides[ev.signature] || (type === 'in' ? 'buy' : 'transfer');
    review.push({ signature: ev.signature, time: ev.time, type, kind, legs, values, inFy: inFy(ev.time) });

    if (type === 'in') {
      legs.forEach((l, i) => {
        const v = values[i];
        if (kind === 'zero') acquire(l.mint, l.qty, 0, ev.time);
        else acquire(l.mint, l.qty, v, ev.time, v == null);
        if (kind === 'income' && inFy(ev.time)) {
          income.push({ signature: ev.signature, time: ev.time, mint: l.mint, qty: l.qty, value: v });
        }
      });
    } else if (kind === 'sale') {
      legs.forEach((l, i) => dispose(ev, l.mint, l.qty, values[i]));
    } else {
      legs.forEach((l) => consume(l.mint, l.qty));
    }
  }

  const priced = rows.filter((r) => r.income != null);
  const gains = priced.filter((r) => r.income > 0).reduce((a, r) => a + r.income, 0);
  const losses = priced.filter((r) => r.income < 0).reduce((a, r) => a + r.income, 0);
  const tax = gains * TAX_RATE;
  const summary = {
    transfers: rows.length,
    consideration: priced.reduce((a, r) => a + r.consideration, 0),
    cost: priced.reduce((a, r) => a + r.cost, 0),
    gains,
    losses,
    tax,
    cess: tax * CESS,
    totalTax: tax * (1 + CESS),
    income: income.reduce((a, r) => a + (r.value || 0), 0),
  };
  review.sort((a, b) => b.time - a.time);
  return { rows, income, review, summary, warnings };
}
