# Explaining the project, one section at a time

The current local implementation extends this document workspace into Return
Keeper. [The receipt architecture guide](return-tracker.md) covers browser OCR,
image validation, purchase data, deadline confirmation, and calendar export.
The sections below describe the preserved document subsystem and its earlier
deployment; receipt features have not been deployed by this work.

## 1. What it does

“I built a document application that privately stores PDF and UTF-8 text files,
extracts their text, and persists word and character counts. I deployed the API
on Render Free with Supabase PostgreSQL and private object storage. The browser
interface is served publicly by the same Express service at `/app/`.” The preserved PDF/text processing path does not perform OCR or AI summarization; the return desk adds browser OCR for JPEG/PNG receipts.

## 2. Entry points and browser

`src/server.ts` validates configuration and database access before listening;
`src/app.ts` assembles security headers, routes, static UI, and error handling.
`public/index.html`, `style.css`, and `app.js` form the UI at `/app/`.
It uses the same origin and existing API, so no separate frontend deployment,
CORS configuration, or browser Supabase key is needed. The JSON root is preserved.

Interview question: Why plain JavaScript? This small UI needs forms and document
state, not a framework or another build pipeline. It can evolve if complexity grows.

## 3. Identity and ownership

`src/routes/auth.routes.ts` validates inputs, hashes passwords with bcrypt, and
issues a one-hour JWT at login. `src/middleware/auth.middleware.ts` verifies the
signature and expected claims. Every document lookup includes the verified user
ID; guessing another user's document UUID still returns 404.

Managed sign-in verifies identities with Supabase Auth and links them to stable
application ownership IDs. Browser sessions use an HttpOnly, SameSite=Strict
cookie (Secure in production) and a CSRF token for writes. Refresh restores the
session until its original one-hour expiry; sign-out clears the cookie. API
bearer tokens remain supported. An expiry timer and protected 401 clear private
state. Logout does not revoke a copied token before expiry. Privileged Supabase keys never appear in
the public files. Extracted text and filenames render using `textContent` rather
than HTML, so a document cannot inject markup into the page.

## 4. Upload and storage

`upload.ts` bounds the upload buffer; `validate-document.ts` checks the actual
PDF/text content. The browser's file checks are convenience, not authorization.
`storage.ts` and `storage-provider.ts` select local disk or private Supabase
objects. Keys are server-generated; the database records ownership and metadata.
If the metadata insert fails, the route attempts to remove the uploaded object.

Interview question: Why two stores? PostgreSQL suits relational ownership and
queryable counts; object storage suits original file bytes and survives Render
restarts. A database cascade alone does not remove an object.

## 5. Extraction and concurrency

`src/routes/documents.ts` atomically claims a document using a conditional UPDATE
before reading its bytes and invoking `pdf-processing.ts` or the UTF-8 path.
`text-processing.ts` counts whitespace-delimited words and Unicode code points.
The route saves text/counts and `completed`, or attempts to save `failed`.
Concurrent processing receives 409. Retrying clears previous results.

This is synchronous HTTP processing. UI activity indicators show a pending
request; stored `processing` status is polled when selected. There is no queue
or genuine percentage progress. A forced stop can require operator recovery.

## 6. Evidence and tradeoffs

Database-free tests cover validation, errors, limits, and storage contracts.
Integration tests run real migrations in temporary schemas and exercise auth,
ownership, PDF/text extraction, persisted results, and downloads. The owner also
verified production PDF hashes across restart and second-account 404 responses.
Those manual checks complement automated tests and do not certify every edge case.

For a small portfolio demo, request-based processing and process-local limits
keep operations simple. Redis/BullMQ would help with durable jobs and shared
limits as usage grows; they are optional enhancements, not implemented features.

Practice explaining section 1 first, then trace one upload through sections 2–5.
For each layer, explain what it owns, what can fail, and how access is restricted.

## 7. Page-level search and atomic publication

`document-extraction.ts` defines the page/text unit contract. Migration 005 stores
those units and generated English search vectors with a GIN index.
`document-results.ts` owns two short transactions: claim/invalidate before parsing,
then save pages plus results and completion after parsing. Parser work runs
outside the transaction to avoid holding a database lock while reading files.

`routes/search.ts` validates bounded inputs, rate-limits verified user IDs, and
joins pages to the JWT owner's completed documents. It ranks matches and creates
excerpts only for the limited result page. The browser opens a separately owned
source-unit endpoint so users can verify the reference and download the original.

Interview question: Why full-text search first? PostgreSQL already stores the
application data; a GIN index provides useful lexical retrieval without another
service. English stemming improves word-form matches but does not provide
semantic understanding or OCR. That tradeoff keeps the Free-plan demo simple.
