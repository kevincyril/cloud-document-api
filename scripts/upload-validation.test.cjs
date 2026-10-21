require('tsx/cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { upload } = require('../src/middleware/upload.ts');
const { validateDocument } = require('../src/middleware/validate-document.ts');
const { errorHandler } = require('../src/middleware/error.middleware.ts');

test('upload content and multipart validation', async t => {
  const app = express();
  app.post('/upload', upload.single('document'), validateDocument, (_req, res) => res.status(201).json({ status: 'ok' }));
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/upload`;
  try {
    for (const [name, bytes, type, status] of [
      ['UTF-8 text', Buffer.from('Hello 🌍\r\n'), 'text/plain', 201],
      ['empty text', Buffer.alloc(0), 'text/plain', 201],
      ['PDF header', Buffer.from('%PDF-1.4\n'), 'application/pdf', 201],
      ['fake PDF MIME', Buffer.from('not a pdf'), 'application/pdf', 415],
      ['invalid UTF-8', Buffer.from([0xff, 0xfe]), 'text/plain', 415],
      ['binary control bytes', Buffer.from([65, 0, 66]), 'text/plain', 415],
    ]) {
      await t.test(name, async () => {
        const form = new FormData();
        form.append('document', new Blob([bytes], { type }), 'sample');
        const response = await fetch(url, { method: 'POST', body: form });
        assert.equal(response.status, status);
        assert.equal((await response.json()).status, status === 201 ? 'ok' : 'error');
      });
    }
    await t.test('extra form fields cannot inject ownership', async () => {
      const form = new FormData();
      form.append('userId', 'other-user');
      form.append('document', new Blob(['text'], { type: 'text/plain' }), 'sample');
      const response = await fetch(url, { method: 'POST', body: form });
      assert.equal(response.status, 400);
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
