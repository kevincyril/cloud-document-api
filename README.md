# Return Keeper — private receipts & return deadlines

Upload a JPEG/PNG receipt, run free English OCR in your browser, review and
correct the suggestions, and confirm your return deadline. A responsive dashboard
shows days remaining, saved originals, and Returned status. Export an all-day
calendar event; return reminders are not sent by email or SMS.

Search all purchases by store, description, or policy notes, and export all
matching records as CSV (up to 10,000), with exact amounts and original currencies.
Filter due-soon purchases and mark returns directly from the dashboard. Deleting
purchase details requires confirmation and keeps original files in the library.
Unsaved purchase edits prompt before closing, replacing the form, signing out,
or leaving the page. Drafts remain in memory; no private form data is stored in
browser storage. Forced session expiry still clears private state.

The reviewed implementation is deployed at https://cloud-document-api.onrender.com/app/.
The live receipt/OCR flow is verified. The private Supabase bucket accepts PDF,
text, JPEG, and PNG with the existing 5 MiB limit.
The existing PDF/text extraction and private search
remain available under **Private document library & search**. Built with
TypeScript, Express, PostgreSQL, JWT authentication, Tesseract.js, and private
Supabase/local storage. See [architecture, correctness, and limitations](docs/return-tracker.md).

## Two-minute recruiter demo

Verified email and optional Google/Apple/GitHub sign-in use
`AUTH_MODE=supabase`. Google-only previews can be restricted to invited testers;
email signup stays disabled until SMTP is configured. Follow the
[authentication setup checklist](docs/auth-setup.md).

Open the [live website](https://cloud-document-api.onrender.com/app/) and follow
the [demo walkthrough, screenshots, and portfolio copy](docs/demo.md).

1. Use the live site, or run against an explicitly chosen **local** database with all migrations applied.
2. Open `/app/`, sign in (the live preview requires an invited account), and select **Try a sample receipt**.
3. Watch real browser OCR, review the synthetic receipt, and correct any field.
4. Choose an explicit deadline or a user-supplied day window. Check the displayed
   calculation, then confirm and save.
5. Review the dashboard, download the private original, and use **Add to calendar**.

The samples contain no real personal/payment information. OCR can make mistakes;
ambiguous fields are left blank. Merchant names never imply a return policy.

## Run locally

Requirements: Node.js 22.20+ (22.x), npm, and PostgreSQL 14+.

1. Run `npm ci`.
2. Copy `.env.example` to `.env`: `Copy-Item .env.example .env`.
3. Fill in database credentials privately. Set `JWT_SECRET` to at least 32 random
   bytes. For example, generate 32 random bytes and Base64-encode them with a
   password manager; never commit or share the value.
4. Create an empty `cloud_document_api` database in pgAdmin.
5. Verify the database is local before running `npm run db:migrate`. For an existing database with manually applied
   migrations, follow [the baseline instructions](docs/setup.md) instead.
6. Run `npm run dev` and open `http://localhost:3000/app/` for the browser interface
   or `/health` for readiness.

`npm run build` compiles to `dist/`. `npm start` runs that compiled application;
build before starting it. Files stay private: `uploads/` is never statically
served. The public deployment should use Supabase storage because ephemeral
hosting filesystems cannot retain uploads.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | API/database readiness |
| GET | `/openapi.json` | Importable OpenAPI 3 specification |
| POST | `/auth/register` | Register a regular user |
| POST | `/auth/login` | Obtain a one-hour JWT |
| GET | `/auth/me` | Get your authenticated profile |
| GET | `/auth/admin-test` | Demonstrate admin role authorization |
| POST | `/documents/upload` | Upload one PDF, UTF-8 text, JPEG, or PNG file |
| POST / GET | `/purchases` | Save / list owned purchases |
| GET / PUT | `/purchases/:id` | Read / replace a purchase with revision checks |
| GET | `/purchases/:id/calendar` | Export a user-confirmed deadline as `.ics` |
| GET | `/documents?limit=50&offset=0` | List your documents |
| GET | `/documents/:id` | Read metadata and persisted results |
| GET | `/search?q=term&limit=20&offset=0` | Ranked matches from your completed documents |
| GET | `/documents/:id/units/:unitIndex` | Read an owned match's source page/text unit |
| GET | `/documents/:id/download` | Download original bytes |
| POST | `/documents/:id/process` | Extract, analyze, and save results |

Protected endpoints require `Authorization: Bearer <token>`. Document IDs alone
never grant access: every document query includes the user ID from the verified
JWT. Other users receive the same 404 as a nonexistent document. Registration
ignores a submitted role; upload forms reject extra ownership fields.

See [the request walkthrough](docs/api.md), [rate limits](docs/rate-limits.md),
and [the full API schema](docs/openapi.json).

## How a request moves through the code

`server.ts` validates configuration, checks PostgreSQL, and starts `app.ts`.
The app adds security headers, parses JSON, mounts routes, and ends with one JSON
error handler. A document upload passes through JWT authentication, its user rate
limit, Multer's bounded memory buffer, and content checks. The storage service
saves the bytes under a server-generated UUID; PostgreSQL saves their metadata.
If insertion fails, the route attempts to remove the newly stored object.

Processing verifies ownership and atomically changes status to `processing`.
Only one request can claim the document. The text/PDF service extracts text,
`analyzeText` calculates counts, and an UPDATE saves results with `completed`.
Failures attempt to save `failed`; concurrent attempts return 409. A retry clears
old results. Downloads check ownership before reading from either storage backend.

## Checks

```powershell
npm run check
npm run test:integration
```

The first command runs TypeScript, database-free unit/HTTP tests, and the build.
The second applies the actual migrations to a temporary schema and tests the
real auth, text/PDF processing, download, and ownership paths. The configured
database user needs schema-creation permission. GitHub Actions runs both checks
with a fresh PostgreSQL service and also tests the compiled app.

Tests use Node's built-in test runner and HTTP client, so no Jest/Supertest
dependency is needed for this version. [Setup and recovery](docs/setup.md)
describe migration history and interrupted processing.

## Free deployment

The API is deployed at https://cloud-document-api.onrender.com on Render Free
with a Supabase Free database and private storage bucket. The owner reported
successful manual production smoke checks (health/schema, PDF extraction, saved
results, identical SHA-256 downloads before/after restart, and cross-account
404 ownership checks). These complement automated tests. The browser interface is public at
https://cloud-document-api.onrender.com/app/. No resources are created by cloning or running tests. Follow
[the deployment guide](docs/deployment.md); `render.yaml` contains placeholders
for server-side secrets. Existing local documents are not automatically moved.

## Current limits

- Files: 5 MiB each; PDF header checks and UTF-8 validation are not malware
  scanning. Password-protected PDFs are rejected during processing. Image-only
  PDFs need PDF OCR, which is not implemented. JPEG/PNG receipts support browser
  OCR; all suggestions need review. Images are decoded with pixel/dimension caps.
- Work runs during the HTTP request. Rate limits are per process and reset on
  restart. There is no background queue, parser process isolation, or global
  concurrency bound. Use this release as a small portfolio demo, not a public
  high-volume processing service.
- Words are whitespace-delimited. Characters are Unicode code points, including
  whitespace and line endings. PDF parser formatting can affect counts.
- Local/remote storage selection applies to all documents; switching backends
  does not copy files. Database cascades do not delete file objects. There is no
  deletion/retention endpoint or per-user storage quota yet; monitor demo usage
  and remove test objects through trusted maintenance.
- Free hosting may sleep/pause and has no uptime guarantee. The deployed API
  passed owner-run smoke checks; the searchable browser workspace is deployed and passed a generated-data browser smoke check.

Future work: Redis/BullMQ workers, shared rate limits, parser resource limits,
storage quotas/deletion, OCR, and automated backups.

## Browser interface and learning guide

The searchable workspace is deployed on the existing Render Free service. Migration 005 stores
PDF pages/text units with a full-text GIN index. Search returns ranked excerpts
and physical PDF page numbers (null for text files), with ownership derived from
JWTs. Existing documents need Extract again to populate the index. English word
forms are matched and all remaining query words must occur in one unit; this is
not OCR, substring/fuzzy search, or an AI answer service.
See [search behavior and milestone status](docs/search-workspace.md).

Run locally and visit `/app/`. The dependency-free interface supports account
registration/login, PDF/text upload, extraction, saved text/counts, paginated
documents, private search with source-page inspection, and authenticated downloads. Browser sessions use HttpOnly,
SameSite=Strict cookies (Secure in production) and survive refresh for up to one
hour. Cookie-authenticated writes require a CSRF token; expiry or a protected 401
clears the workspace. API bearer tokens remain supported. The existing JSON
root and API endpoints remain available. See [browser review](docs/browser.md)
and [architecture walkthrough](docs/architecture.md).

Run `npm run test:browser` for the local Edge/Chromium end-to-end flow. See
[setup](docs/setup.md) before applying migration 005 to your local database.
Migration 005 and the public UI are deployed; existing documents require Extract again to become searchable.
