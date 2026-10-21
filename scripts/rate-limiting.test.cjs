// Run: node --test scripts/rate-limiting.test.cjs
// Uses a temporary HTTP server; no database or real accounts are needed.
require('tsx/cjs');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const express = require('express');
const jwt = require('jsonwebtoken');
const { authenticate } = require('../src/middleware/auth.middleware.ts');
const {
  loginLimiter, registrationLimiter, uploadLimiter, processingLimiter, searchLimiter,
} = require('../src/middleware/rate-limit.middleware.ts');

test('rate limits stop excess requests before route work', async t => {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = randomUUID();
  const userId = randomUUID();
  const tokenFor = id => jwt.sign({ userId: id, role: 'user', nonce: randomUUID() }, process.env.JWT_SECRET, { expiresIn: '1m' });
  const firstToken = tokenFor(userId);
  const app = express();
  let uploads = 0;
  let processing = 0;
  let searches = 0;
  // Deliberately return validation failures: unsuccessful attempts count too.
  app.post('/auth/login', loginLimiter, (_req, res) => res.status(400).json({ status: 'error' }));
  app.post('/auth/register', registrationLimiter, (_req, res) => res.status(400).json({ status: 'error' }));
  app.post('/upload', authenticate, uploadLimiter, (_req, res) => { uploads++; res.json({ status: 'ok' }); });
  app.post('/process', authenticate, processingLimiter, (_req, res) => { processing++; res.json({ status: 'ok' }); });
  app.post('/search', authenticate, searchLimiter, (_req, res) => { searches++; res.json({ status: 'ok' }); });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path, token, extraHeaders = {}) {
    const response = await fetch(base + path, {
      method: 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extraHeaders },
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  }
  function assertBlocked(result) {
    assert.equal(result.status, 429);
    assert.deepEqual(result.body, { status: 'error', message: 'Too many requests; try again later' });
    assert.ok(Number(result.headers.get('retry-after')) > 0);
    assert.ok(result.headers.has('ratelimit'));
    assert.ok(result.headers.has('ratelimit-policy'));
  }
  try {
    await t.test('login attempts have an IP budget that forwarded headers cannot bypass', async () => {
      for (let i = 0; i < 20; i++) assert.equal((await request('/auth/login')).status, 400);
      assertBlocked(await request('/auth/login', undefined, { 'X-Forwarded-For': '198.51.100.1' }));
      assertBlocked(await request('/auth/login', undefined, { 'X-Forwarded-For': '198.51.100.2' }));
    });
    await t.test('registration has a separate, smaller budget', async () => {
      for (let i = 0; i < 5; i++) assert.equal((await request('/auth/register')).status, 400);
      assertBlocked(await request('/auth/register'));
    });
    await t.test('unauthenticated requests stop before the user limiter', async () => {
      assert.equal((await request('/upload')).status, 401);
      assert.equal((await request('/upload', 'invalid-token')).status, 401);
      assert.equal(uploads, 0);
    });
    await t.test('excess uploads stop before file or route work', async () => {
      for (let i = 0; i < 20; i++) assert.equal((await request('/upload', firstToken)).status, 200);
      assertBlocked(await request('/upload', firstToken));
      assert.equal(uploads, 20);
    });
    await t.test('new JWTs for the same user do not reset the budget', async () => {
      assertBlocked(await request('/upload', tokenFor(userId)));
      assert.equal(uploads, 20);
    });
    await t.test('another user behind the same IP has their own budget', async () => {
      assert.equal((await request('/upload', tokenFor(randomUUID()))).status, 200);
      assert.equal(uploads, 21);
    });
    await t.test('processing has its own budget and stops excess work', async () => {
      for (let i = 0; i < 20; i++) assert.equal((await request('/process', firstToken)).status, 200);
      assertBlocked(await request('/process', firstToken));
      assert.equal(processing, 20);
    });
    await t.test('search is authenticated, independently limited, and keyed by verified user', async () => {
      assert.equal((await request('/search')).status, 401);
      for (let i = 0; i < 60; i++) assert.equal((await request('/search', firstToken)).status, 200);
      assertBlocked(await request('/search', tokenFor(userId)));
      assert.equal(searches, 60);
      assert.equal((await request('/search', tokenFor(randomUUID()))).status, 200);
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  }
});
