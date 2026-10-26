const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(work) { const end = Date.now() + 12000; while (Date.now() < end) { const value = await work(); if (value) return value; await pause(100); } throw new Error('Managed auth browser check timed out'); }
exports.checkBrowser = async (base, { googleOnly = false } = {}) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'managed-auth-browser-'));
  let browser, socket;
  try {
    browser = spawn(process.env.BROWSER_TEST_BINARY || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${directory}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
    const port = await until(async () => { try { return (await readFile(path.join(directory, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; } catch { return false; } });
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    let sequence = 0; const pending = new Map(), errors = [];
    socket.addEventListener('message', event => { const data = JSON.parse(event.data); if (data.method === 'Runtime.exceptionThrown') errors.push(data.params.exceptionDetails.text); const item = pending.get(data.id); if (item) { pending.delete(data.id); data.error ? item.reject(new Error(data.error.message)) : item.resolve(data.result); } });
    function command(method, params = {}) { return new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); }); }
    async function evaluate(expression) { const value = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (value.exceptionDetails) throw new Error(JSON.stringify(value.exceptionDetails)); return value.result.value; }
    const wait = expression => until(() => evaluate(expression));
    await command('Runtime.enable');
    await command('Page.navigate', { url: base + '/app/' });
    await wait('Boolean(window.ManagedAuth?.enabled && document.querySelector("#auth-providers button"))');
    assert.equal(await evaluate('document.querySelector("#auth-providers button").textContent'), 'Continue with Google');
    await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true);
    if (googleOnly) {
      assert.equal(await evaluate('document.getElementById("auth-form").hidden'), true);
      assert.equal(await evaluate('document.getElementById("email-code-request").hidden'), true);
      assert.match(await evaluate('document.getElementById("managed-help").textContent'), /invited testers/);
    } else {
    assert.equal(await evaluate('document.getElementById("auth-form").hidden'), true);
    await evaluate('document.getElementById("code-email").value="verified@example.com"; document.getElementById("email-code-request").requestSubmit()');
    await wait('document.getElementById("notice").textContent.includes("Check your inbox") && !document.getElementById("email-code-confirm").disabled');
    assert.equal(await evaluate('document.getElementById("email-code-send").disabled'),true);
    assert.match(await evaluate('document.getElementById("email-code-send").textContent'),/Send again in/);
    assert.match(await evaluate('document.getElementById("email-code-destination").textContent'),/verified@example.com/);
    assert.equal(await evaluate('document.getElementById("workspace").hidden'), true);
    assert.equal(await evaluate('localStorage.length'), 0);
    assert.equal(await evaluate('Object.values(sessionStorage).some(value => value.includes("refresh_token") || value.includes("access_token"))'), false);
    await evaluate('document.getElementById("email-code-request").requestSubmit()');
    await wait('document.getElementById("notice").textContent.includes("Wait at least 60 seconds") && !document.getElementById("email-code-confirm").disabled');
    await evaluate('document.getElementById("email-code").value="999999"; document.getElementById("email-code-verify").requestSubmit()');
    await wait('document.getElementById("notice").textContent.includes("invalid or expired") && !document.getElementById("email-code-confirm").disabled');
    assert.equal(await evaluate('document.getElementById("workspace").hidden'),true);
    assert.equal(await evaluate('document.getElementById("email-code").value'),'');
    await evaluate('document.getElementById("email-code").value="123456"; document.getElementById("email-code-verify").requestSubmit()');
    await wait('!document.getElementById("workspace").hidden && !document.getElementById("refresh").disabled');
    assert.equal(await evaluate('localStorage.length'), 0);
    assert.equal(await evaluate('Object.values(sessionStorage).some(value => value.includes("refresh_token") || value.includes("access_token"))'), false);
    const reused = await evaluate('(async () => { const cfg = await (await fetch("/auth/config")).json(); const response = await fetch(cfg.url + "/auth/v1/verify", {method:"POST",headers:{"Content-Type":"application/json",apikey:cfg.key},body:JSON.stringify({email:"verified@example.com",token:"123456",type:"email"})}); return response.status; })()');
    assert.equal(reused,403);
    await evaluate('document.getElementById("logout").click()');
    await wait('document.getElementById("workspace").hidden');
    }
    await evaluate('document.querySelector("#auth-providers button").click()');
    await wait('!document.getElementById("workspace").hidden && !document.getElementById("refresh").disabled');
    assert.equal(await evaluate('location.search + location.hash'), '');
    assert.equal(await evaluate('localStorage.length'), 0);
    assert.deepEqual(errors, []);
    await command('Page.reload');
    await wait('!document.getElementById("workspace").hidden && !document.getElementById("refresh").disabled');
    assert.equal(await evaluate('document.cookie.includes("return_keeper")'),false);
    await evaluate('document.getElementById("logout").click()');
    await wait('document.getElementById("workspace").hidden');
    await evaluate('sessionEnd');
    await command('Page.reload');
    await wait('document.readyState==="complete" && Boolean(window.ManagedAuth)');
    assert.equal(await evaluate('document.getElementById("workspace").hidden'),true);
  } finally {
    socket?.close();
    if (browser && browser.exitCode === null) { browser.kill(); await new Promise(resolve => browser.once('exit', resolve)); }
    assert.ok(path.resolve(directory).startsWith(path.join(path.resolve(tmpdir()), 'managed-auth-browser-')));
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
};
