// Uses an empty, uniquely named schema and upload directory, never public tables.
require('tsx/cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { rm, readdir } = require('node:fs/promises');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const schema = `api_test_${randomUUID().replaceAll('-', '')}`;
const root = path.resolve(__dirname, '..');
const directory = path.join(root, `.test-uploads-${randomUUID()}`);
process.env.PGOPTIONS = `-c search_path=${schema},pg_catalog`;
process.env.NODE_ENV = 'test';
process.env.STORAGE_DRIVER = 'local';
process.env.UPLOAD_DIR = directory;
process.env.JWT_SECRET = randomUUID();
process.env.TRUST_PROXY_HOPS = '0';
const compiled = process.env.API_TEST_COMPILED === 'true';
const { pool } = require(compiled ? '../dist/database.js' : '../src/database.ts');
const { migrate } = require('./migrations.cjs');
const { createPdf } = require('./pdf-fixture.cjs');

test('fresh schema migrations and complete API behavior', { timeout: 45000 }, async t => {
  let server;
  let created = false;
  try {
    assert.match(schema, /^api_test_[a-f0-9]{32}$/);
    await pool.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await migrate(pool, { log: () => {} });
    await migrate(pool, { log: () => {} });
    const history = await pool.query('SELECT name FROM schema_migrations');
    assert.equal(history.rowCount, 6);
    const { app } = require(compiled ? '../dist/app.js' : '../src/app.ts');
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    async function request(route, { token, json, ...options } = {}) {
      const response = await fetch(base + route, {
        ...options,
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(json ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
        ...(json ? { body: JSON.stringify(json) } : {}),
      });
      const body = await response.json();
      return { status: response.status, body, headers: response.headers };
    }
    const password = randomUUID();
    const users = [];
    await t.test('register, login, duplicate registration, and role isolation', async () => {
      for (let i = 0; i < 2; i++) {
        const email = `test-${randomUUID()}@example.com`;
        const registered = await request('/auth/register', { method: 'POST', json: { name: 'Integration tester', email, password, role: 'admin' } });
        assert.equal(registered.status, 201);
        assert.equal(registered.body.user.role, 'user');
        assert.ok(!('password_hash' in registered.body.user));
        const login = await request('/auth/login', { method: 'POST', json: { email: email.toUpperCase(), password } });
        assert.equal(login.status, 200);
        users.push({ id: registered.body.user.id, token: login.body.token, email });
      }
      assert.equal((await request('/auth/me', { token: users[0].token })).body.user.id, users[0].id);
      assert.equal((await request('/auth/admin-test', { token: users[0].token })).status, 403);
      assert.equal((await request('/auth/register', { method: 'POST', json: { name: 'Duplicate', email: users[0].email, password } })).status, 409);
      assert.equal((await request('/auth/register', { method: 'POST', json: { name: 'Too long', email: 'length@example.com', password: '🌍'.repeat(19) } })).status, 400);
      assert.equal((await request('/auth/login', { method: 'POST', json: { email: users[0].email, password: randomUUID() } })).status, 401);
    });
    await t.test('missing, expired, malformed, and wrong-algorithm tokens are rejected', async () => {
      assert.equal((await request('/documents')).status, 401);
      for (const token of [
        'invalid-token',
        jwt.sign({ userId: users[0].id, role: 'user' }, process.env.JWT_SECRET, { expiresIn: -1 }),
        jwt.sign({ userId: 'not-a-uuid', role: 'user' }, process.env.JWT_SECRET),
        jwt.sign({ userId: users[0].id, role: 'user' }, process.env.JWT_SECRET, { algorithm: 'HS384' }),
      ]) assert.equal((await request('/documents', { token })).status, 401);
    });
    let textId;
    const text = 'Testing my document upload API\r\n';
    async function upload(bytes, type, filename = 'test-document') {
      const form = new FormData();
      form.append('document', new Blob([bytes], { type }), filename);
      return request('/documents/upload', { method: 'POST', token: users[0].token, body: form });
    }
    await t.test('text upload, ownership, processing, persistence, and download', async () => {
      const uploaded = await upload(text, 'text/plain', 'test.txt');
      assert.equal(uploaded.status, 201);
      assert.equal(uploaded.body.document.status, 'uploaded');
      textId = uploaded.body.document.id;
      for (const suffix of ['', '/download', '/process']) {
        const denied = await request(`/documents/${textId}${suffix}`, { method: suffix === '/process' ? 'POST' : 'GET', token: users[1].token });
        assert.equal(denied.status, 404);
      }
      assert.deepEqual((await request('/documents', { token: users[1].token })).body.documents, []);
      const processed = await request(`/documents/${textId}/process`, { method: 'POST', token: users[0].token });
      assert.equal(processed.status, 200);
      assert.deepEqual(processed.body.analysis, { text, wordCount: 5, characterCount: 32 });
      const metadata = await request(`/documents/${textId}`, { token: users[0].token });
      assert.equal(metadata.body.document.status, 'completed');
      assert.equal(metadata.body.document.extracted_text, text);
      assert.equal(metadata.body.document.word_count, 5);
      assert.equal(metadata.body.document.character_count, 32);
      assert.ok(metadata.body.document.processed_at);
      const download = await fetch(`${base}/documents/${textId}/download`, { headers: { Authorization: `Bearer ${users[0].token}` } });
      assert.equal(download.status, 200);
      assert.match(download.headers.get('content-disposition'), /attachment/);
      assert.equal(await download.text(), text);
    });
    await t.test('purchases enforce account isolation, document ownership, confirmation, and revisions', async () => {
      const input = { merchant: 'Synthetic shop', purchaseDate: '2024-02-28', amount: '0.29', currency: 'USD',
        receiptDocumentId: textId, rawOcrText: 'TOTAL 029', suggestions: { amount: '029' },
        deadline: { source: 'window', date: '2024-03-01', days: 2, purchaseDayCounts: false, confirmed: true } };
      assert.equal((await request('/purchases', { method: 'POST', json: input })).status, 401);
      const created = await request('/purchases', { method: 'POST', token: users[0].token, json: input });
      assert.equal(created.status, 201);
      const saved = created.body.purchase;
      assert.equal(saved.amount_minor, '29');
      assert.equal(saved.purchase_date, '2024-02-28');
      assert.equal(saved.deadline_date, '2024-03-01');
      assert.equal(saved.suggestions.amount, '029');
      const route = `/purchases/${saved.id}`;
      assert.equal((await request(route, { token: users[1].token })).status, 404);
      assert.deepEqual((await request('/purchases', { token: users[1].token })).body.purchases, []);
      assert.equal((await request(route, { method: 'PUT', token: users[1].token, json: { ...input, receiptDocumentId: null, revision: 1 } })).status, 404);
      for (const key of ['receiptDocumentId', 'policyDocumentId']) {
        const denied = await request('/purchases', { method: 'POST', token: users[1].token, json: { ...input, receiptDocumentId: null, [key]: textId } });
        assert.equal(denied.status, 400);
      }
      // Database protection remains effective if an API ownership check regresses.
      await assert.rejects(pool.query('UPDATE purchases SET user_id = $1 WHERE id = $2', [users[1].id, saved.id]), { code: '23503' });
      await assert.rejects(pool.query('DELETE FROM documents WHERE id = $1', [textId]), { code: '23001' });
      const changedDate = { ...input, purchaseDate: '2024-02-29', revision: 1 };
      assert.equal((await request(route, { method: 'PUT', token: users[0].token, json: changedDate })).status, 400);
      assert.equal((await request(route, { token: users[0].token })).body.purchase.deadline_date, '2024-03-01');
      const corrected = { ...changedDate, deadline: { ...input.deadline, date: '2024-03-02' }, returned: true };
      const updated = await request(route, { method: 'PUT', token: users[0].token, json: corrected });
      assert.equal(updated.status, 200);
      assert.equal(updated.body.purchase.revision, 2);
      assert.equal(updated.body.purchase.deadline_date, '2024-03-02');
      assert.equal((await request(route, { method: 'PUT', token: users[0].token, json: corrected })).status, 409);
      assert.equal((await request('/purchases?returned=false', { token: users[0].token })).body.purchases.length, 0);
      assert.equal((await request('/purchases?returned=true', { token: users[0].token })).body.purchases.length, 1);
      const manual = await request('/purchases', { method: 'POST', token: users[0].token,
        json: { merchant: 'Manual entry after failed OCR', purchaseDate: null, amount: null, currency: null, deadline: { source: 'none' } } });
      assert.equal(manual.status, 201);
      assert.equal(manual.body.purchase.deadline_confirmed_at, null);
      const calendarResponse = await fetch(`${base}${route}/calendar`, { headers: { Authorization: `Bearer ${users[0].token}` } });
      assert.equal(calendarResponse.status, 200);
      assert.match(calendarResponse.headers.get('content-type'), /text\/calendar/);
      assert.match(calendarResponse.headers.get('cache-control'), /no-store/);
      assert.match(await calendarResponse.text(), /DTSTART;VALUE=DATE:20240302/);
      assert.equal((await request(`${route}/calendar`, { token: users[1].token })).status, 404);
      assert.equal((await request(`/purchases/${manual.body.purchase.id}/calendar`, { token: users[0].token })).status, 409);
      const sample = await fetch(base + '/app/samples/maple-goods.png');
      assert.equal(sample.status, 200);
      const sampleBytes = Buffer.from(await sample.arrayBuffer());
      const image = await upload(sampleBytes, 'image/png', 'synthetic-sample.png');
      assert.equal(image.status, 201);
      const imageId = image.body.document.id;
      assert.equal((await request(`/documents/${imageId}`, { token: users[1].token })).status, 404);
      assert.equal((await request(`/documents/${imageId}/download`, { token: users[1].token })).status, 404);
      const original = await fetch(`${base}/documents/${imageId}/download`, { headers: { Authorization: `Bearer ${users[0].token}` } });
      assert.deepEqual(Buffer.from(await original.arrayBuffer()), sampleBytes);
      assert.equal((await request(`/documents/${imageId}/process`, { method: 'POST', token: users[0].token })).status, 415);
      const pageCsp = (await fetch(base + '/app/')).headers.get('content-security-policy');
      assert.ok(!pageCsp.includes('wasm-unsafe-eval'));
      const workerCsp = (await fetch(base + '/app/ocr/worker.min.js')).headers.get('content-security-policy');
      assert.ok(workerCsp.includes('wasm-unsafe-eval'));
      assert.equal((await fetch(base + '/app/ocr/package.json')).status, 404);
    });
    await t.test('PDF extraction round trip and damaged PDF failure', async () => {
      const uploaded = await upload(createPdf(), 'application/pdf', 'fixture.pdf');
      assert.equal(uploaded.status, 201);
      const processed = await request(`/documents/${uploaded.body.document.id}/process`, { method: 'POST', token: users[0].token });
      assert.equal(processed.status, 200);
      assert.equal(processed.body.analysis.wordCount, 5);
      assert.ok(!processed.body.analysis.text.includes('-- 1 of 1 --'));
      const saved = await request(`/documents/${uploaded.body.document.id}`, { token: users[0].token });
      assert.equal(saved.body.document.extracted_text, processed.body.analysis.text);
      const damaged = await upload('%PDF-1.4\nDamaged body', 'application/pdf', 'damaged.pdf');
      assert.equal(damaged.status, 201);
      const result = await request(`/documents/${damaged.body.document.id}/process`, { method: 'POST', token: users[0].token });
      assert.equal(result.status, 422);
      const failed = await request(`/documents/${damaged.body.document.id}`, { token: users[0].token });
      assert.equal(failed.body.document.status, 'failed');
      assert.equal(failed.body.document.extracted_text, null);
    });
    await t.test('database insert failure cleans up the newly stored upload', async () => {
      const before = (await readdir(directory)).sort();
      const query = pool.query.bind(pool);
      pool.query = async (sql, ...args) => {
        if (typeof sql === 'string' && /^INSERT INTO documents/.test(sql)) {
          throw new Error('Simulated metadata insertion failure');
        }
        return query(sql, ...args);
      };
      try {
        const failed = await upload('Cleanup fixture', 'text/plain');
        assert.equal(failed.status, 500);
        assert.equal(failed.body.message, 'An unexpected error occurred');
      } finally { pool.query = query; }
      assert.deepEqual((await readdir(directory)).sort(), before);
    });
    await t.test('invalid input, unknown routes, and API specification return JSON', async () => {
      assert.equal((await upload('fake', 'application/pdf')).status, 415);
      assert.equal((await request('/documents/not-a-uuid', { token: users[0].token })).status, 400);
      assert.equal((await request('/documents?limit=1000', { token: users[0].token })).status, 400);
      assert.equal((await request(`/documents/${randomUUID()}`, { token: users[0].token })).status, 404);
      assert.equal((await request('/no-such-route')).status, 404);
      const spec = await request('/openapi.json');
      assert.equal(spec.status, 200);
      assert.equal(spec.body.openapi, '3.0.3');
      const health = await request('/health');
      assert.equal(health.status, 200);
      assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(health.headers.get('x-powered-by'), null);
    });
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    try {
      if (created) {
        assert.match(schema, /^api_test_[a-f0-9]{32}$/);
        await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
      }
      assert.equal(path.dirname(directory), root);
      assert.ok(path.basename(directory).startsWith('.test-uploads-'));
      await rm(directory, { recursive: true, force: true });
    } finally { await pool.end(); }
  }
});
