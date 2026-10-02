import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLedger, fyRange, fyOf, classify } from '../src/ledger.js';
import { parseTx, SOL_MINT } from '../src/parse.js';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const MEME = 'Meme111111111111111111111111111111111111111';
const t = (iso) => Date.parse(iso) / 1000;

// Fixed prices: SOL ₹10,000 before 2025-06, ₹15,000 after; USDC ₹85; MEME unpriced.
const valueInr = (mint, qty, time) => {
  if (mint === USDC) return qty * 85;
  if (mint === SOL_MINT) return qty * (time < t('2025-06-01T00:00:00Z') ? 10000 : 15000);
  return null;
};
const ev = (signature, iso, deltas) => ({ signature, time: t(iso), feeSol: 0, deltas });

test('financial year boundaries are IST', () => {
  const [s, e] = fyRange('2025-26');
  assert.equal(s, t('2025-03-31T18:30:00Z'));
  assert.equal(e, t('2026-03-31T18:30:00Z'));
  assert.equal(fyOf(t('2025-03-31T18:29:59Z')), '2024-25');
  assert.equal(fyOf(t('2025-03-31T18:30:00Z')), '2025-26');
});

test('classify', () => {
  assert.equal(classify(ev('a', '2025-01-01T00:00:00Z', { [USDC]: -5, [SOL_MINT]: 1 })).type, 'swap');
  assert.equal(classify(ev('a', '2025-01-01T00:00:00Z', { [USDC]: 5 })).type, 'in');
  assert.equal(classify(ev('a', '2025-01-01T00:00:00Z', { [USDC]: -5 })).type, 'out');
});

test('buy with USDC, sell later at a gain: FIFO cost and 30% + cess', () => {
  const events = [
    ev('dep', '2025-04-02T00:00:00Z', { [USDC]: 1000 }), // receipt, cost = ₹85,000
    ev('buy', '2025-05-01T00:00:00Z', { [USDC]: -100, [SOL_MINT]: 1 }), // 1 SOL @ ₹10,000 value received
    ev('sell', '2025-07-01T00:00:00Z', { [SOL_MINT]: -1, [USDC]: 180 }), // receive ₹15,300
  ];
  const L = buildLedger(events, valueInr, {}, '2025-26');
  // Rows: USDC disposed in 'buy' (cost 8500, consideration 10000 = value of SOL received), SOL in 'sell'.
  assert.equal(L.rows.length, 2);
  const usdcRow = L.rows.find((r) => r.mint === USDC);
  assert.equal(usdcRow.cost, 8500);
  assert.equal(usdcRow.consideration, 10000);
  const solRow = L.rows.find((r) => r.mint === SOL_MINT);
  assert.equal(solRow.cost, 10000);
  assert.equal(solRow.consideration, 15300);
  assert.equal(solRow.income, 5300);
  assert.equal(L.summary.gains, 1500 + 5300);
  assert.ok(Math.abs(L.summary.totalTax - 6800 * 0.3 * 1.04) < 1e-6);
});

test('losses are reported but never offset gains', () => {
  const events = [
    ev('dep', '2025-04-02T00:00:00Z', { [SOL_MINT]: 2 }), // cost ₹20,000
    ev('s1', '2025-07-01T00:00:00Z', { [SOL_MINT]: -1, [USDC]: 200 }), // +17000-10000 = +7000
    ev('s2', '2025-07-02T00:00:00Z', { [SOL_MINT]: -1, [USDC]: 50 }), // 4250-10000 = -5750
  ];
  const L = buildLedger(events, valueInr, {}, '2025-26');
  assert.equal(L.summary.gains, 7000);
  assert.equal(L.summary.losses, -5750);
  assert.ok(Math.abs(L.summary.tax - 2100) < 1e-6);
});

test('FIFO splits a disposal across lots into separate rows', () => {
  const events = [
    ev('a', '2025-04-02T00:00:00Z', { [SOL_MINT]: 1 }), // ₹10,000
    ev('b', '2025-07-01T00:00:00Z', { [SOL_MINT]: 1 }), // ₹15,000
    ev('s', '2025-08-01T00:00:00Z', { [SOL_MINT]: -1.5, [USDC]: 300 }), // ₹25,500
  ];
  const L = buildLedger(events, valueInr, {}, '2025-26');
  assert.equal(L.rows.length, 2);
  assert.equal(L.rows[0].qty, 1);
  assert.equal(L.rows[0].cost, 10000);
  assert.equal(L.rows[1].qty, 0.5);
  assert.equal(L.rows[1].cost, 7500);
  assert.equal(L.rows[0].consideration + L.rows[1].consideration, 25500);
});

test('selling something never received in this wallet is flagged with zero cost', () => {
  const L = buildLedger([ev('s', '2025-08-01T00:00:00Z', { [SOL_MINT]: -1, [USDC]: 150 })], valueInr, {}, '2025-26');
  assert.deepEqual(L.rows[0].flags, ['no-cost-basis']);
  assert.equal(L.rows[0].cost, 0);
  assert.equal(L.warnings.noCostBasis, 1);
});

test('unpriced token is valued from the priced side of the swap', () => {
  const events = [
    ev('buy', '2025-05-01T00:00:00Z', { [USDC]: -100, [MEME]: 1e6 }), // MEME cost = ₹8,500
    ev('sell', '2025-06-01T00:00:00Z', { [MEME]: -1e6, [USDC]: 300 }), // ₹25,500
  ];
  const L = buildLedger(events, valueInr, {}, '2025-26');
  const meme = L.rows.find((r) => r.mint === MEME);
  assert.equal(meme.cost, 8500);
  assert.equal(meme.consideration, 25500);
});

test('plain sends default to own-transfer; marking as sale makes them taxable', () => {
  const events = [
    ev('dep', '2025-04-02T00:00:00Z', { [SOL_MINT]: 1 }),
    ev('send', '2025-07-01T00:00:00Z', { [SOL_MINT]: -1 }),
  ];
  assert.equal(buildLedger(events, valueInr, {}, '2025-26').rows.length, 0);
  const L = buildLedger(events, valueInr, { send: 'sale' }, '2025-26');
  assert.equal(L.rows.length, 1);
  assert.equal(L.rows[0].income, 5000);
});

test('income receipts are listed separately and set cost basis', () => {
  const events = [
    ev('bounty', '2025-05-01T00:00:00Z', { [USDC]: 500 }),
    ev('sell', '2025-06-01T00:00:00Z', { [USDC]: -500, [SOL_MINT]: 3 }),
  ];
  const L = buildLedger(events, valueInr, { bounty: 'income' }, '2025-26');
  assert.equal(L.income.length, 1);
  assert.equal(L.summary.income, 42500);
  assert.equal(L.rows[0].cost, 42500);
  assert.equal(L.rows[0].consideration, 45000);
});

test('earlier-year history builds lots but only the chosen FY is reported', () => {
  const events = [
    ev('old', '2024-05-01T00:00:00Z', { [SOL_MINT]: 1 }),
    ev('sell', '2025-07-01T00:00:00Z', { [SOL_MINT]: -1, [USDC]: 200 }),
  ];
  assert.equal(buildLedger(events, valueInr, {}, '2024-25').rows.length, 0);
  const L = buildLedger(events, valueInr, {}, '2025-26');
  assert.equal(L.rows.length, 1);
  assert.equal(L.rows[0].acquired, t('2024-05-01T00:00:00Z'));
});

test('parseTx nets out fee, wSOL wrapping and token-account rent', () => {
  const owner = 'Owner11111111111111111111111111111111111111';
  const tx = {
    blockTime: 1750000000,
    meta: {
      err: null,
      fee: 5000,
      // owner pays: fee 5000 + new token account rent 2039280 + 1 SOL swapped away
      preBalances: [10_000_000_000, 0, 1],
      postBalances: [10_000_000_000 - 5000 - 2039280 - 1_000_000_000, 2039280, 1],
      preTokenBalances: [],
      postTokenBalances: [
        { accountIndex: 1, mint: USDC, owner, uiTokenAmount: { uiAmountString: '150.5' } },
      ],
    },
    transaction: { message: { accountKeys: [{ pubkey: owner }, { pubkey: 'ata' }, { pubkey: 'prog' }] } },
  };
  const p = parseTx(tx, owner, 'sig');
  assert.equal(p.feeSol, 0.000005);
  assert.ok(Math.abs(p.deltas[SOL_MINT] + 1) < 1e-9);
  assert.equal(p.deltas[USDC], 150.5);
});

test('parseTx skips failed transactions', () => {
  assert.equal(parseTx({ meta: { err: { x: 1 } } }, 'o', 's'), null);
});

test('parseTx ignores tokens owned by others', () => {
  const owner = 'Owner11111111111111111111111111111111111111';
  const tx = {
    blockTime: 1,
    meta: {
      err: null, fee: 5000, preBalances: [100000, 5], postBalances: [95000, 5],
      preTokenBalances: [{ accountIndex: 1, mint: BONK, owner: 'someone', uiTokenAmount: { uiAmountString: '5' } }],
      postTokenBalances: [{ accountIndex: 1, mint: BONK, owner: 'someone', uiTokenAmount: { uiAmountString: '9' } }],
    },
    transaction: { message: { accountKeys: [{ pubkey: owner }, { pubkey: 'x' }] } },
  };
  assert.deepEqual(parseTx(tx, owner, 's').deltas, {});
});
