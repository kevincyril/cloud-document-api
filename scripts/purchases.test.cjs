require('tsx/cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { amountToMinor, calculateDeadline, deadlineState, isCalendarDate, purchaseSchema } = require('../src/services/purchases.ts');

const purchase = { merchant: 'Demo shop', purchaseDate: '2024-02-28', amount: '19.99', currency: 'USD', deadline: { source: 'none' } };
test('money stays exact and honors currency precision', () => {
  assert.equal(amountToMinor('0.29', 'USD'), '29');
  assert.equal(amountToMinor('999999999.99', 'USD'), '99999999999');
  assert.equal(amountToMinor('1250', 'JPY'), '1250');
  assert.equal(amountToMinor('1.001', 'KWD'), '1001');
  for (const amount of ['1e3', '-1', '01', '1.001', 'NaN', ' 1', '1,000']) assert.throws(() => amountToMinor(amount, 'USD'));
  assert.throws(() => amountToMinor('1.0', 'JPY'));
  assert.equal(purchaseSchema.safeParse({ ...purchase, amount: 19.99 }).success, false);
  assert.equal(purchaseSchema.safeParse({ ...purchase, currency: null }).success, false);
});
test('calendar dates reject ambiguous and normalized invalid dates', () => {
  for (const value of ['02/03/2024', '2023-02-29', '2024-04-31', '2024-1-01', '2024-01-01T00:00:00Z', '1899-12-31']) assert.equal(isCalendarDate(value), false);
  assert.equal(isCalendarDate('2024-02-29'), true);
});
test('windows handle leap years, year boundaries, counting conventions, and overflow', () => {
  assert.equal(calculateDeadline('2024-02-28', 2, false), '2024-03-01');
  assert.equal(calculateDeadline('2024-02-28', 2, true), '2024-02-29');
  assert.equal(calculateDeadline('2023-12-31', 1, false), '2024-01-01');
  assert.equal(calculateDeadline('2023-02-28', 1, false), '2023-03-01');
  assert.throws(() => calculateDeadline('9999-12-31', 1, false));
});
test('deadline states use caller calendar day, including due today and returned', () => {
  assert.deepEqual(deadlineState('2024-03-10', '2024-03-10', false), { status: 'due_today', daysRemaining: 0 });
  assert.deepEqual(deadlineState('2024-03-10', '2024-03-11', false), { status: 'deadline_passed', daysRemaining: -1 });
  assert.equal(deadlineState('2024-03-10', '2024-03-09', false).status, 'due_soon');
  assert.equal(deadlineState(null, '2024-03-09', false).status, 'no_deadline');
  assert.equal(deadlineState('2024-03-10', '2024-03-09', true).status, 'returned');
});
test('manual fallback, corrections, and explicit confirmation', () => {
  assert.equal(purchaseSchema.safeParse({ ...purchase, purchaseDate: null, amount: null, currency: null }).success, true);
  assert.equal(purchaseSchema.safeParse({ ...purchase, merchant: '' }).success, false);
  assert.equal(purchaseSchema.safeParse({ ...purchase, rawOcrText: 'bad\0OCR' }).success, false);
  assert.equal(purchaseSchema.safeParse({ ...purchase, suggestions: { merchant: 'bad\0OCR' } }).success, false);
  assert.equal(purchaseSchema.safeParse({ ...purchase, purchaseDate: '02/03/2024' }).success, false);
  const deadline = { source: 'window', date: '2024-03-01', days: 2, purchaseDayCounts: false, confirmed: true };
  assert.equal(purchaseSchema.safeParse({ ...purchase, deadline }).success, true);
  assert.equal(purchaseSchema.safeParse({ ...purchase, deadline: { ...deadline, confirmed: false } }).success, false);
  assert.equal(purchaseSchema.safeParse({ ...purchase, purchaseDate: '2024-02-29', deadline }).success, false);
  assert.equal(purchaseSchema.safeParse({ ...purchase, deadline: { source: 'manual', date: '2024-02-29' } }).success, false);
  const corrected = purchaseSchema.parse({ ...purchase, rawOcrText: 'TOTAL 1999', suggestions: { amount: '1999' }, amount: '19.99' });
  assert.equal(corrected.amount, '19.99');
  assert.equal(corrected.suggestions.amount, '1999');
  assert.equal(corrected.rawOcrText, 'TOTAL 1999');
});
