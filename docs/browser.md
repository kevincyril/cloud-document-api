# Browser application: local review

Start the existing local database, fill in the ignored `.env` using setup.md,
run `npm run db:migrate` to include migration 005 on that local database, then
`npm run dev`.
Open http://localhost:3000/app/. The interface calls the local backend at the
same origin. It does not call the production API from localhost.

No new packages or paid services are needed. Migration 005 must be applied
to the local database before using this version. The existing
`/`, `/health`, `/openapi.json`, `/auth`, and `/documents` API behavior is retained.
`Dockerfile` includes public assets; the existing Node build reads them directly
from `public/`, both in development and beside compiled `dist/`.

## Review flow

1. Register a disposable local account, then sign in. Try a duplicate account
   and incorrect password to inspect error messages.
2. Upload a small PDF or UTF-8 `.txt` file. Select Extract text; inspect saved
   text/counts. Try an oversized file, damaged PDF, or password-protected PDF.
3. Search for words in your extracted files. Inspect a match: PDF results show
   the physical source page, and text-file results have no PDF page number.
   Check no matches and HTML-like document text. Use Extract again for older
   documents that have no indexed pages.
4. Select different documents, refresh, and use Previous/Next for more than
   20 documents. Download an original and compare hashes.
5. Sign out and sign in as another account; verify separate lists. API integration
   tests separately verify access to another owner's document is denied.
6. Refresh the browser: sign-in is required again. Expired tokens and protected
   401 responses also clear the workspace. No token is persisted in browser storage.
7. Check keyboard navigation, narrow screens, visible focus, and announced status
   messages. Text and filenames are rendered literally, including HTML-like text.

Activity messages indicate upload/extraction requests, not percentage progress.
Selecting a stored `processing` document polls its status every five seconds.
If a request is interrupted, refresh documents before retrying because the server
may have completed it. Failed extraction offers retry; image-only PDFs may finish
with empty text because OCR is not supported. No summarization is performed.

Secrets remain in server environment settings. Sign-out discards the browser's
token but cannot revoke a JWT already copied elsewhere. The current app has no
password reset, account/document deletion UI, or persistent browser sessions.

The browser UI is not deployed. Publication and production browser smoke checks
are separate steps after review. See deployment.md for the verified API status.

## Automated local verification

`npm run check` and `npm run test:integration` retain the existing API checks.
`npm run test:browser` runs a real headless Edge/Chromium flow against a uniquely
named temporary local database schema and temporary upload directory, cleaned
up afterward. It covers registration/login, PDF/text upload/extraction, search,
source-page inspection, byte-identical PDF/text downloads, oversized
file rejection, literal
HTML-like text rendering, identical original download, damaged-PDF errors/retry,
expired-token cleanup, second-account isolation in the UI, refresh sign-out, and
narrow-screen overflow. This is not an exhaustive accessibility or browser audit.

On Windows it uses the standard installed Edge executable. Elsewhere set
`BROWSER_TEST_BINARY` to an installed Chromium-compatible executable. This
optional local command requires the same database access as integration tests;
it does not install a browser and is not added to CI's existing API workflow.

Local implementation checks passed: `npm run check` (33 unit/HTTP tests plus
TypeScript, config/docs validation, and build), the integration suite in both
source and compiled modes, and the headless Edge browser flow. A screenshot was
also visually reviewed. These local results do not establish that the new UI
is available on the production service.

The normal local database was verified to match original migrations 001-003,
its baseline recorded, and migrations 004-005 applied locally during this work.
Live Supabase was not changed. Existing local completed documents need Extract
again before search can find their contents.
