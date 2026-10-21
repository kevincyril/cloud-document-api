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
  function receiptDateReview(text) {
    const lines = String(text).slice(0, 30000).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    // Prefer a transaction date label over unrelated dates elsewhere in a form.
    const labeled = lines.map((line, index) => {
      const label = /\b(?:receipt|purchase|transaction|sale)\s*date\s*:?\s*/i.exec(line);
      if (!label) return null;
      const remainder = line.slice(label.index + label[0].length);
      // Some OCR layouts put a label and its value on adjacent lines.
      return remainder || (/^\d{1,4}[/-]\d{1,2}[/-]\d{2,4}$/.test(lines[index + 1] || '') ? lines[index + 1] : '');
    }).filter(value => value !== null);
    const evidence = labeled.length ? labeled : lines.filter(line => !/due\s*date|payment\s*due|ship(?:ping)?\s*date|delivery\s*date|expir|return\s*(?:by|date|deadline)|\bp\.?\s*o\.?\s*#/i.test(line));
    // A separate labeled date can establish formatting, never the purchase value.
    // Mixed day-first/month-first evidence deliberately establishes no convention.
    const orders = new Set();
    for (const line of lines.filter(line => /\b(?:receipt|purchase|transaction|sale|due|shipping|delivery)\s*date\b|payment\s*(?:is\s*)?due/i.test(line))) {
      for (const match of line.matchAll(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/g)) {
        const a = Number(match[1]), b = Number(match[2]);
        if (a > 12 && b <= 12 && validDate(`${match[3]}-${String(b).padStart(2, '0')}-${String(a).padStart(2, '0')}`)) orders.add('day-first');
        if (b > 12 && a <= 12 && validDate(`${match[3]}-${String(a).padStart(2, '0')}-${String(b).padStart(2, '0')}`)) orders.add('month-first');
      }
    }
    const order = orders.size === 1 ? [...orders][0] : null;
    const dates = new Set(), preferred = new Set(); let invalid = false;
    for (const line of evidence) {
      for (const match of line.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
        if (validDate(match[0])) { dates.add(match[0]); preferred.add(match[0]); } else invalid = true;
      }
      for (const match of line.matchAll(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/g)) {
        const a = Number(match[1]), b = Number(match[2]);
        const options = [`${match[3]}-${String(a).padStart(2, '0')}-${String(b).padStart(2, '0')}`,
          `${match[3]}-${String(b).padStart(2, '0')}-${String(a).padStart(2, '0')}`].filter(validDate);
        if (!options.length) invalid = true;
        options.forEach(date => dates.add(date));
        if (options.length === 1) preferred.add(options[0]);
        else if (order) preferred.add(`${match[3]}-${String(order === 'day-first' ? b : a).padStart(2, '0')}-${String(order === 'day-first' ? a : b).padStart(2, '0')}`);
      }
    }
    const candidates = [...dates].sort();
    const inferredOrder = !invalid && labeled.length > 0 && candidates.length > 1 && order && preferred.size === 1 ? order : null;
    return { purchaseDate: !invalid && candidates.length === 1 ? candidates[0] : inferredOrder ? [...preferred][0] : null,
      candidates: !invalid && candidates.length > 1 ? candidates.slice(0, 4) : [], labeled: labeled.length > 0, inferredOrder };
  }
  function parseReceipt(text) {
    text = String(text).slice(0, 30000);
    const warnings = [];
    const lines = String(text).slice(0, 30000).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const candidates = lines.filter(l => !/synthetic|sample receipt|demo only|no real|not valid|thank you/i.test(l));
    let merchant = null;
    for (const line of candidates.slice(0, 5)) {
      // Separate the business name from a second column's document heading.
      const candidate = line.replace(/\s+(?:(?:sales|tax)\s+)?(?:receipt|invoice)\s*$/i, '').trim();
      if (/^\d+\s|\b(?:bill\s*to|ship\s*to|receipt\s*date|purchase\s*date)\b/i.test(candidate)) break;
      if (/^(?:receipt|invoice|welcome|date|total|subtotal|qty|description)\b/i.test(candidate)) continue;
      if (/^[A-Za-z0-9][A-Za-z0-9 &'’.,()-]{2,99}$/.test(candidate) && (candidate.match(/[A-Za-z]/g) || []).length >= 3) { merchant = candidate; break; }
    }
    if (!merchant) warnings.push('Merchant is uncertain; enter the store name.');
    const dateReview = receiptDateReview(text), purchaseDate = dateReview.purchaseDate;
    if (dateReview.inferredOrder) warnings.push(`Receipt date suggested using ${dateReview.inferredOrder === 'day-first' ? 'day/month/year' : 'month/day/year'} formatting from another labeled date. Verify it or choose the alternative below.`);
    if (!purchaseDate) warnings.push(dateReview.candidates.length ? 'Receipt date is ambiguous. Choose the correct interpretation below or enter it manually.' : 'Purchase date was not clearly identified; check the receipt and enter it if known.');
    if (/due\s*date|payment\s*(?:is\s*)?due/i.test(text)) warnings.push('Payment due dates are not purchase dates or return deadlines.');
    const codes = new Set((text.match(/\b(?:USD|CAD|EUR|GBP|AUD|JPY|KWD)\b/g) || []));
    if (/US\$/.test(text)) codes.add('USD');
    if (/€/.test(text)) codes.add('EUR');
    if (/£/.test(text)) codes.add('GBP');
    let currency = codes.size === 1 ? [...codes][0] : null;
    // Address context is a reviewable suggestion, not proof of currency. Do not
    // guess from a dollar sign alone, a bare state abbreviation, or a filename.
    const usAddress = /\b[A-Za-z][A-Za-z .'-]+,\s*(?:AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\s+\d{5}(?:-\d{4})?\b/.test(text);
    const otherRegion = /\b(?:Canada|Australia|New Zealand|Hong Kong|Singapore)\b|\b[A-Z]\d[A-Z]\s?\d[A-Z]\d\b/i.test(text);
    if (codes.size === 0 && /\$/.test(text) && usAddress && !otherRegion) {
      currency = 'USD'; warnings.push('USD suggested from the US-style address and $ symbol. Verify the currency before saving.');
    }
    if (!currency) warnings.push('Choose the currency. A $ symbol alone can mean USD, CAD, AUD, or another dollar currency.');
    const totals = [];
    const totalLine = /^(?:(?:grand|sale)\s+)?total\s*:?\s*(?:(?:USD|CAD|EUR|GBP|AUD|JPY|KWD|US\$|[$€£])\s*)?(\d{1,9}(?:\.\d{1,3})?)\s*(?:USD|CAD|EUR|GBP|AUD|JPY|KWD)?$/i;
    for (let index = 0; index < lines.length; index++) {
      const line = /^(?:(?:grand|sale)\s+)?total\s*:?$/i.test(lines[index]) ? `${lines[index]} ${lines[index + 1] || ''}` : lines[index];
      const match = line.match(totalLine);
      if (match) totals.push(match[1]);
    }
    let amount = totals.length === 1 ? totals[0] : null;
    const precision = currency ? digits[currency] : 3;
    if (amount && !(new RegExp(`^(0|[1-9]\\d{0,8})${precision ? `(\\.\\d{1,${precision}})?` : ''}$`)).test(amount)) amount = null;
    if (!amount) warnings.push('Total is missing or uncertain; enter the final amount, not subtotal or cash tendered.');
    warnings.push('OCR suggestions may be wrong. Review every field.');
    return { merchant, purchaseDate, amount, currency, warnings };
  }
  return { validDate, addDays, today, status, decimal, parseReceipt, receiptDateReview };
});
