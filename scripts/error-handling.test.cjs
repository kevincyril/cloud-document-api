// Run: node --test scripts/error-handling.test.cjs
require('tsx/cjs');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const express = require('express');
const { upload } = require('../src/middleware/upload.ts');
const { errorHandler } = require('../src/middleware/error.middleware.ts');

test('JSON error responses for parser, upload, and unexpected failures', async t => {
  const app = express();
  app.use(express.json());
  app.post('/json', (_req, res) => res.json({ status: 'ok' }));
  app.post('/upload', upload.single('document'), (_req, res) => res.json({ status: 'ok' }));
  app.get('/failure', () => { throw new Error('private internal details'); });
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function expectError(path, options, status, message) {
    const response = await fetch(base + path, options);
    assert.equal(response.status, status);
    assert.match(response.headers.get('content-type'), /application\/json/);
    assert.deepEqual(await response.json(), { status: 'error', message });
  }
  try {
    await t.test('malformed JSON', () => expectError('/json', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"password":',
    }, 400, 'Invalid JSON request body'));
    await t.test('oversized JSON', () => expectError('/json', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'x'.repeat(110000) }),
    }, 413, 'Request body is too large'));
    for (const [name, field, type, bytes, status, message] of [
      ['unsupported file type', 'document', 'image/gif', 8, 415, 'Only PDF, UTF-8 text, JPEG, and PNG files are allowed'],
      ['oversized file', 'document', 'text/plain', 5 * 1024 * 1024 + 1, 413, 'Document must be 5 MB or smaller'],
      ['wrong multipart field', 'file', 'text/plain', 8, 400, 'Invalid file upload; use a single file in the document field'],
    ]) {
      await t.test(name, async () => {
        const form = new FormData();
        form.append(field, new Blob([Buffer.alloc(bytes)], { type }), 'test-file');
        await expectError('/upload', { method: 'POST', body: form }, status, message);
      });
    }
    await t.test('unexpected error hides internal details', () => expectError('/failure', {}, 500, 'An unexpected error occurred'));
    await t.test('started responses delegate to Express', () => {
      const original = new Error('transfer failed');
      let forwarded;
      errorHandler(original, {}, { headersSent: true }, error => { forwarded = error; });
      assert.equal(forwarded, original);
    });
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
