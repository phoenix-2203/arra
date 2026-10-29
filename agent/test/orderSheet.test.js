import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewSheet, sheetRef, matchesRef, sheetTotal, canonicalSheet } from '../src/orderSheet.js';

const good = {
  product: 'Cotton T-shirts, crew neck',
  quantity: 500,
  unit: 'pieces',
  unitPriceUsd: '2.35',
  specs: ['180 gsm 100% combed cotton', 'Sizes: 150 M, 200 L, 150 XL', 'Pantone 19-4052 navy'],
  packaging: '50 per carton, polybag each, carton max 15 kg',
  inspection: 'Buyer photos of 5 random cartons before balance release',
  shipBy: '2026-12-15',
  incoterm: 'FOB Guangzhou',
};

test('a specific sheet has no issues', () => {
  assert.deepEqual(reviewSheet(good), []);
});

test('vague words are flagged with a plain explanation', () => {
  const issues = reviewSheet({ ...good, specs: ['good quality cotton', 'same as sample'] });
  assert.equal(issues.length, 2);
  assert.match(issues[0].problem, /can't be measured/);
});

test('missing and malformed fields are flagged', () => {
  const issues = reviewSheet({ product: 'Shoes', quantity: 0, unitPriceUsd: '$3', shipBy: 'next month' });
  const fields = issues.map((i) => i.field);
  for (const f of ['unit', 'specs', 'incoterm', 'quantity', 'unitPriceUsd', 'shipBy']) {
    assert.ok(fields.includes(f), f);
  }
});

test('total is exact in USDT units', () => {
  assert.equal(sheetTotal(good), 1_175_000_000n); // $1,175.00
  assert.equal(sheetTotal({ quantity: 3, unitPriceUsd: '0.1' }), 300_000n);
});

test('fingerprint ignores key order but catches any change to the terms', () => {
  const reordered = Object.fromEntries(Object.entries(good).reverse());
  assert.equal(sheetRef(reordered), sheetRef(good));
  assert.notEqual(sheetRef({ ...good, quantity: 499 }), sheetRef(good));
  assert.notEqual(sheetRef({ ...good, specs: [...good.specs, 'extra'] }), sheetRef(good));
  assert.match(sheetRef(good), /^0x[0-9a-f]{64}$/);
  assert.ok(matchesRef(good, sheetRef(good).toUpperCase().replace('0X', '0x')));
  assert.ok(canonicalSheet(good).includes('arra-order-sheet/1'));
});

test('service and made-to-order deals do not need shipping terms', () => {
  const service = { kind: 'service', product: 'Logo and brand kit', quantity: 1, unit: 'project', unitPriceUsd: '40', specs: ['3 logo concepts', '2 rounds of changes', 'SVG + PNG files'], shipBy: '2026-12-01' };
  assert.deepEqual(reviewSheet(service), []);
  assert.deepEqual(reviewSheet({ ...service, kind: 'custom' }), []);
  const asGoods = reviewSheet({ ...service, kind: 'goods' }).map((i) => i.field);
  assert.ok(asGoods.includes('incoterm') && !asGoods.includes('packaging'), 'imports need delivery terms; packaging is optional');
  assert.equal(reviewSheet({ ...service, kind: 'loan' })[0].field, 'kind');
  assert.notEqual(sheetRef(service), sheetRef({ ...service, kind: 'custom' }), 'the kind is part of the fingerprint');
});
