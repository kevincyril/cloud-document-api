// All provider responses are simulated; the database uses an isolated schema.
require('tsx/cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const http = require('node:http');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const schema = `managed_auth_test_${randomUUID().replaceAll('-', '')}`;
process.env.PGOPTIONS = `-c search_path=${schema},pg_catalog`;
process.env.AUTH_MODE = 'supabase';
process.env.AUTH_EMAIL_ENABLED = 'true';
process.env.AUTH_PUBLIC_ENABLED = 'true';
process.env.AUTH_PROVIDERS = 'google';
process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test';
process.env.APP_URL = 'http://127.0.0.1:3000/app/';
process.env.NODE_ENV = 'test';
process.env.STORAGE_DRIVER = 'local';
process.env.JWT_SECRET = randomUUID();
const identities = new Map();
test('managed sign-in verifies identities and preserves ownership during linking', { timeout: 30000 }, async t => {
  let otpIssued = false, otpUsed = false, providerPassword = '';
  const provider = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
    if (req.method === 'OPTIONS') { res.end(); return; }
    if (req.url.startsWith('/auth/v1/otp')) {
      let raw = ''; req.on('data', chunk => { raw += chunk; }); req.on('end', () => {
        const input = JSON.parse(raw);
        if (input.email !== 'verified@example.com' && input.create_user === false) { res.writeHead(422); res.end(JSON.stringify({ msg: 'User not found' })); return; }
        otpIssued = true; otpUsed = false; res.end('{}');
      }); return;
    }
    if (req.url.startsWith('/auth/v1/verify')) {
      let raw = ''; req.on('data', chunk => { raw += chunk; }); req.on('end', () => {
        const input = JSON.parse(raw);
        if (!otpIssued || otpUsed || input.token !== '123456' || input.email !== 'verified@example.com' || input.type !== 'email') {
          res.writeHead(403); res.end(JSON.stringify({ code: 'otp_expired', msg: 'Token has expired or is invalid' })); return;
        }
        otpUsed = true;
        res.end(JSON.stringify({ access_token: identities.get('browserToken'), refresh_token: 'simulated-refresh-token', expires_in: 3600, token_type: 'bearer', user: identities.get('verified') }));
      }); return;
    }
    if (req.url.startsWith('/auth/v1/authorize')) {
      const next = new URL(new URL(req.url, 'http://127.0.0.1').searchParams.get('redirect_to'));
      next.searchParams.set('code', 'simulated-authorization-code');
      res.writeHead(302, { Location: next.href }); res.end(); return;
    }
    if (req.url.startsWith('/auth/v1/signup')) { res.end(JSON.stringify({ ...identities.get('verified'), email_confirmed_at: null })); return; }
    if (req.url.startsWith('/auth/v1/resend') || req.url.startsWith('/auth/v1/logout')) { res.end('{}'); return; }
    if (req.url.startsWith('/auth/v1/token')) {
      let raw = ''; req.on('data', chunk => { raw += chunk; }); req.on('end', () => {
        const input = JSON.parse(raw);
        if (req.url.includes('grant_type=password') && (input.email !== 'verified@example.com' || !providerPassword || input.password !== providerPassword)) {
          res.writeHead(400); res.end(JSON.stringify({ code: 'invalid_credentials', msg: 'Invalid login credentials' })); return;
        }
        res.end(JSON.stringify({ access_token: identities.get('browserToken'), refresh_token: 'simulated-refresh-token', expires_in: 3600, token_type: 'bearer', user: identities.get('verified') }));
      }); return;
    }
    const value = identities.get(req.headers.authorization?.replace('Bearer ', ''));
    if (!value) { res.writeHead(401); res.end(JSON.stringify({ msg: 'Invalid token' })); }
    else if (value === 'outage') { res.writeHead(503); res.end(JSON.stringify({ msg: 'private provider details' })); }
    else if (req.method === 'PUT' && req.url.startsWith('/auth/v1/user')) {
      let raw = ''; req.on('data', chunk => { raw += chunk; }); req.on('end', () => {
        const input = JSON.parse(raw);
        if (!otpUsed || typeof input.password !== 'string' || input.password.length < 12) { res.writeHead(403); res.end(JSON.stringify({ msg: 'Verification required' })); return; }
        providerPassword = input.password; res.end(JSON.stringify(value));
      });
    } else res.end(JSON.stringify(value));
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  process.env.SUPABASE_AUTH_URL = `http://127.0.0.1:${provider.address().port}`;
  const compiled = process.env.API_TEST_COMPILED === 'true';
  const { pool } = require(compiled ? '../dist/database.js' : '../src/database.ts');
  const { migrate } = require('./migrations.cjs');
  let server, created = false;
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`); created = true;
    await migrate(pool, { log() {} });
    const { validateServerConfiguration } = require(compiled ? '../dist/config.js' : '../src/config.ts'); validateServerConfiguration();
    const { app } = require(compiled ? '../dist/app.js' : '../src/app.ts');
    server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    async function call(path, body) {
      const res = await fetch(base + '/auth/' + path, { method: body ? 'POST' : 'GET', ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
      return { status: res.status, body: await res.json() };
    }
    const verified = { id: randomUUID(), email: 'verified@example.com', email_confirmed_at: new Date().toISOString(), user_metadata: { name: 'Verified Person', role: 'admin' } };
    identities.set('verified', verified);
    const browserToken = jwt.sign({ sub: verified.id }, 'simulated-provider-secret', { expiresIn: '1h' });
    identities.set('browserToken', browserToken); identities.set(browserToken, verified);
    await t.test('private Google-only preview rejects password sessions and uninvited users', async () => {
      const { config } = require(compiled ? '../dist/config.js' : '../src/config.ts');
      const googleToken = jwt.sign({ sub: verified.id, amr: [{ method: 'oauth' }] }, 'simulated-provider-secret', { expiresIn: '1h' });
      identities.set(googleToken, { ...verified, identities: [{ provider: 'google' }] });
      const emailToken = jwt.sign({ sub: verified.id, amr: [{ method: 'password' }] }, 'simulated-provider-secret', { expiresIn: '1h' });
      identities.set(emailToken, { ...verified, identities: [{ provider: 'google' }] });
      config.AUTH_EMAIL_ENABLED = 'false'; config.AUTH_PUBLIC_ENABLED = 'false'; config.AUTH_ALLOWED_EMAILS = '';
      assert.equal((await call('exchange', { accessToken: emailToken })).status, 403);
      assert.equal((await call('exchange', { accessToken: googleToken })).status, 403);
      assert.equal((await pool.query('SELECT * FROM users')).rowCount, 0);
      config.AUTH_ALLOWED_EMAILS = 'VERIFIED@example.com';
      const allowed = await call('exchange', { accessToken: googleToken });
      assert.equal(allowed.status, 200);
      await pool.query('DELETE FROM users WHERE id = $1 AND auth_user_id = $2', [allowed.body.user.id, verified.id]);
      const otherProviderToken = jwt.sign({ sub: verified.id, amr: [{ method: 'oauth' }] }, 'other-simulated-provider-secret', { expiresIn: '1h' });
      identities.set(otherProviderToken, { ...verified, identities: [{ provider: 'apple' }] });
      assert.equal((await call('exchange', { accessToken: otherProviderToken })).status, 403);
      config.AUTH_EMAIL_ENABLED = 'true'; config.AUTH_PUBLIC_ENABLED = 'true';
    });
    await t.test('configuration contains public settings and old login cannot bypass verification', async () => {
      const cfg = await call('config'); assert.equal(cfg.body.mode, 'supabase'); assert.deepEqual(cfg.body.providers, ['google']);
      assert.equal((await call('login', { email: 'x@example.com', password: 'anything' })).status, 410);
      assert.equal((await call('register', { name: 'X', email: 'x@example.com', password: 'anything' })).status, 410);
    });
    await t.test('invalid, unverified, and anonymous identities never create a workspace', async () => {
      identities.set('unverified', { ...verified, email_confirmed_at: null });
      identities.set('anonymous', { ...verified, is_anonymous: true });
      for (const accessToken of ['invalid', 'unverified', 'anonymous']) assert.equal((await call('exchange', { accessToken })).status, 401);
      assert.equal((await pool.query('SELECT * FROM users')).rowCount, 0);
    });
    let user;
    await t.test('verified identity gets a stable owner ID, never a client-provided admin role', async () => {
      const first = await call('exchange', { accessToken: 'verified', role: 'admin' });
      assert.equal(first.status, 200); user = first.body.user;
      assert.equal(user.role, 'user'); assert.equal(jwt.verify(first.body.token, process.env.JWT_SECRET).userId, user.id);
      assert.ok(!('password_hash' in user));
      const concurrent = await Promise.all([call('exchange', { accessToken: 'verified' }), call('exchange', { accessToken: 'verified' })]);
      for (const result of concurrent) assert.equal(result.body.user.id, user.id);
      assert.equal((await pool.query('SELECT * FROM users')).rowCount, 1);
    });
    await t.test('existing account requires password proof, and linking keeps its documents and role', async () => {
      const id = randomUUID();
      await pool.query("INSERT INTO users(id,name,email,password_hash,role) VALUES($1,'Existing','existing@example.com',$2,'admin')", [id, await bcrypt.hash('old-workspace-password', 4)]);
      const doc = (await pool.query("INSERT INTO documents(user_id,original_name,mime_type,size_bytes,storage_key) VALUES($1,'private.txt','text/plain',12,$2) RETURNING id", [id, randomUUID()])).rows[0];
      identities.set('existing', { ...verified, id: randomUUID(), email: 'existing@example.com' });
      assert.equal((await call('exchange', { accessToken: 'existing' })).status, 428);
      assert.equal((await call('exchange', { accessToken: 'existing', legacyPassword: 'incorrect' })).status, 401);
      assert.equal((await pool.query('SELECT auth_user_id FROM users WHERE id=$1', [id])).rows[0].auth_user_id, null);
      const linked = await call('exchange', { accessToken: 'existing', legacyPassword: 'old-workspace-password' });
      assert.equal(linked.status, 200); assert.equal(linked.body.user.id, id); assert.equal(linked.body.user.role, 'admin');
      assert.equal((await pool.query('SELECT user_id FROM documents WHERE id=$1', [doc.id])).rows[0].user_id, id);
      identities.set('collision', { ...verified, id: randomUUID(), email: 'existing@example.com' });
      assert.equal((await call('exchange', { accessToken: 'collision', legacyPassword: 'old-workspace-password' })).status, 409);
    });
    await t.test('provider outage does not expose internal details', async () => {
      identities.set('outage', 'outage');
      const result = await call('exchange', { accessToken: 'outage' });
      assert.equal(result.status, 503); assert.ok(!JSON.stringify(result.body).includes('private provider'));
    });
    if (process.env.AUTH_BROWSER_TEST === 'true') await t.test('real browser verified password creation, password login, code-based recovery, and OAuth PKCE callback', { timeout: 45000 }, async () => {
      const { config } = require(compiled ? '../dist/config.js' : '../src/config.ts');
      config.APP_URL = base + '/app/';
      await require('./managed-auth-browser-helper.cjs').checkBrowser(base);
      config.AUTH_EMAIL_ENABLED = 'false'; config.AUTH_PUBLIC_ENABLED = 'false'; config.AUTH_ALLOWED_EMAILS = verified.email;
      const googleToken = jwt.sign({ sub: verified.id, amr: [{ method: 'oauth' }] }, 'simulated-provider-secret', { expiresIn: '1h' });
      identities.set('browserToken', googleToken); identities.set(googleToken, { ...verified, identities: [{ provider: 'google' }] });
      await require('./managed-auth-browser-helper.cjs').checkBrowser(base, { googleOnly: true });
    });
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => provider.close(resolve));
    if (created) { assert.match(schema, /^managed_auth_test_[a-f0-9]{32}$/); await pool.query(`DROP SCHEMA "${schema}" CASCADE`); }
    await pool.end();
  }
});
