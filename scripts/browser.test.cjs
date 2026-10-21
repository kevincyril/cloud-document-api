// Real Edge/Chromium smoke check against an isolated local database schema.
// No production services or user documents are used.
require('tsx/cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { mkdtemp, readFile, writeFile, rm, access } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const jwt = require('jsonwebtoken');
const schema = `browser_test_${randomUUID().replaceAll('-', '')}`;
process.env.PGOPTIONS = `-c search_path=${schema},pg_catalog`;
process.env.NODE_ENV = 'test';
process.env.STORAGE_DRIVER = 'local';
process.env.JWT_SECRET = randomUUID();
process.env.TRUST_PROXY_HOPS = '0';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(work, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await work(); if (result) return result; await pause(100); }
  throw new Error('Browser check timed out');
}

test('browser receipt OCR, review, deadline, private originals, calendar, fallback, and document workspace', { timeout: 180000 }, async () => {
  const binary = process.env.BROWSER_TEST_BINARY || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  await access(binary).catch(() => { throw new Error('Set BROWSER_TEST_BINARY to a local Edge/Chromium executable.'); });
  const directory = await mkdtemp(path.join(tmpdir(), 'document-browser-'));
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
    const root = await fetch(base + '/'); assert.match(root.headers.get('content-type'), /json/);
    const page = await fetch(base + '/app/'); assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
    assert.match(page.headers.get('cache-control'), /no-store/);
    assert.equal((await fetch(base + '/app/../.env')).status, 404);
    const profile = path.join(directory, 'profile');
    browser = spawn(binary, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
    const port = await until(async () => { try { return (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; } catch { return false; } });
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    socket = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    let sequence = 0; const pending = new Map(); const errors = [];
    socket.addEventListener('message', event => { const data = JSON.parse(event.data); if (data.method === 'Runtime.exceptionThrown') errors.push(data.params.exceptionDetails.text); const item = pending.get(data.id); if (item) { pending.delete(data.id); data.error ? item.reject(new Error(data.error.message)) : item.resolve(data.result); } });
    function command(method, params = {}) { return new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); }); }
    async function evaluate(expression) { const r = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error('Browser evaluation failed'); return r.result.value; }
    async function wait(expression, timeout = 12000) { return until(() => evaluate(expression), timeout); }
    await command('Runtime.enable');
    await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
    await command('Page.navigate', { url: base + '/app/' });
    await wait('document.readyState === "complete" && typeof request === "function" && Boolean(document.getElementById("auth-toggle"))');
    const password = randomUUID(), email = `browser-${randomUUID()}@example.com`;
    await evaluate(`document.getElementById('auth-toggle').click(); document.getElementById('name').value='Browser tester'; document.getElementById('email').value=${JSON.stringify(email)}; document.getElementById('password').value=${JSON.stringify(password)}; document.getElementById('auth-form').requestSubmit();`);
    await wait('!document.getElementById("workspace").hidden && !document.getElementById("refresh").disabled');
    assert.equal(await evaluate('localStorage.length + sessionStorage.length'), 0);
    await command('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: path.join(directory, 'downloads') });
    // Actual deployed PNG -> Tesseract worker/WASM/language data -> editable form.
    await evaluate('document.getElementById("sample-receipt").click()');
    await wait('document.getElementById("raw-ocr").textContent.includes("TOTAL") && !document.getElementById("purchase-save").disabled', 60000);
    assert.match(await evaluate('document.getElementById("raw-ocr").textContent'), /MAPLE GOODS/);
    assert.equal(await evaluate('document.getElementById("purchase-merchant").value'), 'MAPLE GOODS');
    assert.equal(await evaluate('document.getElementById("purchase-date").value'), '2026-10-21');
    assert.equal(await evaluate('document.getElementById("purchase-amount").value'), '34.56');
    assert.equal(await evaluate('document.getElementById("purchase-currency").value'), 'USD');
    await wait('document.getElementById("receipt-preview").naturalWidth > 0');
    assert.equal(await evaluate('document.querySelectorAll("iframe").length'), 0);
    await evaluate(`document.getElementById('purchase-amount').value='34.57'; document.getElementById('deadline-source').value='window'; document.getElementById('return-days').value='30'; document.getElementById('deadline-source').dispatchEvent(new Event('input'));`);
    assert.equal(await evaluate('document.getElementById("deadline-date").value'), '2026-11-20');
    assert.equal(await evaluate('document.getElementById("deadline-confirm").checked'), false);
    assert.equal(await evaluate('document.getElementById("purchase-form").checkValidity()'), false);
    await evaluate(`document.getElementById('deadline-confirm').checked=true; { const dt=new DataTransfer(); dt.items.add(new File(['Synthetic policy: check the condition of the item.'], 'sample-policy.txt', {type:'text/plain'})); document.getElementById('policy-file').files=dt.files; } document.getElementById('purchase-form').requestSubmit();`);
    await wait('document.querySelectorAll(".purchase-card").length === 1 && !document.getElementById("purchase-save").disabled');
    const purchaseId = await evaluate('document.querySelector(".purchase-card").dataset.id');
    assert.match(await evaluate('document.querySelector(".purchase-money").textContent'), /USD 34.57/);
    assert.match(await evaluate('document.getElementById("raw-ocr").textContent'), /34.56/);
    await evaluate('document.getElementById("receipt-download").click()');
    const receiptDownload = await until(async () => { try { return await readFile(path.join(directory, 'downloads/synthetic-maple-goods.png')); } catch { return false; } });
    assert.deepEqual(receiptDownload, await readFile(path.resolve(__dirname, '../public/samples/maple-goods.png')));
    await wait('!document.getElementById("purchase-calendar").disabled');
    await evaluate('document.getElementById("purchase-calendar").click()');
    const calendarDownload = await until(async () => { try { return await readFile(path.join(directory, `downloads/return-deadline-${purchaseId}.ics`), 'utf8'); } catch { return false; } });
    assert.match(calendarDownload, /DTSTART;VALUE=DATE:20261120/); assert.ok(!calendarDownload.includes('VALARM'));
    await wait('!document.getElementById("purchase-save").disabled');
    await evaluate('document.getElementById("policy-download").click()');
    assert.equal(await until(async () => { try { return await readFile(path.join(directory,'downloads/sample-policy.txt'),'utf8'); } catch { return false; } }), 'Synthetic policy: check the condition of the item.');
    await wait('!document.getElementById("purchase-save").disabled');
    await evaluate(`document.getElementById('purchase-date').value='2026-10-22'; document.getElementById('purchase-date').dispatchEvent(new Event('input'));`);
    assert.equal(await evaluate('document.getElementById("deadline-confirm").checked'), false);
    assert.equal(await evaluate('document.getElementById("deadline-date").value'), '2026-11-21');
    assert.match(await evaluate('document.querySelector(".purchase-deadline small").textContent'), /2026-11-20/);
    await evaluate(`document.getElementById('purchase-returned').checked=true; document.getElementById('deadline-confirm').checked=true; document.getElementById('purchase-form').requestSubmit();`);
    await wait('document.querySelector(".state-returned") !== null && !document.getElementById("purchase-save").disabled');
    await evaluate(`document.getElementById('editor-close').click(); document.querySelector('.purchase-card button').click()`);
    await wait('document.getElementById("purchase-merchant").value === "MAPLE GOODS" && !document.getElementById("purchase-save").disabled');
    assert.equal(await evaluate('document.getElementById("purchase-amount").value'), '34.57');
    assert.equal(await evaluate('document.getElementById("deadline-date").value'), '2026-11-21');
    assert.equal(await evaluate('document.getElementById("deadline-confirm").checked'), false);
    await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true);
    if (process.env.BROWSER_TEST_TRACKER_MOBILE_SCREENSHOT) {
      const shot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      await writeFile(process.env.BROWSER_TEST_TRACKER_MOBILE_SCREENSHOT, Buffer.from(shot.data, 'base64'));
    }
    await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
    await evaluate('document.getElementById("purchase-merchant").focus()');
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    assert.equal(await evaluate('document.activeElement.id'), 'purchase-date');
    if (process.env.BROWSER_TEST_TRACKER_SCREENSHOT) {
      await evaluate('document.getElementById("purchase-editor").scrollIntoView()');
      const shot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      await writeFile(process.env.BROWSER_TEST_TRACKER_SCREENSHOT, Buffer.from(shot.data, 'base64'));
    }
    // Real JPEG OCR: ambiguous numerical date and $ currency must remain blank.
    await evaluate(`document.getElementById('editor-close').click(); (async()=>{const blob=await (await fetch('/app/samples/cedar-market.jpg')).blob();const dt=new DataTransfer();dt.items.add(new File([blob],'cedar-market.jpg',{type:'image/jpeg'}));document.getElementById('receipt-file').files=dt.files;document.getElementById('receipt-upload-form').requestSubmit();})()`);
    await wait('document.getElementById("raw-ocr").textContent.includes("CEDAR") && !document.getElementById("purchase-save").disabled', 60000);
    assert.equal(await evaluate('document.getElementById("purchase-date").value'), '');
    assert.equal(await evaluate('document.getElementById("purchase-currency").value'), '');
    assert.match(await evaluate('document.getElementById("review-warnings").textContent'), /ambiguous/);
    // Cancellation during initialization removes the frame/worker and allows saving.
    await evaluate('document.getElementById("editor-close").click(); document.getElementById("sample-receipt").click()');
    await wait('!document.getElementById("ocr-progress").hidden');
    await evaluate('document.getElementById("ocr-cancel").click()');
    await wait('!document.getElementById("purchase-save").disabled && document.getElementById("ocr-progress").hidden');
    assert.equal(await evaluate('document.querySelectorAll("iframe").length'),0);
    assert.match(await evaluate('document.getElementById("review-warnings").textContent'), /cancelled/);
    await evaluate(`document.getElementById('purchase-merchant').value='Manual fallback'; document.getElementById('purchase-form').requestSubmit()`);
    await wait('document.querySelectorAll(".purchase-card").length === 2 && !document.getElementById("purchase-save").disabled');
    // A real OCR library load failure must also leave a usable manual form.
    await command('Network.enable');
    await command('Network.setBlockedURLs', { urls: ['*/app/ocr/tesseract.min.js'] });
    await evaluate('document.getElementById("editor-close").click(); document.getElementById("sample-receipt").click()');
    await wait('document.getElementById("review-warnings").textContent.includes("OCR failed") && !document.getElementById("purchase-save").disabled', 15000);
    await command('Network.setBlockedURLs', { urls: [] });
    await evaluate(`document.getElementById('purchase-merchant').value='OCR failure fallback'; document.getElementById('purchase-form').requestSubmit()`);
    await wait('document.querySelectorAll(".purchase-card").length === 3 && !document.getElementById("purchase-save").disabled');
    await evaluate(`document.getElementById('editor-close').click(); document.getElementById('purchase-filter').value='returned'; document.getElementById('purchase-filter').dispatchEvent(new Event('change'));`);
    assert.equal(await evaluate('document.querySelectorAll(".purchase-card").length'),1);
    await evaluate(`document.getElementById('purchase-filter').value='all'; document.getElementById('purchase-filter').dispatchEvent(new Event('change'));document.getElementById('document-workspace').open=true;`);
    const text = '<script>window.injected=true</script>\nHello document world';
    await evaluate(`{ const dt = new DataTransfer(); dt.items.add(new File([${JSON.stringify(text)}], 'browser-test.txt', {type:'text/plain'})); document.getElementById('file').files=dt.files; document.getElementById('upload-form').requestSubmit(); }`);
    await wait('document.getElementById("status").textContent === "uploaded" && !document.getElementById("process").disabled');
    await evaluate('document.getElementById("process").click()');
    await wait('document.getElementById("status").textContent === "completed" && !document.getElementById("process").disabled');
    assert.equal(await evaluate('document.getElementById("text").textContent'), text);
    assert.equal(await evaluate('Boolean(window.injected)'), false);
    assert.equal(await evaluate('document.getElementById("words").textContent'), '4');
    await evaluate("document.getElementById('search-query').value='document'; document.getElementById('search-form').requestSubmit()");
    await wait('document.querySelectorAll(".search-hit").length === 1 && !document.getElementById("search-submit").disabled');
    assert.match(await evaluate('document.querySelector(".search-hit small").textContent'), /Text file/);
    assert.equal(await evaluate('document.querySelector("#search-results script") !== null'), false);
    await evaluate('document.querySelector(".search-hit").click()');
    await wait('document.getElementById("text-heading").textContent === "Source: text file" && !document.getElementById("download").disabled');
    assert.equal(await evaluate('document.getElementById("text").textContent'), text);
    assert.equal(await evaluate('Boolean(window.injected)'), false);
    if (process.env.BROWSER_TEST_SCREENSHOT) {
      const shot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      await writeFile(process.env.BROWSER_TEST_SCREENSHOT, Buffer.from(shot.data, 'base64'));
    }
    await command('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: path.join(directory, 'downloads') });
    await evaluate('document.getElementById("download").click()');
    const downloaded = await until(async () => { try { return await readFile(path.join(directory, 'downloads/browser-test.txt'), 'utf8'); } catch { return false; } }); assert.equal(downloaded, text);
    await wait('!document.getElementById("upload-submit").disabled');
    await evaluate(`{ const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array(5242881)], 'large.txt', {type:'text/plain'})); document.getElementById('file').files=dt.files; document.getElementById('upload-form').requestSubmit(); }`);
    await wait('document.getElementById("notice").textContent.includes("5 MiB") && !document.getElementById("upload-submit").disabled');
    const { createPdfPages } = require('./pdf-fixture.cjs');
    const pdf = createPdfPages(['Cloud PDF round trip test', '', 'Socket network source']);
    const pdfBytes = Array.from(pdf);
    await evaluate(`{ const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array(${JSON.stringify(pdfBytes)})], 'generated.pdf', {type:'application/pdf'})); document.getElementById('file').files=dt.files; document.getElementById('upload-form').requestSubmit(); }`);
    await wait('document.getElementById("document-name").textContent === "generated.pdf" && !document.getElementById("process").disabled');
    await evaluate('document.getElementById("process").click()');
    await wait('document.getElementById("status").textContent === "completed" && !document.getElementById("process").disabled');
    assert.match(await evaluate('document.getElementById("text").textContent'), /Cloud PDF round trip test/);
    await evaluate("document.getElementById('search-query').value='socket'; document.getElementById('search-form').requestSubmit()");
    await wait('document.querySelectorAll(".search-hit").length === 1 && !document.getElementById("search-submit").disabled');
    assert.match(await evaluate('document.querySelector(".search-hit small").textContent'), /PDF page 3/);
    await evaluate('document.querySelector(".search-hit").click()');
    await wait('document.getElementById("text-heading").textContent === "Source: PDF page 3" && !document.getElementById("download").disabled');
    assert.match(await evaluate('document.getElementById("text").textContent'), /Socket network source/);
    assert.doesNotMatch(await evaluate('document.getElementById("text").textContent'), /Cloud PDF/);
    await evaluate('document.getElementById("download").click()');
    const pdfDownload = await until(async () => { try { return await readFile(path.join(directory, 'downloads/generated.pdf')); } catch { return false; } });
    assert.deepEqual(pdfDownload, pdf);
    await wait('!document.getElementById("search-submit").disabled');
    if (process.env.BROWSER_TEST_SCREENSHOT) {
      const shot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      await writeFile(process.env.BROWSER_TEST_SCREENSHOT, Buffer.from(shot.data, 'base64'));
    }
    await evaluate("document.getElementById('search-query').value='zzznomatch'; document.getElementById('search-form').requestSubmit()");
    await wait('document.getElementById("search-status").textContent.startsWith("No matches") && !document.getElementById("search-submit").disabled');
    assert.equal(await evaluate('document.querySelectorAll(".search-hit").length'), 0);
    await wait('!document.getElementById("upload-submit").disabled');
    await evaluate(`{ const dt = new DataTransfer(); dt.items.add(new File(['%PDF-1.7\\ninvalid'], 'damaged.pdf', {type:'application/pdf'})); document.getElementById('file').files=dt.files; document.getElementById('upload-form').requestSubmit(); }`);
    await wait('document.getElementById("document-name").textContent === "damaged.pdf" && !document.getElementById("process").disabled');
    await evaluate('document.getElementById("process").click()');
    await wait('document.getElementById("status").textContent === "failed" && !document.getElementById("process").disabled');
    assert.match(await evaluate('document.getElementById("notice").textContent'), /invalid|damaged/i);
    assert.equal(await evaluate('document.getElementById("process").textContent'), 'Retry extraction');
    // An expired token is rejected by the real backend and clears private UI state.
    const expired = jwt.sign({ userId: randomUUID(), role: 'user' }, process.env.JWT_SECRET, { expiresIn: -1 });
    await wait('!document.getElementById("refresh").disabled');
    await evaluate(`token=${JSON.stringify(expired)}; document.getElementById('refresh').click()`);
    await wait('document.getElementById("workspace").hidden');
    assert.equal(await evaluate('document.getElementById("text").textContent'), '');
    assert.equal(await evaluate('document.getElementById("search-results").children.length'), 0);
    await wait('!document.getElementById("auth-submit").disabled');
    await evaluate(`document.getElementById('name').value='Second tester'; document.getElementById('email').value=${JSON.stringify('second-' + email)}; document.getElementById('password').value=${JSON.stringify(password)}; document.getElementById('auth-form').requestSubmit();`);
    await wait('!document.getElementById("workspace").hidden && !document.getElementById("refresh").disabled');
    assert.equal(await evaluate('document.querySelectorAll(".doc").length'), 0);
    assert.equal(await evaluate('document.querySelectorAll(".purchase-card").length'), 0);
    await command('Page.reload'); await wait('document.readyState === "complete" && Boolean(document.getElementById("auth"))');
    assert.equal(await evaluate('document.getElementById("workspace").hidden'), true);
    await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true);
    assert.deepEqual(errors, []);
  } finally {
    if (socket) socket.close();
    if (browser && browser.exitCode === null) { browser.kill(); await Promise.race([new Promise(resolve => browser.once('exit', resolve)), pause(3000)]); }
    if (server) await new Promise(resolve => server.close(resolve));
    if (created) await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool.end();
    await rm(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 500 });
  }
});
