require('tsx/cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const U = require('../public/receipt-utils.js');
const { purchaseCalendar } = require('../src/services/calendar.ts');
test('parser separates final total, currency, merchant, and unambiguous date', () => {
  const raw = 'MAPLE GOODS\nSYNTHETIC SAMPLE RECEIPT\nPurchase date: 2026-10-21\nSubtotal USD 32.00\nTax USD 2.56\nTOTAL USD 34.56\nCash USD 40.00';
  const result = U.parseReceipt(raw);
  assert.equal(result.merchant, 'MAPLE GOODS'); assert.equal(result.purchaseDate, '2026-10-21');
  assert.equal(result.amount, '34.56'); assert.equal(result.currency, 'USD');
  assert.ok(result.warnings.length);
});
test('ambiguous or conflicting receipt fields stay blank', () => {
  for (const date of ['10/11/2026', '2026-02-30', '2026-10-21\n2026-10-22']) assert.equal(U.parseReceipt(`SHOP\n${date}\nTOTAL USD 10.00`).purchaseDate, null);
  assert.equal(U.parseReceipt('SHOP\n21/10/2026\nTOTAL USD 10.00').purchaseDate, '2026-10-21');
  assert.equal(U.parseReceipt('SHOP\nTOTAL $10.00').currency, null);
  assert.equal(U.parseReceipt('SHOP\nTOTAL USD 10.00\nTOTAL USD 11.00').amount, null);
  assert.equal(U.parseReceipt('SHOP\nTOTAL USD 10.00\nEUR').currency, null);
  assert.equal(U.parseReceipt('SHOP\nSubtotal USD 10.00\nCash USD 20.00').amount, null);
  assert.equal(U.parseReceipt('SHOP\nTOTAL JPY 10.01').amount, null);
  assert.equal(U.parseReceipt('SHOP\nTOTAL KWD 1.001').amount, '1.001');
  assert.equal(U.parseReceipt('').merchant, null);
});
test('browser helpers retain exact money and calendar semantics', () => {
  assert.equal(U.decimal('29','USD'), '0.29'); assert.equal(U.decimal('1001','KWD'), '1.001');
  assert.equal(U.decimal('1250','JPY'), '1250'); assert.equal(U.decimal('999999999999','KWD'), '999999999.999');
  assert.equal(U.addDays('2024-02-28',2), '2024-03-01'); assert.equal(U.addDays('2026-12-31',1), '2027-01-01');
  assert.equal(U.status({deadline_date:'2024-03-10',returned:false}, '2024-03-10').key,'due_today');
  assert.equal(U.status({deadline_date:'2024-03-10',returned:false}, '2024-03-11').days,-1);
  assert.equal(U.status({deadline_date:null,returned:false}).key,'no_deadline');
});
test('multi-column receipt headings and dollar totals remain useful without assuming currency', () => {
  const text = 'Example Repair Ltd. RECEIPT\n1912 Example Lane\nReceipt Date 11/02/2019\nP.O.# 23/12/2019\nDueDate 26/02/2019\nSubtotal 145.00\nSales Tax 6.25% 9.06\nTOTAL $154.06';
  const result = U.parseReceipt(text);
  assert.equal(result.merchant, 'Example Repair Ltd.');
  assert.equal(result.amount, '154.06');
  assert.equal(result.currency, null);
  assert.equal(result.purchaseDate, null);
  assert.deepEqual(U.receiptDateReview(text).candidates, ['2019-02-11', '2019-11-02']);
  assert.ok(result.warnings.some(w => /Payment due dates/.test(w)));
  assert.ok(!result.warnings.some(w => /Total is missing/.test(w)));
});
test('receipt date labels exclude payment dates without inventing a purchase date', () => {
  assert.equal(U.parseReceipt('EXAMPLE SHOP\nReceipt Date 21/10/2026\nDue Date 26/10/2026').purchaseDate, '2026-10-21');
  assert.equal(U.parseReceipt('EXAMPLE SHOP\nDueDate 26/10/2026').purchaseDate, null);
  assert.equal(U.parseReceipt('EXAMPLE SHOP\nReceipt Date\n21/10/2026\nDueDate 26/10/2026').purchaseDate, '2026-10-21');
  assert.equal(U.parseReceipt('EXAMPLE SHOP\nReceipt Date 31/02/2026').purchaseDate, null);
  assert.equal(U.parseReceipt('EXAMPLE SHOP\nReceipt Date 10/11/2026').purchaseDate, null);
});
test('standalone headings and split total labels work without choosing subtotal or tendered cash', () => {
  const result = U.parseReceipt('RECEIPT\nExample Repair Ltd.\nSubtotal 145.00\nTOTAL\n$154.06\nCash $200.00');
  assert.equal(result.merchant, 'Example Repair Ltd.'); assert.equal(result.amount, '154.06'); assert.equal(result.currency, null);
  assert.equal(U.parseReceipt('EXAMPLE SHOP\nTOTAL $10.00\nTOTAL $11.00').amount, null);
  assert.equal(U.parseReceipt('EXAMPLE SHOP\nSubtotal $10.00\nCash $20.00').amount, null);
});
test('calendar is an all-day event, escapes injection, and folds UTF-8 by octets', () => {
  const id = randomUUID();
  const text = purchaseCalendar(id, '店'.repeat(60) + ', Shop;\\\r\nBEGIN:VEVENT', '2024-02-29', new Date('2026-10-21T15:30:00Z'));
  assert.match(text, /DTSTART;VALUE=DATE:20240229\r\n/);
  assert.match(text, /DTSTAMP:20261021T153000Z/);
  const unfolded = text.replace(/\r\n /g,'');
  assert.match(unfolded,/\\, Shop\\;\\\\\\nBEGIN:VEVENT/);
  assert.equal(text.split('\r\n').filter(l=>l==='BEGIN:VEVENT').length,1);
  assert.ok(text.split('\r\n').every(l=>Buffer.byteLength(l)<=75));
  assert.ok(!text.includes('VALARM')); assert.ok(!text.includes('TZID'));
  assert.throws(()=>purchaseCalendar(id,'Shop','2023-02-29'));
});
