'use strict';
// Only short-lived PKCE verifiers survive navigation. Sessions stay in memory.
function createAuthStorage(storage, now = Date.now) {
  const memory = new Map();
  const verifier = key => key.startsWith('return-keeper-auth-') && key.endsWith('-code-verifier');
  return {
    getItem(key) {
      if (!verifier(key)) return memory.get(key) ?? null;
      const value = storage.getItem(key);
      if (!value) return null;
      try { const item = JSON.parse(value); if (item.expires > now()) return item.value; } catch {}
      storage.removeItem(key); return null;
    },
    setItem(key, value) {
      if (verifier(key)) storage.setItem(key, JSON.stringify({ value, expires: now() + 15 * 60 * 1000 }));
      else memory.set(key, value);
    },
    removeItem(key) { memory.delete(key); if (verifier(key)) storage.removeItem(key); },
    clear() {
      memory.clear();
      for (let i = storage.length - 1; i >= 0; i--) { const key = storage.key(i); if (key && verifier(key)) storage.removeItem(key); }
    },
  };
}
if (typeof module !== 'undefined') module.exports = { createAuthStorage };
if (typeof window !== 'undefined') {
  let client, settings, pendingToken = '', storage, clearing = Promise.resolve();
  const managed = window.ManagedAuth = { enabled: false, clear() {
    pendingToken = ''; $('auth-link').hidden = true; $('legacy-password').value = '';
    // Let the SDK revoke its session before removing its in-memory token.
    // New attempts wait so this cleanup cannot erase a later sign-in.
    if (client) clearing = client.auth.signOut({ scope: 'local' }).catch(() => {}).finally(() => storage.clear());
    else storage?.clear();
  }, submit, ready: null };
  function check(result) { if (result.error) throw new Error(result.error.status === 429 ? 'Too many attempts. Wait before trying again.' : 'Sign-in could not complete. Check your details and verify your email, then try again.'); return result.data; }
  async function exchange(session, legacyPassword) {
    if (!session?.access_token) throw new Error('No sign-in session returned. Sign in again after verifying your email.');
    const response = await fetch('/auth/exchange', { method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store', body: JSON.stringify({ accessToken: session.access_token, legacyPassword }) });
    const body = await response.json();
    if (response.status === 428) { pendingToken = session.access_token; $('auth-link').hidden = false; $('legacy-password').focus(); notice(body.message); return; }
    if (!response.ok) throw new Error(body.message || 'Sign-in failed. Try again.');
    pendingToken = ''; $('auth-link').reset(); $('auth-link').hidden = true;
    await completeSignIn(body);
  }
  async function submit(register) {
    await clearing;
    if (!settings.emailEnabled) throw new Error('Use one of the sign-in providers below.');
    const email = $('email').value.trim(), password = $('password').value;
    if (register) {
      const data = check(await client.auth.signUp({ email, password, options: { emailRedirectTo: settings.redirectTo, data: { name: $('name').value.trim() } } }));
      $('password').value = '';
      if (data.session) { await client.auth.signOut({ scope: 'local' }); throw new Error('Email confirmation must be enabled by the app administrator before registration is available.'); }
      notice('Check your inbox for a verification link. Open it in this browser, then sign in.');
    } else {
      const data = check(await client.auth.signInWithPassword({ email, password }));
      $('password').value = '';
      await exchange(data.session);
    }
  }
  managed.ready = (async () => {
    // Remove callback credentials immediately, including obsolete implicit-flow tokens.
    const callback = new URL(location.href), code = callback.searchParams.get('code'), flowId = callback.searchParams.get('sb_flow_id');
    const callbackError = callback.searchParams.has('error') || location.hash.includes('access_token');
    if (code || callbackError || flowId) history.replaceState(null, '', location.pathname);
    const response = await fetch('/auth/config', { cache: 'no-store' });
    if (!response.ok) throw new Error('Unable to load sign-in settings. Refresh to try again.');
    settings = await response.json();
    if (settings.mode === 'legacy') return;
    if (settings.mode !== 'supabase') throw new Error('Sign-in configuration is unavailable.');
    managed.enabled = true;
    await new Promise((resolve, reject) => { const script = document.createElement('script'); script.src = '/app/auth/supabase.js'; script.onload = resolve; script.onerror = () => reject(new Error('Unable to load sign-in. Refresh to try again.')); document.head.append(script); });
    storage = createAuthStorage(sessionStorage);
    client = window.supabase.createClient(settings.url, settings.key, { global: { fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(10000) }) }, auth: { flowType: 'pkce', storageKey: 'return-keeper-auth', storage, persistSession: true, autoRefreshToken: false, detectSessionInUrl: false } });
    $('managed-options').hidden = false; $('auth-resend').hidden = !settings.emailEnabled;
    $('auth-form').hidden = !settings.emailEnabled;
    $('managed-help').textContent = settings.emailEnabled ? 'Verify your email before signing in, or use a sign-in provider. Existing users: create a verified account with the same email, then enter your previous workspace password once to link your receipts.' : 'Choose a sign-in provider. Existing users can link their receipts with their previous workspace password.';
    if (settings.restricted) $('managed-help').textContent = 'Preview: sign-in is limited to invited testers. ' + $('managed-help').textContent;
    for (const provider of settings.providers) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = `Continue with ${provider === 'github' ? 'GitHub' : provider[0].toUpperCase() + provider.slice(1)}`;
      button.onclick = () => action('Opening sign-in…', async () => { await clearing; check(await client.auth.signInWithOAuth({ provider, options: { redirectTo: settings.redirectTo } })); });
      $('auth-providers').append(button);
    }
    $('auth-resend').onclick = () => action('Sending verification email…', async () => {
      const email = $('email').value.trim(); if (!$('email').checkValidity() || !email) throw new Error('Enter a valid email address first.');
      check(await client.auth.resend({ type: 'signup', email, options: { emailRedirectTo: settings.redirectTo } }));
      notice('If this account needs verification, a new link has been sent. Check your inbox and spam folder.');
    });
    $('auth-link').onsubmit = event => { event.preventDefault(); action('Linking your workspace…', async () => {
      const password = $('legacy-password').value; $('legacy-password').value = '';
      if (!pendingToken) throw new Error('Sign in again before linking your workspace.');
      await exchange({ access_token: pendingToken }, password);
    }); };
    if (callbackError) throw new Error('Sign-in was cancelled or the link is unsupported. Please sign in again.');
    if (code) {
      const result = await client.auth.exchangeCodeForSession(code, flowId ? { flowId } : undefined);
      if (result.error) { notice('This link expired or was opened in another browser. Try signing in with your verified email, or request a new verification link.', true); return; }
      await exchange(result.data.session);
    }
  })();
  // Preserve rejection for submit's readiness check; also display it immediately.
  managed.ready.catch(error => notice(error.message, true));
}
