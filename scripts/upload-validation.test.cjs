require('tsx/cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { upload } = require('../src/middleware/upload.ts');
const { validateDocument } = require('../src/middleware/validate-document.ts');
const { errorHandler } = require('../src/middleware/error.middleware.ts');
const sharp = require('sharp');

test('upload content and multipart validation', async t => {
  const app = express();
  app.post('/upload', upload.single('document'), validateDocument, (_req, res) => res.status(201).json({ status: 'ok' }));
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/upload`;
  try {
    const png = await sharp({ create: { width: 20, height: 30, channels: 3, background: 'white' } }).png().toBuffer();
    const jpeg = await sharp(png).jpeg().toBuffer();
    const wide = await sharp({ create: { width: 8001, height: 1, channels: 3, background: 'white' } }).png().toBuffer();
    const megapixels = await sharp({ create: { width: 4000, height: 4000, channels: 3, background: 'white' } }).png().toBuffer();
    for (const [name, bytes, type, status] of [
      ['valid PNG', png, 'image/png', 201],
      ['valid JPEG', jpeg, 'image/jpeg', 201],
      ['image spoof', Buffer.from('not an image'), 'image/png', 415],
      ['PNG submitted as JPEG', png, 'image/jpeg', 415],
      ['truncated PNG', png.subarray(0, 40), 'image/png', 415],
      ['truncated JPEG', jpeg.subarray(0, jpeg.length - 50), 'image/jpeg', 415],
      ['excessive width', wide, 'image/png', 415],
      ['excessive pixels', megapixels, 'image/png', 415],
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
