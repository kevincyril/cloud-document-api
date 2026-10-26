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
  assert.equal(result.purchaseDate, '2019-02-11');
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
test('US address context prefills dollars as a reviewable USD suggestion', () => {
  const result = U.parseReceipt('EXAMPLE REPAIR\nNew York, NY 12210\nReceipt Date 11/02/2019\nDue Date 26/02/2019\nTOTAL $154.06');
  assert.equal(result.currency, 'USD'); assert.equal(result.purchaseDate, '2019-02-11'); assert.equal(result.amount, '154.06');
  assert.ok(result.warnings.some(w => /USD suggested/.test(w)));
  assert.ok(result.warnings.some(w => /day\/month\/year/.test(w)));
  assert.equal(U.parseReceipt('SHOP\nNew York, NY 12210\nTOTAL CAD 10.00').currency, 'CAD');
  assert.equal(U.parseReceipt('SHOP\nNew York, NY 12210\nCanada\nTOTAL $10.00').currency, null);
  assert.equal(U.parseReceipt('SHOP\nNY\nTOTAL $10.00').currency, null);
  assert.equal(U.parseReceipt('SHOP\nTOTAL $10.00').currency, null);
});
test('consistent date format can prefill a receipt date while conflicting formats cannot', () => {
  assert.equal(U.parseReceipt('SHOP\nReceipt Date 11/02/2019\nDue Date 02/26/2019').purchaseDate, '2019-11-02');
  assert.equal(U.parseReceipt('SHOP\nReceipt Date 11/02/2019\nDue Date 26/02/2019\nDelivery Date 02/27/2019').purchaseDate, null);
  assert.equal(U.parseReceipt('SHOP\nDue Date 26/02/2019').purchaseDate, null);
  assert.equal(U.parseReceipt('SHOP\nReceipt Date 11/02/2019\nP.O.# 26/02/2019').purchaseDate, null);
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
test('purchase CSV preserves exact money, quotes and Unicode while preventing spreadsheet formulas', () => {
  const csv = U.purchasesCsv([{ merchant: '=HYPERLINK("https://example.com")', purchase_date: '2026-10-25', amount_minor: '15406', currency: 'USD', deadline_date: null, returned: false, description: 'Store, "receipt"\nnext line', policy_notes: '  +SUM(1,2)' }, { merchant: '東京', amount_minor: '123', currency: 'JPY', returned: true }, { merchant: 'No total', amount_minor: null, currency: null }]);
  assert.ok(csv.startsWith('\uFEFF"Merchant"'));
  assert.ok(csv.includes('"\'=HYPERLINK(""https://example.com"")"'));
  assert.ok(csv.includes('"154.06","USD"'));
  assert.ok(csv.includes('"123","JPY"'));
  assert.ok(csv.includes('"Store, ""receipt""\nnext line"'));
  assert.ok(csv.includes('"\'  +SUM(1,2)"'));
  assert.ok(csv.includes('"東京"'));
  assert.ok(csv.includes('"No total","","",""'));
});
test('additional receipt layouts normalize totals and explicit dates without guessing conflicts', () => {
  const european = U.parseReceipt('CAFÉ LUMIÈRE\nReceipt Date: 21 October 2026\nNET TOTAL EUR 1.234,56');
  assert.equal(european.merchant, 'CAFÉ LUMIÈRE'); assert.equal(european.purchaseDate,'2026-10-21'); assert.equal(european.amount,'1234.56');
  assert.equal(U.parseReceipt('Merchant: Example Store\nPurchase Date: Oct 21, 2026\nTOTAL PAID USD 1,234.56').amount,'1234.56');
  assert.equal(U.parseReceipt('Example Store\nReceipt Date:\nOctober 21st, 2026\nAMOUNT DUE USD 12.50').purchaseDate,'2026-10-21');
  assert.equal(U.parseReceipt('Example Store\nTOTAL USD 12.50\nBALANCE DUE USD 0.00').amount,'12.50');
  assert.equal(U.parseReceipt('Example Store\nTOTAL EUR 12,50\nTOTAL EUR 12,50').amount,'12.50');
  assert.equal(U.parseReceipt('Example Store\nTOTAL EUR 12,50\nTOTAL EUR 15,50').amount,null);
  assert.equal(U.parseReceipt('Example Store\nReceipt Date: February 30, 2026\nTOTAL USD 12.50').purchaseDate,null);
  assert.equal(U.parseReceipt('Example Store\nReceipt Date: 2026/10/21\nTOTAL USD 12.50').purchaseDate,'2026-10-21');
  assert.equal(U.parseReceipt('Example Store\nTOTAL KWD 1,234').amount,null);
});
test('split currency/total rows and fax glyphs do not fabricate a purchase currency', () => {
  const result = U.parseReceipt('Example Company\nDATE 6/24/2013\nFax: £00) 000-0000\nSUBTOTAL\n£20.12\nTOTAL\n$\n470.12');
  assert.equal(result.purchaseDate,'2013-06-24'); assert.equal(result.amount,'470.12'); assert.equal(result.currency,null);
  assert.equal(U.parseReceipt('SHOP\nFax: £00) 000-0000\nTOTAL 25.00').currency,null);
  assert.equal(U.parseReceipt('SHOP\nTOTAL\nGBP\n25.00').amount,'25.00');
  assert.equal(U.parseReceipt('SHOP\nTOTAL\n£\n25.00').currency,'GBP');
});
test('one lost date separator is recoverable only with date-field evidence and calendar checks', () => {
  assert.equal(U.parseReceipt('Example Company\nDate: 6/242013\nTOTAL $470.12').purchaseDate,'2013-06-24');
  assert.equal(U.parseReceipt('Example Company\nReceipt date: 6/242013\nTOTAL $470.12').purchaseDate,'2013-06-24');
  assert.equal(U.parseReceipt('Example Company\nInvoice # 6/242013\nTOTAL $470.12').purchaseDate,null);
  assert.equal(U.parseReceipt('Example Company\nDate: 6/112013\nTOTAL $470.12').purchaseDate,null);
  assert.equal(U.parseReceipt('Example Company\nDate: 2/302013\nTOTAL $470.12').purchaseDate,null);
});
