# Cloud Document Processing API

A Node.js/TypeScript API for private document uploads, PDF/text extraction, and
saved word/character counts. Built with Express, PostgreSQL, JWT authentication,
and a storage adapter supporting local development or private Supabase objects.

## Run locally

Requirements: Node.js 22.20+ (22.x), npm, and PostgreSQL 14+.

1. Run `npm ci`.
2. Copy `.env.example` to `.env`: `Copy-Item .env.example .env`.
3. Fill in database credentials privately. Set `JWT_SECRET` to at least 32 random
   bytes. For example, generate 32 random bytes and Base64-encode them with a
   password manager; never commit or share the value.
4. Create an empty `cloud_document_api` database in pgAdmin.
5. Run `npm run db:migrate`. For an existing database with manually applied
   migrations, follow [the baseline instructions](docs/setup.md) instead.
6. Run `npm run dev` and open `http://localhost:3000/health`.

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
| POST | `/documents/upload` | Upload one PDF or UTF-8 text file |
| GET | `/documents?limit=50&offset=0` | List your documents |
| GET | `/documents/:id` | Read metadata and persisted results |
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

Prepared for one Render Free web service plus a Supabase Free database/private
storage bucket. No resources are created by cloning or running tests. Follow
[the deployment guide](docs/deployment.md); `render.yaml` contains placeholders
for server-side secrets. Existing local documents are not automatically moved.

## Current limits

- Files: 5 MiB each; PDF header checks and UTF-8 validation are not malware
  scanning. Password-protected PDFs are rejected during processing. Image-only
  PDFs need OCR, which is not implemented.
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
- Free hosting may sleep/pause and has no uptime guarantee. Cloud credentials,
  real remote-storage verification, and a public URL remain deployment steps.

Future work: Redis/BullMQ workers, shared rate limits, parser resource limits,
storage quotas/deletion, OCR, and automated backups.
