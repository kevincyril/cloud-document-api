require('tsx/cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { rm, writeFile } = require('node:fs/promises');
const jwt = require('jsonwebtoken');
const { spawnSync } = require('node:child_process');
const schema = `search_test_${randomUUID().replaceAll('-', '')}`;
const directory = path.resolve(__dirname, `../.test-uploads-${randomUUID()}`);
process.env.PGOPTIONS = `-c search_path=${schema},pg_catalog`;
process.env.NODE_ENV = 'test';
process.env.STORAGE_DRIVER = 'local';
process.env.UPLOAD_DIR = directory;
process.env.JWT_SECRET = randomUUID();
process.env.TRUST_PROXY_HOPS = '0';
const compiled = process.env.API_TEST_COMPILED === 'true';
const { pool } = require(compiled ? '../dist/database.js' : '../src/database.ts');
const storage = require(compiled ? '../dist/services/storage.js' : '../src/services/storage.ts');
const { migrate } = require('./migrations.cjs');
const { createPdfPages } = require('./pdf-fixture.cjs');

test('private full-text search and transactional page publication', { timeout: 45000 }, async t => {
  let server, created = false;
  const owner = randomUUID(), other = randomUUID();
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`); created = true;
    await migrate(pool, { log: () => {} });
    await migrate(pool, { log: () => {} });
    for (const id of [owner, other]) await pool.query("INSERT INTO users (id,name,email,password_hash) VALUES ($1,'Search tester',$2,'unused')", [id, `${id}@example.com`]);
    const tokens = new Map([owner, other].map(id => [id, jwt.sign({ userId: id, role: 'user' }, process.env.JWT_SECRET)]));
    const { app } = require(compiled ? '../dist/app.js' : '../src/app.ts');
    server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    async function request(route, id = owner, options = {}) {
      const response = await fetch(base + route, { ...options, headers: id ? { Authorization: `Bearer ${tokens.get(id)}` } : {} });
      return { status: response.status, body: await response.json() };
    }
    async function upload(bytes, type, name, id = owner) {
      const form = new FormData(); form.append('document', new Blob([bytes], { type }), name);
      const result = await request('/documents/upload', id, { method: 'POST', body: form }); assert.equal(result.status, 201); return result.body.document.id;
    }
    const processDocument = id => request(`/documents/${id}/process`, owner, { method: 'POST' });
    const search = (q, id = owner, suffix = '') => request(`/search?q=${encodeURIComponent(q)}${suffix}`, id);
    let pdf, txt;
    await t.test('unauthenticated, invalid, empty, and tokenless lexical queries', async () => {
      assert.equal((await request('/search?q=signal', null)).status, 401);
      for (const query of ['', '?q=', '?q=%20%20', '?q=a&q=b', '?q[x]=a', '?q=%00', '?q=a&limit=51', '?q=a&offset=1001', '?q=a&limit=-1', '?q=a&user_id=' + other, '?q=' + 'a'.repeat(201)]) {
        assert.equal((await request('/search' + query)).status, 400, query);
      }
      assert.deepEqual((await search('the and')).body.results, []);
      assert.deepEqual((await search('zzznomatch')).body.results, []);
    });
    await t.test('correct PDF pages, null text-file page, relevant excerpts, ownership, and pagination', async () => {
      pdf = await upload(createPdfPages(['Orchard apple records', '', 'Harbor signal signal signal report']), 'application/pdf', 'source.pdf');
      txt = await upload('<script>alert("test")</script>\nHarbor signal report', 'text/plain', 'source.txt');
      const otherDoc = await upload('Harbor signal private', 'text/plain', 'private.txt', other);
      assert.equal((await request(`/documents/${otherDoc}/process`, other, { method: 'POST' })).status, 200);
      assert.deepEqual((await search('signal')).body.results, [], 'unprocessed documents are excluded');
      assert.equal((await processDocument(pdf)).status, 200); assert.equal((await processDocument(txt)).status, 200);
      const result = await search('signal'); assert.equal(result.status, 200); assert.equal(result.body.results.length, 2);
      const pdfHit = result.body.results.find(row => row.document_id === pdf), textHit = result.body.results.find(row => row.document_id === txt);
      assert.equal(pdfHit.page_number, 3); assert.equal(pdfHit.unit_index, 3); assert.equal(pdfHit.document_name, 'source.pdf');
      assert.match(pdfHit.excerpt, /signal/i); assert.equal(textHit.page_number, null);
      assert.match(pdfHit.excerpt, /signal signal signal/);
      assert.ok(result.body.results[0].rank >= result.body.results[1].rank);
      assert.ok(result.body.results.every(row => row.excerpt.length <= 600 && !row.excerpt.includes('<b>')));
      const first = (await search('signal', owner, '&limit=1')).body;
      const second = (await search('signal', owner, '&limit=1&offset=1')).body;
      assert.equal(first.pagination.hasMore, true); assert.equal(second.pagination.hasMore, false);
      assert.notEqual(first.results[0].document_id, second.results[0].document_id);
      assert.deepEqual((await search('signal', owner, '&offset=1000')).body.results, []);
      assert.deepEqual((await search('signal', other)).body.results.map(row => row.document_id), [otherDoc]);
      const page = await request(`/documents/${pdf}/units/3`); assert.equal(page.body.unit.page_number, 3); assert.match(page.body.unit.text, /Harbor/);
      assert.equal((await request(`/documents/${pdf}/units/3`, other)).status, 404);
      assert.equal((await request(`/documents/${pdf}/units/99`)).status, 404);
      assert.equal((await request(`/documents/${pdf}/units/0`)).status, 400);
      assert.equal((await request(`/documents/${txt}/units/1`)).body.unit.page_number, null);
    });
    await t.test('reprocessing replaces all pages and removes stale terms without duplicates', async () => {
      const key = (await pool.query('SELECT storage_key FROM documents WHERE id=$1', [pdf])).rows[0].storage_key;
      await writeFile(storage.getFilePath(key), createPdfPages(['Replacement copper records']));
      assert.equal((await processDocument(pdf)).status, 200); assert.equal((await processDocument(pdf)).status, 200);
      const pages = await pool.query('SELECT page_number FROM document_pages WHERE document_id=$1', [pdf]);
      assert.deepEqual(pages.rows, [{ page_number: 1 }]);
      assert.ok(!(await search('signal')).body.results.some(row => row.document_id === pdf));
      assert.equal((await search('copper')).body.results[0].page_number, 1);
    });
    await t.test('completion failure rolls back inserted pages and exposes no stale or partial search results', async () => {
      assert.match(pdf, /^[a-f0-9-]{36}$/);
      await pool.query(`ALTER TABLE documents ADD CONSTRAINT test_reject_completion CHECK (id <> '${pdf}'::uuid OR status <> 'completed') NOT VALID`);
      assert.equal((await processDocument(pdf)).status, 500);
      const failed = (await pool.query('SELECT status, extracted_text, processed_at FROM documents WHERE id=$1', [pdf])).rows[0];
      assert.deepEqual(failed, { status: 'failed', extracted_text: null, processed_at: null });
      assert.equal((await pool.query('SELECT * FROM document_pages WHERE document_id=$1', [pdf])).rowCount, 0);
      assert.deepEqual((await search('copper')).body.results, []);
      await pool.query('ALTER TABLE documents DROP CONSTRAINT test_reject_completion');
      assert.equal((await processDocument(pdf)).status, 200);
      assert.equal((await search('copper')).body.results.length, 1);
    });
    await t.test('empty PDF completes with an explicit no-OCR message and produces no matches', async () => {
      const blank = await upload(createPdfPages(['']), 'application/pdf', 'blank.pdf');
      const response = await processDocument(blank); assert.equal(response.status, 200); assert.match(response.body.message, /No extractable text.*OCR/);
      assert.equal(response.body.analysis.wordCount, 0);
      const rls = await pool.query("SELECT relrowsecurity FROM pg_class WHERE oid='document_pages'::regclass");
      assert.equal(rls.rows[0].relrowsecurity, true);
    });
    await t.test('stopped-instance recovery removes interrupted pages and leaves completed documents intact', async () => {
      await new Promise(resolve => server.close(resolve)); server = undefined;
      await pool.query("UPDATE documents SET status='processing' WHERE id=$1", [pdf]);
      const recovery = spawnSync(process.execPath, [path.resolve(__dirname, 'recover-processing.cjs'), '--confirm-api-stopped'], { env: process.env, encoding: 'utf8', windowsHide: true });
      assert.equal(recovery.status, 0); assert.match(recovery.stdout, /Recovered 1/);
      assert.equal((await pool.query('SELECT * FROM document_pages WHERE document_id=$1', [pdf])).rowCount, 0);
      const state = (await pool.query('SELECT status,extracted_text,processed_at FROM documents WHERE id=$1', [pdf])).rows[0];
      assert.deepEqual(state, { status: 'failed', extracted_text: null, processed_at: null });
      assert.equal((await pool.query('SELECT * FROM document_pages WHERE document_id=$1', [txt])).rowCount, 1);
    });
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    try { if (created) { assert.match(schema, /^search_test_[a-f0-9]{32}$/); await pool.query(`DROP SCHEMA "${schema}" CASCADE`); } }
    finally { await pool.end(); assert.ok(directory.startsWith(path.resolve(__dirname, '..') + path.sep + '.test-uploads-')); await rm(directory, { recursive: true, force: true }); }
  }
});
