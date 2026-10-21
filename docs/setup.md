# Database setup and migrations

The searchable workspace adds migration `005_document_pages_and_search.sql`.
Apply it only to a reviewed local database for now; no live schema change has
been authorized. Keep previously applied migrations unchanged.

Use PostgreSQL 14 or newer (tested locally with 18). Create an empty database
named `cloud_document_api` in pgAdmin. Fill in `.env` privately using
`.env.example`, then run `npm run db:migrate` from the project directory.

The runner applies files in `database/migration` in filename order, inside one
transaction. A database advisory lock prevents two migration runs from racing.
`schema_migrations` records filenames and checksums; subsequent runs skip files
already applied and refuse edits to old migrations. Add a new numbered SQL file
for future changes. The database login must own the application tables: queries
connect directly as that owner, while RLS blocks unrelated Data API roles.

## Your existing local database

Earlier development applied migrations 001, 002, and 003 manually through
pgAdmin. Do not rerun their CREATE/ALTER statements. If all three were applied
exactly as committed, record that existing baseline once:

```powershell
npm run db:migrate -- --baseline-existing
```

This checks that expected tables and columns exist, records migrations 001-003
without running them, and applies later migrations. It does not prove that all
constraints/defaults match: review the three original SQL files against your
schema first. Back up important data before a migration. Once migration history
exists, use only `npm run db:migrate`. Partial or modified schemas need manual
review; do not use baselining to hide differences.

Migration 004 adds an ownership/listing index and enables RLS on the application
tables and migration history. If Supabase's `anon` or `authenticated` roles exist,
it revokes their table access. Our Express JWTs are separate from Supabase Auth;
all API queries still include the verified owner ID.

## Verification from empty

`npm run test:integration` creates a random `api_test_...` schema, runs all
migrations twice to check repeatability, and starts the real Express app on a
temporary port. Its connection search path excludes `public`. It removes its
schema and generated upload directory on completion. Your existing tables and
files are not used. The configured database login needs CREATE SCHEMA permission.

This test uses local storage even if the deployment environment uses Supabase.
Unit tests in `npm test` need no database. The concurrency and migration-safeguard
tests also use isolated schemas and run as part of `test:integration`.
`scripts/verify-pdf.cjs` is an optional live-server check; it uses the configured
application schema and cleans up its temporary accounts/files. Prefer the
isolated integration test for routine development.

## Interrupted processing

Normal parsing/read failures save `failed` and can be retried. If the process
crashes or the database is unavailable during failure cleanup, a document may
remain `processing`. Stop **all** API instances first, then run:

```powershell
npm run db:recover-processing -- --confirm-api-stopped
```

This marks all interrupted processing attempts as failed and clears their
results. Restart the API; owners can retry. Never run recovery while processing
requests are active. It is an explicit maintenance operation, not an automatic
startup reset that could race a rolling deployment.

## Search migration and existing documents

After checking that your ignored `.env` points to your local PostgreSQL host
and database, run `npm run db:migrate`. The existing runner applies migration
005 transactionally with its usual advisory lock/checksum history. Do not run
baseline again on a database that already has migration history.

Migration 005 creates `document_pages`, keyed by document and unit ordinal, with
nullable PDF page numbers, text, a generated English search vector, and a GIN
index. RLS is enabled and public/Supabase browser roles have no access. It does
not reparse originals or change existing completed documents. Old text/counts
remain readable; owners must select Extract again to create searchable pages.

Processing clears old page data atomically when claiming the document and
publishes replacement page text/search vectors and completed counts in one
transaction. Read/parse/save failure leaves no published search rows for that
attempt. The stopped-instance recovery command clears page data together with
old text/counts. It still must never run while any API instance is active.

`npm run test:integration` now includes isolated search schemas, cross-account
isolation, page references, pagination, and publication rollback tests. These do
not apply migration 005 to your normal application schema or live Supabase.
