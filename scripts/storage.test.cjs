require('tsx/cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { createLocalStorage, createSupabaseStorage, StorageUnavailableError } = require('../src/services/storage-provider.ts');

test('local storage preserves bytes and refuses overwrites', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'document-storage-'));
  const storage = createLocalStorage(directory);
  const key = randomUUID();
  try {
    const bytes = Buffer.from('original\r\n🌍');
    await storage.put(key, bytes, 'text/plain');
    await assert.rejects(storage.put(key, Buffer.from('replacement'), 'text/plain'));
    assert.deepEqual(await storage.get(key), bytes);
    await storage.remove(key);
    await assert.rejects(storage.get(key));
  } finally {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('storage service rejects path traversal before accessing files', async () => {
  const storage = require('../src/services/storage.ts');
  for (const key of ['../.env', '..\\.env', '/etc/passwd', 'C:\\Windows\\win.ini']) {
    await assert.rejects(storage.readFileBuffer(key), /Invalid storage key/);
    await assert.rejects(storage.deleteFile(key), /Invalid storage key/);
  }
});

test('Supabase adapter uses authenticated private objects and hides provider errors', async () => {
  const key = randomUUID();
  const secret = 'test-only-server-key';
  const bytes = Buffer.from('private object bytes');
  let saved;
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    res.setHeader('Content-Type', 'application/json');
    if (req.headers.authorization !== `Bearer ${secret}` || req.headers.apikey !== secret) {
      res.writeHead(401); res.end('{}'); return;
    }
    if (req.method === 'POST') {
      saved = Buffer.concat(chunks);
      res.end(JSON.stringify({ Key: `documents/${key}`, Id: key }));
    } else if (req.method === 'GET' && saved) {
      res.setHeader('Content-Type', 'application/octet-stream'); res.end(saved);
    } else if (req.method === 'DELETE') {
      saved = undefined; res.end('[]');
    } else {
      res.writeHead(404); res.end(JSON.stringify({ message: 'private-provider-detail', statusCode: '404', error: 'Not found' }));
    }
  });
  server.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const storage = createSupabaseStorage(`http://127.0.0.1:${server.address().port}`, secret, 'documents');
    await storage.put(key, bytes, 'text/plain');
    assert.equal(requests[0].headers['x-upsert'], 'false');
    assert.deepEqual(await storage.get(key), bytes);
    assert.equal(requests[1].url, `/storage/v1/object/documents/${key}`);
    assert.ok(!requests[1].url.includes('/public/'));
    await storage.remove(key);
    await assert.rejects(storage.get(key), error => error instanceof StorageUnavailableError && !error.message.includes('private-provider-detail'));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
