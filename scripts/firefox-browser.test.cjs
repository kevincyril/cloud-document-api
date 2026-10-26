// Optional real Firefox check using its WebDriver BiDi endpoint; no driver,
// paid service, production schema, or customer receipt is involved.
require('tsx/cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { mkdtemp, mkdir, readFile, writeFile, rm, access } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const schema = `firefox_test_${randomUUID().replaceAll('-', '')}`;
process.env.PGOPTIONS = `-c search_path=${schema},pg_catalog`;
process.env.NODE_ENV = 'test'; process.env.STORAGE_DRIVER = 'local';
process.env.JWT_SECRET = randomUUID(); process.env.TRUST_PROXY_HOPS = '0';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(work, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await work(); if (value) return value; await pause(100); }
  throw Error('Firefox check timed out');
}
test('Firefox real receipt OCR, confirmation, private preview, calendar, cancellation and isolation', { timeout: 180000 }, async () => {
  const binary = process.env.FIREFOX_TEST_BINARY || 'C:/Program Files/Mozilla Firefox/firefox.exe';
  await access(binary);
  const directory = await mkdtemp(path.join(tmpdir(), 'return-firefox-'));
  process.env.UPLOAD_DIR = path.join(directory, 'uploads');
  const { pool } = require('../src/database.ts');
  const { migrate } = require('./migrations.cjs');
  let server, browser, socket, created = false;
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`); created = true;
    await migrate(pool, { log: () => {} });
    const { app } = require('../src/app.ts'); server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const profile = path.join(directory, 'profile'); await mkdir(profile);
    // Avoid first-run external pages; this is an isolated temporary profile.
    await writeFile(path.join(profile, 'user.js'), 'user_pref("browser.shell.checkDefaultBrowser", false);\nuser_pref("browser.startup.homepage_override.mstone", "ignore");\n');
    let output = '';
    browser = spawn(binary, ['--headless', '--no-remote', '--profile', profile, '--remote-debugging-port', '0', 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    browser.stdout.on('data', data => { output += data.toString(); });
    browser.stderr.on('data', data => { output += data.toString(); });
    const endpoint = await until(() => output.match(/WebDriver BiDi listening on (ws:\/\/[^\s]+)/)?.[1], 25000);
    socket = new WebSocket(endpoint.endsWith('/session') ? endpoint : endpoint.replace(/\/$/, '') + '/session');
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    let sequence = 0; const pending = new Map();
    socket.addEventListener('message', event => { const data = JSON.parse(event.data); const item = pending.get(data.id); if (item) { pending.delete(data.id); data.type === 'error' ? item.reject(Error(`${data.error}: ${data.message}`)) : item.resolve(data.result); } });
    function command(method, params = {}) { return new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); }); }
    await command('session.new', { capabilities: {} });
    const context = (await command('browsingContext.getTree')).contexts[0].context;
    async function evaluate(expression) {
      const result = await command('script.evaluate', { expression: `(async()=>{const v=await (${expression});return JSON.stringify(v===undefined?null:v)})()`, target: { context }, awaitPromise: true });
      if (result.type === 'exception') throw Error('Firefox page evaluation failed');
      return JSON.parse(result.result.value);
    }
    const wait = (expression, timeout) => until(() => evaluate(expression), timeout);
    await command('browsingContext.navigate', { context, url: base + '/app/', wait: 'complete' });
    await wait('Boolean(window.ReceiptTracker)');
    await evaluate('(()=>{window.confirm=()=>true;return true})()');
    const password = randomUUID();
    await evaluate(`(()=>{document.getElementById('auth-toggle').click();document.getElementById('name').value='Firefox tester';document.getElementById('email').value=${JSON.stringify(randomUUID() + '@example.com')};document.getElementById('password').value=${JSON.stringify(password)};document.getElementById('auth-form').requestSubmit()})()`);
    await wait('!document.getElementById("workspace").hidden && !document.getElementById("sample-receipt").disabled');
    await evaluate('document.getElementById("sample-receipt").click()');
    await wait('document.getElementById("raw-ocr").textContent.includes("MAPLE GOODS") && !document.getElementById("purchase-save").disabled', 60000);
    assert.equal(await evaluate('document.getElementById("purchase-amount").value'), '34.56');
    await wait('document.getElementById("receipt-preview").naturalWidth>0');
    await evaluate(`(()=>{document.getElementById('purchase-amount').value='34.57';document.getElementById('deadline-source').value='window';document.getElementById('return-days').value='30';document.getElementById('deadline-source').dispatchEvent(new Event('input'))})()`);
    assert.equal(await evaluate('document.getElementById("purchase-form").checkValidity()'), false);
    assert.equal(await evaluate('document.getElementById("deadline-date").value'), '2026-11-20');
    await evaluate(`(()=>{document.getElementById('deadline-confirm').checked=true;document.getElementById('purchase-form').requestSubmit()})()`);
    await wait('document.querySelectorAll(".purchase-card").length===1 && !document.getElementById("purchase-save").disabled');
    const purchaseId = await evaluate('document.querySelector(".purchase-card").dataset.id');
    const receiptId = await evaluate(`(async()=> (await request('/purchases/${purchaseId}')).purchase.receipt_document_id)()`);
    const calendar = await evaluate(`(async()=> (await request('/purchases/${purchaseId}/calendar',{},true)).text())()`);
    assert.match(calendar, /DTSTART;VALUE=DATE:20261120/);
    assert.equal(await evaluate(`(async()=> (await request('/documents/${receiptId}/download',{},true)).size)()`), (await readFile(path.resolve(__dirname, '../public/samples/maple-goods.png'))).length);
    assert.match(await evaluate('document.querySelector(".purchase-money").textContent'), /USD 34.57/);
    await command('browsingContext.setViewport', { context, viewport: { width: 390, height: 844 } });
    assert.equal(await evaluate('document.documentElement.scrollWidth<=window.innerWidth'), true);
    await evaluate(`(()=>{document.getElementById('editor-close').click();document.getElementById('sample-receipt').click()})()`);
    await wait('!document.getElementById("ocr-progress").hidden');
    await evaluate('document.getElementById("ocr-cancel").click()');
    await wait('!document.getElementById("purchase-save").disabled');
    assert.equal(await evaluate('document.querySelectorAll("iframe").length'), 0);
    await evaluate(`(()=>{document.getElementById('logout').click();document.getElementById('name').value='Second Firefox tester';document.getElementById('email').value=${JSON.stringify(randomUUID() + '@example.com')};document.getElementById('password').value=${JSON.stringify(password)};document.getElementById('auth-form').requestSubmit()})()`);
    await wait('!document.getElementById("workspace").hidden && !document.getElementById("sample-receipt").disabled');
    assert.equal(await evaluate('document.querySelectorAll(".purchase-card").length'), 0);
    for (const route of [`/purchases/${purchaseId}`, `/purchases/${purchaseId}/calendar`, `/documents/${receiptId}/download`]) assert.equal(await evaluate(`(async()=> (await fetch(${JSON.stringify(route)},{headers:{Authorization:'Bearer '+token}})).status)()`), 404);
    assert.equal(await evaluate('localStorage.length+sessionStorage.length'), 0);
  } finally {
    if (socket) socket.close();
    if (browser && browser.exitCode === null) { browser.kill(); await Promise.race([new Promise(resolve => browser.once('exit', resolve)), pause(3000)]); }
    if (server) await new Promise(resolve => server.close(resolve));
    if (created) await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool.end();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('return-firefox-'));
    await rm(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 500 });
  }
});
