// Run with the local database configured: node --test scripts/processing-concurrency.test.cjs
require('tsx/cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const schema = `concurrency_test_${randomUUID().replaceAll('-', '')}`;
process.env.PGOPTIONS = `-c search_path=${schema},pg_catalog`;
process.env.NODE_ENV = 'test';
process.env.STORAGE_DRIVER = 'local';
process.env.JWT_SECRET = randomUUID();
const { pool } = require('../src/database.ts');
const { migrate } = require('./migrations.cjs');
// Copy the read-only TypeScript exports before the router imports them, so this
// isolated process can pause its reader without modifying production code.
const storagePath = require.resolve('../src/services/storage.ts');
const storage = { ...require(storagePath) };
require.cache[storagePath].exports = storage;
const router = require('../src/routes/documents.ts').default;
const { errorHandler } = require('../src/middleware/error.middleware.ts');

test('processing claims prevent overlap and failures can be retried', { timeout: 20000 }, async () => {
  const userId = randomUUID();
  const documentId = randomUUID();
  const originalRead = storage.readTextFile;
  let key;
  let server;
  let release;
  let first;
  let schemaCreated = false;
  try {
    assert.match(schema, /^concurrency_test_[a-f0-9]{32}$/);
    await pool.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    await migrate(pool, { log: () => {} });
    assert.ok(process.env.JWT_SECRET, 'JWT_SECRET must be configured');
    await pool.query(
      'INSERT INTO users (id, name, email, password_hash) VALUES ($1, $2, $3, $4)',
      [userId, 'Concurrency check', `concurrency-${userId}@example.com`, randomUUID()],
    );
    key = await storage.saveFile(Buffer.from('Concurrent processing test'));
    await pool.query(
      `INSERT INTO documents (id, user_id, original_name, mime_type, size_bytes, storage_key)
       VALUES ($1, $2, 'concurrency.txt', 'text/plain', 26, $3)`,
      [documentId, userId, key],
    );
    const app = express();
    app.use('/documents', router);
    app.use(errorHandler);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const url = `http://127.0.0.1:${server.address().port}/documents/${documentId}/process`;
    const headers = { Authorization: `Bearer ${jwt.sign({ userId, role: 'user' }, process.env.JWT_SECRET, { expiresIn: '1m' })}` };
    const processDocument = (auth = headers) => fetch(url, { method: 'POST', headers: auth, signal: AbortSignal.timeout(10000) });

    // Pause only this test server's file reader so overlap is deterministic.
    let reachedReader;
    const reading = new Promise(resolve => { reachedReader = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    storage.readTextFile = async storageKey => {
      reachedReader();
      await gate;
      return originalRead(storageKey);
    };
    first = processDocument();
    await Promise.race([reading, first.then(() => { throw new Error('Processing did not reach the reader'); })]);
    const state = await pool.query('SELECT status FROM documents WHERE id = $1', [documentId]);
    assert.equal(state.rows[0].status, 'processing');
    assert.equal((await pool.query('SELECT * FROM document_pages WHERE document_id=$1', [documentId])).rowCount, 0);
    const conflict = await processDocument();
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).message, 'Document is already processing');
    const outsider = await processDocument({ Authorization: `Bearer ${jwt.sign({ userId: randomUUID(), role: 'user' }, process.env.JWT_SECRET, { expiresIn: '1m' })}` });
    assert.equal(outsider.status, 404);
    release();
    assert.equal((await first).status, 200);
    storage.readTextFile = originalRead;
    assert.equal((await processDocument()).status, 200, 'Completed documents can be processed again');
    assert.equal((await pool.query('SELECT * FROM document_pages WHERE document_id=$1', [documentId])).rowCount, 1);

    storage.readTextFile = async () => { throw new Error('Simulated file read failure'); };
    assert.equal((await processDocument()).status, 500);
    const failed = await pool.query('SELECT status, extracted_text, word_count, character_count, processed_at FROM documents WHERE id = $1', [documentId]);
    assert.deepEqual(failed.rows[0], { status: 'failed', extracted_text: null, word_count: null, character_count: null, processed_at: null });
    assert.equal((await pool.query('SELECT * FROM document_pages WHERE document_id=$1', [documentId])).rowCount, 0);
    storage.readTextFile = originalRead;
    assert.equal((await processDocument()).status, 200, 'Failed documents can be retried');
  } finally {
    release?.();
    if (first) await first.catch(() => {});
    storage.readTextFile = originalRead;
    if (server) await new Promise(resolve => server.close(resolve));
    try {
      if (key) await storage.deleteFile(key);
      if (schemaCreated) {
        assert.match(schema, /^concurrency_test_[a-f0-9]{32}$/);
        await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
      }
    } finally {
      await pool.end();
    }
  }
});
