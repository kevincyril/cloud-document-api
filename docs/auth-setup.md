# Verified email and social sign-in

The implementation is opt-in. Production continues using the existing login until the settings below are configured and tested. No SMTP account, paid plan, or Apple membership is created by this change.

## Google

1. In [Google Cloud Console](https://console.cloud.google.com/auth/overview), configure Google Auth Platform branding, audience, and contact email. Use only `openid`, `email`, and `profile`. While the app is in Testing, add your email as a test user.
2. Create an OAuth client with application type **Web application**.
3. Authorized JavaScript origin: `https://cloud-document-api.onrender.com`.
4. Authorized redirect URI: `https://xhnfcmpidcnmgsfuktyf.supabase.co/auth/v1/callback`.
5. Open [Supabase Auth providers](https://supabase.com/dashboard/project/xhnfcmpidcnmgsfuktyf/auth/providers), enable Google, and enter the client ID and secret there. Keep the secret out of chat, Git, and browser code.
6. Under Authentication → URL Configuration, set Site URL and an exact allowed redirect URL to `https://cloud-document-api.onrender.com/app/`. Add an explicit local test URL separately if needed.

See [Supabase Google setup](https://supabase.com/docs/guides/auth/social-login/auth-google). Google can be enabled before email registration is ready.

## Email verification

1. Keep the Email provider's **Confirm email** setting enabled. Do not disable it to get around delivery problems.
2. Choose an SMTP provider in your own account and verify a sender/domain you control. Check the provider's costs before signing up; this project does not require a paid plan.
3. Under Supabase → Project Settings → Authentication → SMTP Settings (or Authentication → Email → SMTP), enter the SMTP host, port, username, password, sender address, and sender name supplied by that provider. Put credentials only in the dashboard.
4. Configure the same Site URL and redirect allowlist as above. Send a test, then check inbox and spam folders.

The [built-in Supabase sender](https://supabase.com/docs/guides/auth/auth-smtp) only delivers to authorized project team addresses and is unsuitable for public signup. Set `AUTH_EMAIL_ENABLED=true` only after custom SMTP works. Registration requires verification; verification emails can be resent from the sign-in screen. Password recovery is not included in this change; existing-account linking requires the previous workspace password.

## App configuration

Apply the normal project migration (`npm run db:migrate`), which adds an optional unique Auth identity to users without changing account IDs or receipt ownership. Configure the existing Render service:

```dotenv
AUTH_MODE=supabase
SUPABASE_AUTH_URL=https://xhnfcmpidcnmgsfuktyf.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_YOUR_PUBLIC_KEY
APP_URL=https://cloud-document-api.onrender.com/app/
AUTH_PROVIDERS=google
AUTH_EMAIL_ENABLED=false
AUTH_PUBLIC_ENABLED=false
AUTH_ALLOWED_EMAILS=your-test-google-address@example.com
```

Get the **publishable** key from Supabase → Settings → API Keys. Never put a service-role/secret key in this setting. Enable email only after SMTP and Confirm email are checked. Providers must also be enabled in Supabase. Apple and GitHub buttons appear only when included in `AUTH_PROVIDERS` and configured in Supabase.

For pre-release testing, keep `AUTH_PUBLIC_ENABLED=false` and configure the tester email allowlist **in Render**, not in Git. The server refuses other identities before creating or linking a workspace. The public configuration reveals only that access is restricted; it does not expose the allowlist. With email disabled, the server also requires an OAuth session and an identity from an enabled provider. Set `AUTH_PUBLIC_ENABLED=true` only when the owner approves public access after real Google sign-in and receipt checks. Keep email signup disabled until SMTP is ready.

The existing service is configured directly through Render environment variables; these optional settings are omitted from the baseline Blueprint so syncing it does not reset the rollout. The build command runs the project's checksum-tracked migration runner before starting the app. Do not also run migration 007 manually through the SQL editor, which would bypass its history tracking. To undo the login switch, set `AUTH_MODE=legacy` and deploy the same code; the additive identity column is compatible with legacy login. Do not delete the identity column or existing accounts as a rollback step.

Existing users first authenticate with a verified identity using their existing email, then prove ownership with their previous workspace password. This preserves IDs, documents, and purchases. Matching email alone never links accounts. If the old password is lost, manual ownership recovery is needed; do not delete the old account or automatically link it by email.

Sessions remain in browser memory and last up to one hour. Refreshing signs out. Only PKCE flow verifiers, not access/refresh tokens, are stored in sessionStorage for up to 15 minutes. Open verification links in the browser where registration started; if the verifier is unavailable, try signing in after verification or request a fresh link. Application tokens already issued remain valid until their one-hour expiry after provider logout/revocation or a mode change.

## Apple and release checks

[Apple web login](https://supabase.com/docs/guides/auth/social-login/auth-apple) requires an Apple Developer account, Services ID, signing key, and client-secret rotation. Do not buy a membership just for this demo. Google is sufficient to start.

Before enabling managed login publicly, test actual Google consent/return, cancelled consent, email delivery/verification/resend, an unverified account being refused, and linking an existing workspace without losing receipts. Local automated tests simulate the provider; they cannot prove real inbox delivery or Google consent. Legacy `/auth/login` and `/auth/register` are disabled when managed mode is enabled. Keep `AUTH_MODE=legacy` until these external settings are ready.
