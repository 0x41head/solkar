// Turns a jsonParsed Solana transaction into the owner's net balance changes.

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
const LAMPORTS = 1e9;
// Rent-exempt minimum for a 165-byte SPL token account.
const TOKEN_ACCOUNT_RENT = 2039280;
// SOL movements smaller than this (after rent adjustment) are noise.
const SOL_DUST = 0.00001;

/**
 * @returns {null | {signature, time, feeSol, deltas: Record<string, number>}}
 *   deltas are signed UI amounts keyed by mint (native SOL and wSOL merged under SOL_MINT),
 *   excluding the network fee and token-account rent.
 */
export function parseTx(tx, owner, signature) {
  if (!tx || !tx.meta || tx.meta.err) return null;
  const { meta } = tx;
  const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey));
  const deltas = {};
  const add = (mint, amt) => {
    if (!amt) return;
    deltas[mint] = (deltas[mint] || 0) + amt;
  };

  const idx = keys.indexOf(owner);
  let feeSol = 0;
  let lamports = 0;
  if (idx >= 0) {
    lamports = meta.postBalances[idx] - meta.preBalances[idx];
    if (idx === 0) {
      feeSol = meta.fee / LAMPORTS;
      lamports += meta.fee;
    }
  }

  const pre = new Map();
  const post = new Map();
  for (const b of meta.preTokenBalances || []) if (b.owner === owner) pre.set(b.accountIndex, b);
  for (const b of meta.postTokenBalances || []) if (b.owner === owner) post.set(b.accountIndex, b);

  // Token accounts opened (rent paid) or closed (rent refunded) by this tx.
  // Only adjust when the owner signed and paid: a sender who opens the recipient's
  // account pays that rent themselves.
  if (idx === 0) {
    let created = 0;
    let closed = 0;
    for (const i of post.keys()) if (!pre.has(i) && meta.preBalances[i] === 0) created++;
    for (const i of pre.keys()) if (!post.has(i) || meta.postBalances[i] === 0) closed++;
    lamports += (created - closed) * TOKEN_ACCOUNT_RENT;
  }

  for (const i of new Set([...pre.keys(), ...post.keys()])) {
    const a = pre.get(i);
    const b = post.get(i);
    const mint = (a || b).mint;
    const before = a ? Number(a.uiTokenAmount.uiAmountString) : 0;
    const after = b ? Number(b.uiTokenAmount.uiAmountString) : 0;
    add(mint, after - before);
  }

  add(SOL_MINT, lamports / LAMPORTS);
  if (Math.abs(deltas[SOL_MINT] || 0) < SOL_DUST) delete deltas[SOL_MINT];
  for (const m of Object.keys(deltas)) if (Math.abs(deltas[m]) < 1e-12) delete deltas[m];

  return { signature, time: tx.blockTime, feeSol, deltas };
}
