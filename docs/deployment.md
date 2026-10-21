# A $0 portfolio deployment: Render + Supabase

The API is deployed at https://cloud-document-api.onrender.com using Render Free
and Supabase Free. Use Free plans throughout; do not select paid compute,
add-ons, or upgrades to work around quotas.

## Verified deployment checkpoint

The owner reported successful manual production smoke checks against the URL
above. These are user-reported manual checks, not checks independently rerun by
an agent and not a replacement for automated tests:

- `/health` reported the database connected; `/openapi.json` displayed the schema.
- A disposable account registered and logged in, uploaded a PDF, and processed it.
- Processing returned 2,438 words and 15,801 characters. Metadata reported
  `completed` with the same persisted counts.
- Downloaded original bytes had the same SHA-256 hash as the source PDF, both
  before and after a Render service restart.
- A second account received 404 for metadata, download, and processing requests
  targeting the first account's document.

The service is in Render's `My Workspace`; Supabase project `cloud-document-api`
(`xhnfcmpidcnmgsfuktyf`) is in US West on Free. Its `documents` bucket is private,
limited to 5,242,880 bytes and PDF/text MIME types. Migrations ran as part of the
successful deployment. TLS verification uses the downloaded Supabase CA in a
Render secret file named `supabase-ca.pem`, with
`DB_SSL_CA_FILE=/etc/secrets/supabase-ca.pem` and `DB_SSL=true`.

The browser UI and page-level private search in this checkout are prepared
locally for review, not deployed. Migration 005 has not been applied to live
Supabase. A future approved deploy will apply it through the build command;
existing documents will then need reprocessing before they appear in search.
No cloud changes, commits, or pushes are part of this documentation/UI update.

### Remaining work for the current version

- No deployment blocker remains in the owner-reported API smoke checks.
- Remove disposable accounts and objects through trusted maintenance when no
  longer needed; object removal is separate from database cascade deletion.
- Monitor Free usage and back up data worth keeping. Recover interrupted
  `processing` claims using the documented stopped-instance procedure if needed.
- Review the local browser UI and its local test results before authorizing a
  separate publication/deployment. Repeat browser smoke checks after deployment.

Redis/BullMQ, shared rate limiting, parser isolation, quotas/deletion, OCR,
summarization, and automated backups are optional future work, not completed
features or prerequisites for the current small portfolio demo.

## Free-tier boundaries

Checked October 20, 2026:

| Service | Free allowance/behavior |
| --- | --- |
| Render Free web service | 750 instance hours/workspace/month; sleeps after 15 idle minutes; waking can take about a minute; local uploads disappear on restart/redeploy/spin-down |
| Supabase Free | 500 MB database/project, 1 GB file storage, 5 GB egress; inactive projects can pause after a week; no automatic backups |

Keep the account on Free and avoid adding a payment method when possible.
Render can bill for certain overages if a payment method is present; without
one, affected free services/builds are suspended instead. Free limits are a
tradeoff for this demo, not an uptime promise. Monitor database, file storage,
egress, and build usage; pause the demo if it approaches its allowance. The API
currently has no total storage quota or automated retention policy.

Sources: [Render Free](https://render.com/docs/free),
[Render billing FAQ](https://render.com/docs/faq),
[Supabase pricing](https://supabase.com/pricing),
[Supabase usage allowances](https://supabase.com/docs/guides/platform/billing-on-supabase).
Avoid Render's free PostgreSQL for this project because those databases expire
after 30 days. Supabase keeps the database and private objects together.

## 1. Prepare one Supabase Free project

1. Create a Free organization/project and choose a region near the API host.
   Save the database password privately.
2. In Storage, create a **private** bucket named `documents`. Set its maximum
   file size to 5,242,880 bytes and allowed MIME types to `application/pdf` and
   `text/plain`. Do not enable public access or create permissive browser policies.
3. Copy the project URL and server-side `service_role` key from project settings
   into the host's private environment settings. Never paste them in chat, put
   them in Git, or give them to API consumers. This key bypasses storage RLS;
   only the server should have it. Our JWT ownership checks remain mandatory.
4. From **Connect**, select the **Session pooler** and copy the exact host and
   username. Use the displayed host, port 5432, database `postgres`, and username
   such as `postgres.PROJECT_REF`; do not guess the pooler hostname. The session
   pooler supports IPv4, while Free direct connections are IPv6-only.
5. Keep TLS certificate verification enabled. Set `DB_SSL=true`. If your
   connection needs the project's CA certificate, download it from Supabase's
   SSL settings and upload it as a Render secret file; set `DB_SSL_CA_FILE` to
   that file's path. Do not use `rejectUnauthorized: false` to bypass TLS checks.

Our API creates its own application tables through migrations, not Supabase Auth
users. Migration 004 enables RLS and revokes `anon`/`authenticated` access to these
tables. The direct database login must own them; no public table policy is needed.

References: [connection modes](https://supabase.com/docs/guides/database/connecting-to-postgres),
[storage access control](https://supabase.com/docs/guides/storage/security/access-control),
[database SSL](https://supabase.com/docs/guides/platform/ssl-enforcement).

## 2. Prepare the GitHub revision

Review `git status` and the diff. Confirm `.env`, `uploads`, certificates,
`node_modules`, and personal test documents are excluded. Commit source, SQL,
docs, tests, `package.json`, and `package-lock.json` together, then push only when
you explicitly want to publish this revision. GitHub Actions checks it before
deployment. Review GitHub Actions results for the specific revision being deployed.

## 3. Create the Render Free service

Import the repository using **New Blueprint** and `render.yaml`. Creating the
Blueprint provisions a service and deploys it, so review the settings first.
The template selects `plan: free`, disables automatic deployments, and asks for
secrets without committing their values. Alternatively configure a Free Node
web service manually with the same values:

- Build: `npm ci --include=dev && npm run build && npm run db:migrate`
- Start: `npm start`
- Health check: `/health`
- Node: current 22.x; production entry point: `dist/server.js`

| Variable | Value/source |
| --- | --- |
| `NODE_ENV` | `production` |
| `JWT_SECRET` | Host-generated random value, at least 32 bytes; never reuse an example |
| `DB_HOST`, `DB_USER` | Supabase Session pooler dialog |
| `DB_PORT`, `DB_NAME` | `5432`, `postgres` |
| `DB_PASSWORD` | Supabase database password |
| `DB_SSL` | `true` |
| `DB_SSL_CA_FILE` | Optional secret-file path for the provider's CA |
| `STORAGE_DRIVER` | `supabase` |
| `SUPABASE_URL` | Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Private legacy `service_role` key |
| `SUPABASE_STORAGE_BUCKET` | `documents` |
| `TRUST_PROXY_HOPS` | `1` for the intended single Render proxy path; verify forwarding on the deployed host |

Render supplies `PORT`; the server binds to `0.0.0.0`. Do not add another proxy
or CDN without reviewing `TRUST_PROXY_HOPS`: an incorrect hop count can either
share limits across clients or allow spoofed client IPs. Local development uses
zero trusted proxy hops. Do not set Express `trust proxy` to unrestricted `true`.

Migrations run against the **new cloud database** during the build. They do not
move local test accounts, database rows, or upload files. Rebuilds skip recorded
migrations. Never baseline a new cloud project; baseline is only for the already
initialized local database described in [setup](setup.md). Future incompatible
migrations require a reviewed rollout; do not edit already applied SQL files.

## 4. Verify before sharing the URL

Use the returned HTTPS URL as `$baseUrl` in [the API walkthrough](api.md):

1. GET `/health` returns database connected; GET `/openapi.json` returns the schema.
2. Register/login with a disposable account and upload a small real PDF.
3. Process it, GET its saved results, and download identical original bytes.
4. Use a second account: metadata/download/process must return 404 for that ID.
5. Trigger a restart and verify that the PDF still downloads. This checks durable
   object storage rather than Render's temporary filesystem.
6. Remove disposable test files/accounts through trusted maintenance. Deleting a
   database user cascades rows but does not remove Supabase objects automatically.

The local Supabase adapter contract tests do not replace this remote verification.
The owner-reported production round trip is recorded above; repeat these checks
after future deployment changes.

## Operating the demo

Do not upload sensitive documents to a portfolio demo. Keep server logs free of
credentials and document text. Back up data you care about; Free does not include
automatic backups. A stopped/paused service can show loading/unavailable responses.

Graceful shutdown waits up to 20 seconds for active requests. A crash or forced
restart can leave a document `processing`; [maintenance recovery](setup.md)
requires all API instances to be stopped first. Do not automatically reset claims
on startup while an older deployment might still be processing.

The optional `Dockerfile` uses a multi-stage build and non-root runtime, excludes
secrets through `.dockerignore`, and requires the same production environment.
Migrate separately before starting that image. Docker is not installed in the
current development environment, so the image build remains unverified.
