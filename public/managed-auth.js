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
  let client, settings, pendingToken = '', pendingEmail = '', resendAfter = 0, cooldownTimer, storage, clearing = Promise.resolve();
  let emailFlow = 'login', verifiedEmail = '', verifiedUntil = 0, passwordTimer;
  function clearVerification() {
    verifiedEmail = ''; verifiedUntil = 0; clearTimeout(passwordTimer);
    $('email-password-set').reset(); $('email-password-set').hidden = true;
    $('password-verified-email').textContent = '';
  }
  async function chooseEmailFlow(flow) {
    clearVerification(); pendingToken = ''; pendingEmail = '';
    $('auth-link').hidden = true; $('legacy-password').value = ''; $('login-password').value = '';
    $('email-code-verify').hidden = true; $('email-code').value = '';
    $('email-code-destination').textContent = '';
    emailFlow = flow;
    $('email-password-login').hidden = flow !== 'login';
    $('email-create').hidden = $('email-forgot').hidden = flow !== 'login';
    $('email-back').hidden = flow === 'login';
    $('email-code-request').hidden = flow === 'login';
    $('email-flow-title').textContent = flow === 'reset' ? 'Reset your password' : 'Verify your email';
    $('email-flow-help').textContent = flow === 'reset' ? 'We will send a verification code if this email has an account. Verify it before choosing a new password.' : 'Verify your email first, then create a password. Already used email codes here? You can set your first password this way too.';
    if (client) { await clearing; clearing = client.auth.signOut({ scope: 'local' }).catch(() => {}).finally(() => storage.clear()); await clearing; }
    sync();
    $(flow === 'login' ? 'login-email' : 'code-email').focus();
  }
  function sync() {
    if (!managed.enabled || !settings?.emailEnabled) return;
    const remaining = Math.max(0, Math.ceil((resendAfter - Date.now()) / 1000));
    $('email-code-send').disabled = busy || remaining > 0;
    $('email-code-send').textContent = remaining ? `Send again in ${remaining}s` : pendingEmail ? 'Resend verification code' : 'Send verification code';
    const status = remaining ? 'A new code can be requested after the wait shown above.' : '';
    if ($('email-resend-status').textContent !== status) $('email-resend-status').textContent = status;
    clearTimeout(cooldownTimer);
    if (remaining) cooldownTimer = setTimeout(sync, 1000);
  }
  const managed = window.ManagedAuth = { enabled: false, clear() {
    clearVerification(); $('email-password-login').reset();
    emailFlow = 'login'; $('email-password-login').hidden = false;
    $('email-create').hidden = $('email-forgot').hidden = false; $('email-back').hidden = true;
    pendingToken = ''; $('auth-link').hidden = true; $('legacy-password').value = '';
    pendingEmail = ''; $('email-code-verify').hidden = true; $('email-code').value = ''; $('email-code-request').reset();
    $('email-code-request').hidden = true;
    $('email-code-destination').textContent = ''; clearTimeout(cooldownTimer);
    // Let the SDK revoke its session before removing its in-memory token.
    // New attempts wait so this cleanup cannot erase a later sign-in.
    if (client) clearing = client.auth.signOut({ scope: 'local' }).catch(() => {}).finally(() => storage.clear());
    else storage?.clear();
    sync();
  }, submit, sync, ready: null };
  function check(result) { if (result.error) throw new Error(result.error.status === 429 ? 'Too many attempts. Wait before trying again.' : 'Sign-in could not complete. Check your details and verify your email, then try again.'); return result.data; }
  async function exchange(session, legacyPassword) {
    await sessionEnd;
    if (!session?.access_token) throw new Error('No sign-in session returned. Sign in again after verifying your email.');
    const response = await fetch('/auth/exchange', { method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store', body: JSON.stringify({ accessToken: session.access_token, legacyPassword }) });
    const body = await response.json();
    if (response.status === 428) { pendingToken = session.access_token; $('auth-link').hidden = false; $('legacy-password').focus(); notice(body.message); return; }
    if (!response.ok) throw new Error(body.message || 'Sign-in failed. Try again.');
    pendingToken = ''; $('auth-link').reset(); $('auth-link').hidden = true;
    await completeSignIn(body);
  }
  async function submit() {
    throw new Error('Use the email and password form or a sign-in provider.');
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
    $('managed-options').hidden = false; $('email-password-options').hidden = !settings.emailEnabled;
    $('auth').classList.add('managed-auth');
    $('auth-form').hidden = true;
    $('managed-help').textContent = settings.emailEnabled ? 'Sign in with your email and password, or Google. New here? Verify your email with a code, then create a password. Previously used email codes? Choose Create an account to set your first password. Existing legacy workspaces still require their previous workspace password to link receipts.' : 'Choose a sign-in provider. Existing users can link their receipts with their previous workspace password.';
    if (settings.restricted) $('managed-help').textContent = 'Preview: sign-in is limited to invited testers. ' + $('managed-help').textContent;
    for (const provider of settings.providers) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = `Continue with ${provider === 'github' ? 'GitHub' : provider[0].toUpperCase() + provider.slice(1)}`;
      button.onclick = () => action('Opening sign-in…', async () => { await chooseEmailFlow('login'); await sessionEnd; await clearing; check(await client.auth.signInWithOAuth({ provider, options: { redirectTo: settings.redirectTo } })); });
      $('auth-providers').append(button);
    }
    $('code-email').oninput = () => {
      clearVerification();
      pendingEmail = ''; pendingToken = ''; $('auth-link').hidden = true; $('legacy-password').value = '';
      $('email-code-verify').hidden = true; $('email-code').value = '';
      $('email-code-destination').textContent = ''; sync();
    };
    for (const [id, flow] of [['email-create', 'create'], ['email-forgot', 'reset'], ['email-back', 'login']]) {
      $(id).onclick = () => action('Preparing sign-in…', async () => {
        $('code-email').value = $('login-email').value.trim(); await chooseEmailFlow(flow); notice();
      });
    }
    $('email-password-login').onsubmit = event => { event.preventDefault(); action('Signing in…', async () => {
      await clearing; await sessionEnd;
      if (!settings.emailEnabled || emailFlow !== 'login') throw new Error('Choose email sign-in first.');
      const email = $('login-email').value.trim().toLowerCase(), password = $('login-password').value;
      $('login-password').value = '';
      const data = check(await client.auth.signInWithPassword({ email, password }));
      await exchange(data.session);
    }); };
    $('email-code-request').onsubmit = event => { event.preventDefault(); action('Sending verification code…', async () => {
      await clearing;
      await sessionEnd;
      if (!settings.emailEnabled) throw new Error('Email sign-in is not enabled.');
      if (!['create', 'reset'].includes(emailFlow)) throw new Error('Choose Create an account or Forgot password first.');
      clearVerification();
      const email = $('code-email').value.trim().toLowerCase();
      if (!$('code-email').checkValidity() || !email) throw new Error('Enter a valid email address first.');
      if (Date.now() < resendAfter) throw new Error('Wait at least 60 seconds before requesting another code.');
      resendAfter = Date.now() + 60000;
      sync();
      const result = await client.auth.signInWithOtp({ email, options: { shouldCreateUser: emailFlow === 'create' } });
      // Do not reveal whether a recovery email exists. The provider still verifies the code.
      if (result.error && !(emailFlow === 'reset' && result.error.status >= 400 && result.error.status < 500 && result.error.status !== 429)) check(result);
      pendingEmail = email; pendingToken = ''; $('auth-link').hidden = true; $('legacy-password').value = '';
      $('email-code').value = ''; $('email-code-verify').hidden = false;
      $('email-code-destination').textContent = emailFlow === 'reset' ? `If ${pendingEmail} has an account, a code will arrive. Edit the email above to use a different address.` : `Code sent to ${pendingEmail}. Edit the email above to use a different address.`;
      $('email-code').focus(); notice('Check your inbox and spam folder for your verification code. Enter the latest code below.');
    }); };
    $('email-code-verify').onsubmit = event => { event.preventDefault(); action('Verifying email…', async () => {
      if (!pendingEmail || pendingEmail !== $('code-email').value.trim().toLowerCase()) throw new Error('Request a code for this email first.');
      const code = $('email-code').value.trim(); $('email-code').value = '';
      if (!/^\d{6,10}$/.test(code)) throw new Error('Enter the numeric code from your email.');
      const result = await client.auth.verifyOtp({ email: pendingEmail, token: code, type: 'email' });
      if (result.error) throw new Error(result.error.status === 429 ? 'Too many attempts. Wait before trying again.' : 'That code is invalid or expired. Try the latest code, or request another.');
      if (!result.data.session?.access_token || result.data.user?.email?.toLowerCase() !== pendingEmail || !result.data.user.email_confirmed_at) throw new Error('Email verification failed. Request another code.');
      verifiedEmail = pendingEmail; verifiedUntil = Date.now() + 10 * 60 * 1000;
      $('email-code-request').hidden = $('email-code-verify').hidden = true;
      $('email-password-title').textContent = emailFlow === 'reset' ? 'Choose a new password' : 'Create your password';
      $('password-verified-email').textContent = `Email verified: ${verifiedEmail}`;
      $('email-password-set').hidden = false; $('new-password').focus();
      passwordTimer = setTimeout(() => action('Verification expired…', async () => { await chooseEmailFlow(emailFlow); notice('Verification expired. Request a new email code.', true); }), 10 * 60 * 1000);
      notice('Email verified. Choose your password to continue.');
    }); };
    $('email-password-set').onsubmit = event => { event.preventDefault(); action('Saving password…', async () => {
      if (!verifiedEmail || Date.now() >= verifiedUntil || verifiedEmail !== pendingEmail) { await chooseEmailFlow(emailFlow); throw new Error('Verification expired. Request a new email code.'); }
      const password = $('new-password').value, confirmation = $('confirm-password').value;
      $('email-password-set').reset();
      if (password.length < 12 || password.length > 128) throw new Error('Use a password between 12 and 128 characters.');
      if (password !== confirmation) throw new Error('Passwords do not match. Enter both again.');
      const result = await client.auth.updateUser({ password });
      if (result.error) throw new Error(result.error.status === 429 ? 'Too many attempts. Wait before trying again.' : 'Password could not be saved. Try a stronger, different password, or request a new code if verification expired.');
      const email = verifiedEmail;
      await chooseEmailFlow('login'); $('login-email').value = email; $('login-password').focus();
      notice('Password saved. Sign in with your email and new password.');
    }); };
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
