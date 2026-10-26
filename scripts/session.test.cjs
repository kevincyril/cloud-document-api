require('tsx/cjs');
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = require('node:crypto').randomBytes(32).toString('hex');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { issueSession, clearSession, sessionCookie, validCsrf } = require('../src/services/session.ts');
test('production browser sessions use host-only Secure HttpOnly cookies and CSRF protection', () => {
  let issued, cleared;
  const res = { cookie(name, value, options) { issued = { name, value, options }; }, clearCookie(name, options) { cleared = { name, options }; } };
  const body = issueSession(res, { id: require('node:crypto').randomUUID(), role: 'user' });
  assert.equal(sessionCookie, '__Host-return_keeper'); assert.equal(issued.name, sessionCookie);
  assert.equal(issued.options.secure, true); assert.equal(issued.options.httpOnly, true);
  assert.equal(issued.options.sameSite, 'strict'); assert.equal(issued.options.path, '/');
  assert.equal(issued.options.domain, undefined); assert.equal(issued.options.maxAge, 3600000);
  assert.ok(body.expiresAt > Date.now() && body.expiresAt <= Date.now() + 3600000);
  assert.equal(validCsrf(body.csrfToken, body.csrfToken), true);
  assert.equal(validCsrf('wrong', body.csrfToken), false); assert.equal(validCsrf(undefined, body.csrfToken), false);
  clearSession(res); assert.equal(cleared.name, issued.name); assert.equal(cleared.options.secure, true);
});
