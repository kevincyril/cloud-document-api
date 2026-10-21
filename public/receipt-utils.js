'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ReceiptUtils = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  const digits = { USD: 2, CAD: 2, EUR: 2, GBP: 2, AUD: 2, JPY: 0, KWD: 3 };
  function validDate(date) {
    return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= '1900-01-01' && date <= '9999-12-31' &&
      Number.isFinite(Date.parse(date + 'T00:00:00Z')) && new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) === date;
  }
  function addDays(date, days) {
    if (!validDate(date) || !Number.isInteger(days) || days < 0 || days > 3650) throw new Error('Enter a valid purchase date and a return window of 1–3650 days.');
    const result = new Date(Date.parse(date + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
    if (!validDate(result)) throw new Error('Calculated date is outside the supported range.');
    return result;
  }
  function today() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function status(p, day = today()) {
    if (p.returned) return { key: 'returned', label: 'Returned', days: null };
    if (!p.deadline_date) return { key: 'no_deadline', label: 'No deadline', days: null };
    if (!validDate(day) || !validDate(p.deadline_date)) throw new Error('Invalid calendar date.');
    const days = (Date.parse(p.deadline_date + 'T00:00:00Z') - Date.parse(day + 'T00:00:00Z')) / 86400000;
    return { key: days < 0 ? 'deadline_passed' : days === 0 ? 'due_today' : days <= 7 ? 'due_soon' : 'upcoming',
      label: days < 0 ? 'Deadline passed' : days === 0 ? 'Due today' : days <= 7 ? 'Due soon' : 'Upcoming', days };
  }
  function decimal(minor, currency) {
    const places = digits[currency];
    if (places === undefined || !/^\d+$/.test(String(minor))) return '';
    const value = String(minor).padStart(places + 1, '0');
    return places ? value.slice(0, -places) + '.' + value.slice(-places) : value;
  }
  function parseReceipt(text) {
    const warnings = [];
    const lines = String(text).slice(0, 30000).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const candidates = lines.filter(l => !/synthetic|sample receipt|demo only|no real|not valid|thank you/i.test(l));
    const first = candidates[0] || '';
    const merchant = /^[A-Za-z][A-Za-z &'’.-]{2,79}$/.test(first) && !/receipt|welcome|invoice|total|purchase|date/i.test(first) ? first : null;
    if (!merchant) warnings.push('Merchant is uncertain; enter the store name.');
    const dates = new Set(); let ambiguous = false;
    for (const line of lines) {
      for (const match of line.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
        if (validDate(match[0])) dates.add(match[0]); else ambiguous = true;
      }
      for (const match of line.matchAll(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/g)) {
        const a = Number(match[1]), b = Number(match[2]);
        if (a <= 12 && b <= 12 && a !== b) { ambiguous = true; continue; }
        const month = a > 12 ? b : a, day = a > 12 ? a : b;
        const date = `${match[3]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        if (validDate(date)) dates.add(date); else ambiguous = true;
      }
    }
    const purchaseDate = !ambiguous && dates.size === 1 ? [...dates][0] : null;
    if (!purchaseDate) warnings.push('Purchase date is missing or ambiguous; check the receipt and enter YYYY-MM-DD.');
    const codes = new Set((text.match(/\b(?:USD|CAD|EUR|GBP|AUD|JPY|KWD)\b/g) || []));
    if (/US\$/.test(text)) codes.add('USD');
    if (/€/.test(text)) codes.add('EUR');
    if (/£/.test(text)) codes.add('GBP');
    const currency = codes.size === 1 ? [...codes][0] : null;
    if (!currency) warnings.push('Currency is uncertain. A $ symbol alone does not identify the currency.');
    const totals = [];
    for (const line of lines) {
      const match = line.match(/^(?:(?:grand|sale)\s+)?total\s*:?\s*(?:(?:USD|CAD|EUR|GBP|AUD|JPY|KWD|US\$|[$€£])\s*)?(\d{1,9}(?:\.\d{1,3})?)\s*(?:USD|CAD|EUR|GBP|AUD|JPY|KWD)?$/i);
      if (match) totals.push(match[1]);
    }
    let amount = totals.length === 1 && currency ? totals[0] : null;
    if (amount && !(new RegExp(`^(0|[1-9]\\d{0,8})${digits[currency] ? `(\\.\\d{1,${digits[currency]}})?` : ''}$`)).test(amount)) amount = null;
    if (!amount) warnings.push('Total is missing or uncertain; enter the final amount, not subtotal or cash tendered.');
    warnings.push('OCR suggestions may be wrong. Review every field.');
    return { merchant, purchaseDate, amount, currency, warnings };
  }
  return { validDate, addDays, today, status, decimal, parseReceipt };
});
