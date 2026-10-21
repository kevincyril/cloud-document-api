# Searchable workspace: local review checkpoint

All three milestones are implemented locally; no new version has been published.
The deployed API smoke checks in deployment.md apply to the earlier deployed
version. They do not establish production availability of search or the browser.

## 1. Page-aware extraction

`extractPdfDocument` uses installed pdf-parse 2.4.5 `getText().pages` entries
(`num`, `text`) to preserve physical, one-based PDF page references. Empty pages
remain so later references do not shift. Combined text/counts remain compatible.
`extractTextDocument` treats the whole text file as one unit with null page
number. No page label is invented, and physical positions can differ from
printed page labels. No-extractable-text is a signal, not proof of scanning.

Version-matched references are the installed package README and TextResult type
and the upstream [v2.4.5 source](https://github.com/mehmet-kozan/pdf-parse/tree/v2.4.5).

## 2. Page storage and private search

Migration 005 adds `document_pages` with a document/ordinal primary key, nullable
PDF page number, text, a generated English tsvector, and a GIN index. RLS and
revoked public/anon/authenticated access follow the existing owner-login model.
The server joins through `documents.user_id` derived only from the verified JWT.

The claim transaction marks processing, clears old counts/text, and deletes old
units. Parsing happens outside the database transaction. A publication transaction
locks the owned document and saves new pages, search vectors, counts, and completed
status together. A failure cannot publish a subset or retain old search results.
The stopped-instance recovery command also clears page data atomically.

`GET /search?q=...` returns ranked page/text matches, not AI answers. It uses
English plainto_tsquery (AND of normalized words), ts_rank_cd, and plain excerpts
from ts_headline. Stop words and punctuation can yield no matches; English word
forms are normalized. This is not phrase, substring, fuzzy, or semantic search.
Matches must occur within one page/text unit. Filenames are displayed, not indexed.
PostgreSQL full-text size/position limits apply to unusually large text units.

Queries are 1-200 characters; result limits are 1-50, offsets 0-1000. A separate
60/minute verified-user rate budget limits search. Rank descending, document ID,
and unit ordinal provide deterministic ordering; pagination is not a snapshot.
`GET /documents/:id/units/:unitIndex` retrieves the owned source for inspection.
Old completed documents need reprocessing; migration does not infer page boundaries
or automatically read stored originals. See api.md and setup.md for details.

Tests cover ownership, PDF references, text null pages, relevant excerpts/ranking,
validation, pagination/no matches, replacement without duplicate/stale units,
completion rollback, concurrent attempts, empty-text PDFs, and rate limits.

## 3. Browser search

The existing same-origin `/app/` UI is extended with search, plain-text excerpts,
source-page inspection, document totals, and original downloads. It labels matches
as search results, not generated answers. Reprocessing clears the current browser
search results because they may be stale. Text without extractable words shows
no-OCR guidance. All text/filenames/excerpts use textContent rather than innerHTML.

The existing in-memory JWT strategy remains: no local/session storage, refresh
signs out, and expiry/protected 401 clears documents and search results. This
reduces token persistence but does not prevent active XSS or revoke copied JWTs.
Privileged Supabase keys and database credentials stay on the server.

The local browser test registers/logs in, uploads/processes PDF and text, searches,
inspects PDF page 3 and text sources, checks original download bytes, and covers
no matches, HTML-like text, upload/processing failures, and expired-session cleanup.

## Publication remains a separate decision

Local migration/application review comes first. Nothing has been committed,
pushed, deployed, or changed in live Supabase for this work. After approval, the
same Render Free service can serve the public interface at `/app/`; registration
is public, while all document/search operations require the owner's token.
Check the public UI and two-account isolation after any future approved deployment.

OCR, AI chat/summaries, embeddings, format conversion, and Redis/BullMQ are not
implemented. The earlier reported PDF failure remains undiagnosed with that
specific file; this work does not claim to fix it.
