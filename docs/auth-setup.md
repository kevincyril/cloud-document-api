# Verified email and social sign-in

Google and passwordless email-code login are deployed as a restricted preview. The owner has configured SMTP/templates and confirmed receiving a code and signing in successfully. Public access remains disabled. No paid plan or Apple membership was created by this change.

## Current rollout status

- Live app: https://cloud-document-api.onrender.com/app/.
- Email-code login was introduced in release `28afd2f`, Render deploy `dep-dbfbaeqjnfac738ok9g0`.
- `AUTH_EMAIL_ENABLED=true`, `AUTH_PROVIDERS=google`, `AUTH_PUBLIC_ENABLED=false`; the tester allowlist is configured privately in Render.
- Migration 007 is applied. The verified test identity is linked to an application account. Direct Supabase Data API reads of the users table remain unavailable to both `anon` and `authenticated` roles.
- Real email delivery and sign-in: confirmed by the owner. Simulated-provider browser tests cover invalid codes, one-time use, resend waiting, Google callbacks, and account linking.
- Real Google consent and sign-in: confirmed by the owner.
- Current SMTP sender: `onboarding@resend.dev`, confirmed by the owner. This test sender is restricted to the Resend account's own email address and cannot support public email-code login. A verified sending domain and a sender on that domain are still needed for other recipients.
- Live health, email-code UI, Google redirect, legacy endpoint blocking, and invalid-token rejection: checked successfully.
- Before opening access: configure a verified sending domain and sender for public email delivery, and verify saving a purchase and seeing it after signing in again. Owner approval is still required to enable public access.

## Google

1. In [Google Cloud Console](https://console.cloud.google.com/auth/overview), configure Google Auth Platform branding, audience, and contact email. Use only `openid`, `email`, and `profile`. While the app is in Testing, add your email as a test user.
2. Create an OAuth client with application type **Web application**.
3. Authorized JavaScript origin: `https://cloud-document-api.onrender.com`.
4. Authorized redirect URI: `https://xhnfcmpidcnmgsfuktyf.supabase.co/auth/v1/callback`.
5. Open [Supabase Auth providers](https://supabase.com/dashboard/project/xhnfcmpidcnmgsfuktyf/auth/providers), enable Google, and enter the client ID and secret there. Keep the secret out of chat, Git, and browser code.
6. Under Authentication → URL Configuration, set Site URL and an exact allowed redirect URL to `https://cloud-document-api.onrender.com/app/`. Add an explicit local test URL separately if needed.

See [Supabase Google setup](https://supabase.com/docs/guides/auth/social-login/auth-google). Google can be enabled before email registration is ready.

## Email sign-in with a verification code

### SMTP quick start with Resend

Create a [Resend account](https://resend.com/) using the same email you will use for the private preview. Choose the free plan for testing. Create an API key in Resend, then enter it directly into Supabase's SMTP password field; never paste it into chat or commit it.

In the [Supabase project](https://supabase.com/dashboard/project/xhnfcmpidcnmgsfuktyf), open Authentication → Email → SMTP Settings (some dashboard layouts place this under Project Settings → Authentication), enable custom SMTP, and enter:

| Setting | Value |
| --- | --- |
| Host | `smtp.resend.com` |
| Port | `465` |
| Username | `resend` |
| Password | Your Resend API key |
| Sender name | `Return Keeper` |
| Sender email for private testing | `onboarding@resend.dev` |

The test sender only sends to the address associated with your Resend account. To send codes to other users, verify a domain you control in Resend and replace the sender with an address on that domain. Do not buy a domain just to test your own login. See [SMTP settings](https://resend.com/docs/send-with-smtp) and [test-sender restrictions](https://resend.com/docs/knowledge-base/403-error-resend-dev-domain).

Save SMTP settings, then complete the email-template steps below. Tell the app maintainer when SMTP and both templates are saved; the new local code must be deployed with email enabled before the code form appears on the live site.

### Templates and delivery checks

1. Keep the Email provider's **Confirm email** setting enabled. Do not disable it to get around delivery problems.
2. Choose an SMTP provider in your own account and verify a sender/domain you control. Check the provider's costs before signing up; this project does not require a paid plan.
3. Under Supabase → Project Settings → Authentication → SMTP Settings (or Authentication → Email → SMTP), enter the SMTP host, port, username, password, sender address, and sender name supplied by that provider. Put credentials only in the dashboard.
4. Under Authentication → Email Templates, update **Magic Link** and **Confirm signup** to show a code. Include `{{ .Token }}` instead of requiring a confirmation-link click. Updating both covers existing and first-time users. For example:

   ```html
   <h2>Your Return Keeper sign-in code</h2>
   <p>Enter this code in the app: <strong>{{ .Token }}</strong></p>
   <p>If you did not request this code, ignore this email.</p>
   ```

5. Under the Email provider settings, choose a short OTP expiry (for example 600 seconds) and use six digits. Keep provider-side rate limits enabled. The app accepts numeric codes of 6–10 digits and enforces a 60-second resend wait; Supabase also limits and verifies attempts.
6. Set `AUTH_EMAIL_ENABLED=true` on the existing Render service and deploy, while keeping `AUTH_PUBLIC_ENABLED=false` and the tester allowlist in place. Test actual inbox delivery, a wrong/expired code, a successful code, and rejection of code reuse before public release.

The [built-in Supabase sender](https://supabase.com/docs/guides/auth/auth-smtp) only delivers to authorized project team addresses and is unsuitable for public signup. Set `AUTH_EMAIL_ENABLED=true` only after custom SMTP and the templates are ready. The user enters an email, receives a one-time code, and verifies it in the app. No new password is needed. First-time users can create an account through the same verified flow. Supabase generates, expires, rate-limits, and verifies the code; this app never stores or logs it. Existing-account linking still requires the previous workspace password to preserve ownership. See [Supabase passwordless email setup](https://supabase.com/docs/guides/auth/auth-email-passwordless).

## App configuration

Apply the normal project migration (`npm run db:migrate`), which adds an optional unique Auth identity to users without changing account IDs or receipt ownership. Configure the existing Render service:

```dotenv
AUTH_MODE=supabase
SUPABASE_AUTH_URL=https://xhnfcmpidcnmgsfuktyf.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_YOUR_PUBLIC_KEY
APP_URL=https://cloud-document-api.onrender.com/app/
AUTH_PROVIDERS=google
AUTH_EMAIL_ENABLED=true
AUTH_PUBLIC_ENABLED=false
AUTH_ALLOWED_EMAILS=your-test-google-address@example.com
```

Get the **publishable** key from Supabase → Settings → API Keys. Never put a service-role/secret key in this setting. Enable email only after SMTP and Confirm email are checked. Providers must also be enabled in Supabase. Apple and GitHub buttons appear only when included in `AUTH_PROVIDERS` and configured in Supabase.

For pre-release testing, keep `AUTH_PUBLIC_ENABLED=false` and configure the tester email allowlist **in Render**, not in Git. The server refuses other identities before creating or linking a workspace. The public configuration reveals only that access is restricted; it does not expose the allowlist. With email disabled, the server also requires an OAuth session and an identity from an enabled provider. Set `AUTH_PUBLIC_ENABLED=true` only when the owner approves public access after real Google sign-in and receipt checks. Keep email signup disabled until SMTP is ready.

The existing service is configured directly through Render environment variables; these optional settings are omitted from the baseline Blueprint so syncing it does not reset the rollout. The build command runs the project's checksum-tracked migration runner before starting the app. Do not also run migration 007 manually through the SQL editor, which would bypass its history tracking. To undo the login switch, set `AUTH_MODE=legacy` and deploy the same code; the additive identity column is compatible with legacy login. Do not delete the identity column or existing accounts as a rollback step.

Existing users first authenticate with a verified identity using their existing email, then prove ownership with their previous workspace password. This preserves IDs, documents, and purchases. Matching email alone never links accounts. If the old password is lost, manual ownership recovery is needed; do not delete the old account or automatically link it by email.

Browser sessions last up to one hour and survive refresh using an HttpOnly, SameSite=Strict cookie, with Secure and the `__Host-` prefix in production. Authenticated writes require a CSRF header, and sign-out clears the cookie. `/auth/session` restores the public profile, expiry, and CSRF token without returning the login JWT. Application login/exchange responses still provide bearer tokens for API compatibility, but the browser uses the cookie instead of retaining that JWT. Only PKCE verifiers, not access/refresh tokens, are stored in sessionStorage for redirect flows. Email codes are cleared after each attempt. Copied application tokens remain valid until expiry; cookie removal does not revoke a copied token. Sessions do not extend automatically beyond one hour.

## Apple and release checks

[Apple web login](https://supabase.com/docs/guides/auth/social-login/auth-apple) requires an Apple Developer account, Services ID, signing key, and client-secret rotation. Do not buy a membership just for this demo. Google is sufficient to start.

Before enabling managed login publicly, test actual Google consent/return, cancelled consent, email delivery/verification/resend, an unverified account being refused, and linking an existing workspace without losing receipts. Local automated tests simulate the provider; they cannot prove real inbox delivery or Google consent. Legacy `/auth/login` and `/auth/register` are disabled when managed mode is enabled. The current preview uses `AUTH_MODE=supabase`; keep `AUTH_PUBLIC_ENABLED=false` until the remaining public-release checks and owner approval are complete.
