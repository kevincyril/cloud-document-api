# Database setup and migrations

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
