require('tsx/cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPdf, createPdfPages } = require('./pdf-fixture.cjs');
const { extractPdfDocument, extractPdfText } = require('../src/services/pdf-processing.ts');
const { extractTextDocument } = require('../src/services/document-extraction.ts');

test('PDF extraction preserves physical page numbers including empty pages', async () => {
  const result = await extractPdfDocument(createPdfPages(['Orchard apples', '', 'Harbor boats']));
  assert.deepEqual(result.units.map(unit => unit.pageNumber), [1, 2, 3]);
  assert.match(result.units[0].text, /Orchard apples/);
  assert.equal(result.units[1].text.trim(), '');
  assert.match(result.units[2].text, /Harbor boats/);
  assert.doesNotMatch(result.units[0].text, /Harbor/);
  assert.doesNotMatch(result.units[2].text, /Orchard/);
  assert.equal(result.hasExtractableText, true);
  assert.match(result.text, /Orchard apples/);
  assert.match(result.text, /Harbor boats/);
});

test('combined text remains compatible and excludes generated page labels', async () => {
  const bytes = createPdf();
  assert.equal((await extractPdfDocument(bytes)).text, 'Cloud PDF round trip test\n\n');
  assert.equal(await extractPdfText(bytes), 'Cloud PDF round trip test\n\n');
});

test('PDFs without text expose an explicit no-text signal without claiming OCR', async () => {
  const result = await extractPdfDocument(createPdfPages(['', '']));
  assert.equal(result.hasExtractableText, false);
  assert.deepEqual(result.units.map(unit => unit.pageNumber), [1, 2]);
  assert.ok(result.units.every(unit => unit.text.trim() === ''));
});

test('malformed PDF extraction rejects rather than returning partial units', async () => {
  await assert.rejects(extractPdfDocument(Buffer.from('%PDF-1.7\ninvalid')));
});

test('text files remain one unit with no invented PDF page reference', () => {
  const text = '<script>example()</script>\r\nUnicode: 🌍\fAnother section';
  const result = extractTextDocument(text);
  assert.deepEqual(result, { text, units: [{ pageNumber: null, text }], hasExtractableText: true });
  assert.equal(extractTextDocument(' \r\n').hasExtractableText, false);
});
