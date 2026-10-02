// CSV in Schedule VDA column order, plus a detailed audit CSV.

const IST = 5.5 * 3600 * 1000;
export const istDate = (timeSec) => {
  if (timeSec == null) return '';
  const d = new Date(timeSec * 1000 + IST);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getUTCFullYear()}`;
};

const cell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (rows) => rows.map((r) => r.map(cell).join(',')).join('\n');
const rupees = (v) => (v == null ? '' : Math.round(v));

/** Columns as in ITR Schedule VDA. Amounts are rounded to whole rupees as the form expects. */
export function scheduleVdaCsv(rows, head) {
  return toCsv([
    ['Sl. No.', 'Date of Acquisition', 'Date of Transfer', 'Head under which income to be taxed', 'Cost of Acquisition (₹)', 'Consideration Received (₹)', 'Income from transfer of VDA (₹)'],
    ...rows.map((r, i) => [
      i + 1,
      r.acquired == null ? '' : istDate(r.acquired),
      istDate(r.transferred),
      head,
      rupees(r.cost),
      rupees(r.consideration),
      rupees(r.income),
    ]),
  ]);
}

export function auditCsv(rows, symbol) {
  return toCsv([
    ['Asset', 'Mint', 'Quantity', 'Date of Acquisition', 'Date of Transfer', 'Cost (₹)', 'Consideration (₹)', 'Income (₹)', 'Flags', 'Transaction'],
    ...rows.map((r) => [
      symbol(r.mint), r.mint, r.qty, istDate(r.acquired), istDate(r.transferred),
      r.cost?.toFixed(2), r.consideration?.toFixed(2), r.income?.toFixed(2), r.flags.join(' '),
      `https://solscan.io/tx/${r.signature}`,
    ]),
  ]);
}

export function download(name, text) {
  const blob = new Blob(['﻿', text], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
