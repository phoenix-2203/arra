import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PayeeBook } from '../src/payeeBook.js';

const BUYER = '0x1111111111111111111111111111111111111111';
const A = '0x2222222222222222222222222222222222222222';
const B = '0x3333333333333333333333333333333333333333';

test('new, then known, then changed', () => {
  const book = new PayeeBook();
  assert.equal(book.check(BUYER, 'Guangzhou Textiles', A).status, 'new');
  book.remember(BUYER, 'Guangzhou Textiles', A);
  assert.equal(book.check(BUYER, '  guangzhou   TEXTILES ', A.toUpperCase().replace('0X', '0x')).status, 'known');
  const r = book.check(BUYER, 'Guangzhou Textiles', B);
  assert.equal(r.status, 'changed');
  assert.match(r.message, /NEW address/);
  assert.equal(r.previous.toLowerCase(), A);
});

test('suppliers are tracked per buyer', () => {
  const book = new PayeeBook();
  book.remember(BUYER, 'Shenzhen Parts', A);
  assert.equal(book.check(B, 'Shenzhen Parts', B).status, 'new');
});

test('invalid addresses are rejected', () => {
  assert.equal(new PayeeBook().check(BUYER, 'X', '0x123').status, 'invalid');
});

test('persists to disk', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'arra-')), 'payees.json');
  new PayeeBook(file).remember(BUYER, 'Yiwu Bags', A, 'confirmed-by-phone');
  const again = new PayeeBook(file);
  assert.equal(again.check(BUYER, 'Yiwu Bags', A).status, 'known');
});
