// F7: order sheet. Disputes are lost on vague orders ("good quality",
// "same as sample"). The sheet holds specific terms, and its fingerprint
// (keccak256 of a canonical form) is stored onchain as the order's `ref`,
// so neither side can quietly change the terms later.
import { keccak256, toBytes } from 'viem';

export const SHEET_VERSION = 'arra-order-sheet/1';

// Kinds of deal. Imports need delivery terms (who pays shipping); made-to-order
// and service deals don't. Packaging is optional everywhere.
export const KINDS = ['goods', 'custom', 'service'];
const REQUIRED_BY_KIND = {
  goods: ['product', 'quantity', 'unit', 'unitPriceUsd', 'specs', 'shipBy', 'incoterm'],
  custom: ['product', 'quantity', 'unit', 'unitPriceUsd', 'specs', 'shipBy'],
  service: ['product', 'quantity', 'unit', 'unitPriceUsd', 'specs', 'shipBy'],
};

// Phrases that have lost real disputes because nobody can measure them.
export const VAGUE = [
  /good quality/i,
  /high quality/i,
  /same as (the )?sample/i,
  /as (per )?discussed/i,
  /\bstandard\b/i,
  /\bnormal\b/i,
  /\bbest\b/i,
  /\bok(ay)?\b/i,
  /\betc\.?/i,
  // Placeholders that say nothing at all.
  /^\s*(?:[^:]{1,40}:\s*)?(?:n\/?a|tbd|tba|none|nil|-+|\.+|\?+|x+)\s*$/i,
];

/** Lists what is missing or vague, in plain words. Empty list = ready to sign. */
export function reviewSheet(sheet, now = Date.now()) {
  const issues = [];
  const kind = sheet?.kind ?? 'goods';
  if (!KINDS.includes(kind)) issues.push({ field: 'kind', problem: 'must be goods, custom or service' });
  for (const key of REQUIRED_BY_KIND[kind] ?? REQUIRED_BY_KIND.goods) {
    const v = sheet?.[key];
    if (v === undefined || v === null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && v.length === 0)) {
      issues.push({ field: key, problem: 'missing' });
    }
  }
  if (sheet?.quantity !== undefined && !(Number.isInteger(sheet.quantity) && sheet.quantity > 0)) {
    issues.push({ field: 'quantity', problem: 'must be a whole number above zero' });
  }
  if (sheet?.unitPriceUsd !== undefined && !(typeof sheet.unitPriceUsd === 'string' && /^\d+(\.\d{1,6})?$/.test(sheet.unitPriceUsd))) {
    issues.push({ field: 'unitPriceUsd', problem: 'write the price as a number like "2.35"' });
  }
  if (sheet?.shipBy && !/^\d{4}-\d{2}-\d{2}$/.test(sheet.shipBy)) {
    issues.push({ field: 'shipBy', problem: 'use a date like 2026-12-15' });
  } else if (sheet?.shipBy) {
    const d = new Date(`${sheet.shipBy}T23:59:59Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== sheet.shipBy) issues.push({ field: 'shipBy', problem: "that date doesn't exist" });
    else if (d.getTime() < now) issues.push({ field: 'shipBy', problem: 'pick a date in the future' });
  }
  // The vault refuses tiny orders (they must be worth more than ten $0.01 agent fees).
  if (!issues.some((i) => i.field === 'quantity' || i.field === 'unitPriceUsd') && typeof sheet?.unitPriceUsd === 'string' && Number.isInteger(sheet?.quantity) && sheet.quantity > 0) {
    if (sheetTotal(sheet) <= 100_000n) issues.push({ field: 'unitPriceUsd', problem: 'the order total must be more than $0.10' });
  }
  const texts = [
    ['product', sheet?.product],
    ['packaging', sheet?.packaging],
    ['inspection', sheet?.inspection],
    ...(Array.isArray(sheet?.specs) ? sheet.specs.map((s, i) => [`specs[${i}]`, s]) : []),
  ];
  for (const [field, text] of texts) {
    if (typeof text !== 'string') continue;
    for (const re of VAGUE) {
      if (re.test(text)) {
        const optional = field === 'packaging' || field === 'inspection';
        issues.push({ field, problem: `"${text.match(re)[0].trim()}" can mean different things to you and the supplier, which is how disputes start. Say exactly what you expect (for example: size, quantity per box, material, colour)${optional ? ', or leave this empty' : ''}.` });
        break;
      }
    }
  }
  return issues;
}

/** Total in USDT base units (6 decimals) from quantity x unit price, no floating point. */
export function sheetTotal(sheet) {
  const [whole, frac = ''] = sheet.unitPriceUsd.split('.');
  const unit = BigInt(whole) * 1_000_000n + BigInt((frac + '000000').slice(0, 6));
  return unit * BigInt(sheet.quantity);
}

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().filter((k) => value[k] !== undefined)
      .map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

/** The exact text both sides see and sign off on. Key order doesn't matter. */
export function canonicalSheet(sheet) {
  return canonical({ ...sheet, version: SHEET_VERSION });
}

/** bytes32 fingerprint passed to ArraVault.createOrder as `ref`. */
export function sheetRef(sheet) {
  return keccak256(toBytes(canonicalSheet(sheet)));
}

/** Anyone holding the sheet can check it matches what is onchain. */
export function matchesRef(sheet, ref) {
  return sheetRef(sheet).toLowerCase() === String(ref).toLowerCase();
}
