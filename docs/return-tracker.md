# Return Keeper: implementation and review guide

The existing application has been extended in place with private JPEG/PNG
uploads, browser OCR, editable purchase details, confirmed return deadlines,
a responsive purchase dashboard, a synthetic sample flow, and calendar export.
The implementation was reviewed, committed, and deployed on October 21, 2026
(application commit `f47722b`, Render deploy `dep-dbchlhks728c7396m230`). GitHub
Actions passed and migration 006 is applied. Health, dashboard HTML, authentication,
and database access restrictions are verified. The owner updated the bucket to
accept JPEG/PNG while retaining private access and the 5 MiB cap. A real browser
check of the complete receipt flow on the public service passed, including
two-account isolation. There are no automatic email/SMS/app reminders.

## Architecture and milestones

1. Purchase model/API and deterministic correctness tests.
2. Bounded JPEG/PNG validation and browser Tesseract.js OCR with editable
   suggestions, progress, cancellation, worker cleanup, and manual fallback.
3. Responsive receipt dashboard, private preview/download, synthetic sample,
   all-day calendar export, and real browser/OCR smoke verification.

Reuse Express JWT authentication, PostgreSQL, migrations, private document
storage, and authenticated downloads. Existing PDF/text processing and search
stay available in the secondary document workspace. OCR text and suggestions
are untrusted client data, separate from confirmed fields; OCR runs in the browser.
Do not use OCR confidence as proof of field correctness or infer retailer policy.

## Purchase contract

All `/purchases` routes require the existing bearer token. Writes share a budget
of 60 attempts per 15 minutes per verified user. JSON retains the existing 100 KB
limit. Responses have `Cache-Control: no-store`.

- `POST /purchases`: create from the complete input below; returns 201.
- `GET /purchases?limit=50&offset=0&returned=false`: list owned purchases by
  deadline ascending, no deadline last, ID as tie breaker. `returned` is optional;
  limit is 1–100, offset 0–10000. Unknown query parameters are rejected.
- `GET /purchases/:id`: owned record; missing/other-owner records return 404.
- `PUT /purchases/:id`: full replacement with the current integer `revision`;
  stale revision returns 409. Reconfirm any deadline on every save, including
  purchase-date/window edits. No implicit deadline recalculation occurs.
- `GET /purchases/:id/calendar`: authenticated `.ics` download for the saved,
  confirmed deadline; 409 without a confirmed date, 404 for missing/other-owner
  purchases. An all-day event is created, not an application notification.

```json
{
  "merchant": "Synthetic Shop",
  "purchaseDate": "2026-10-21",
  "amount": "19.99",
  "currency": "USD",
  "description": "Demo purchase",
  "policyNotes": "Check packaging and other policy conditions",
  "receiptDocumentId": null,
  "policyDocumentId": null,
  "rawOcrText": "",
  "suggestions": {},
  "deadline": {
    "source": "window",
    "days": 30,
    "purchaseDayCounts": false,
    "date": "2026-11-20",
    "confirmed": true
  },
  "returned": false
}
```

Required fields: merchant, purchaseDate, amount, currency, deadline. Purchase date
may be null. Amount/currency must both be null or both present. Manual entry
needs no OCR text or attachment. Every suggestion can be corrected independently.
Optional suggestions: nullable merchant (160 chars), purchaseDate (40), amount
(40), currency (10), and up to 20 warning strings (200 each).

Amounts are decimal **strings**, converted using BigInt to integer minor units;
never send a JSON floating-point number. Initially supported currencies: USD,
CAD, EUR, GBP, AUD (2 decimal places), JPY (0), KWD (3). Maximum whole amount is
999999999; negatives, grouping separators, exponent notation, and excess
precision are rejected. Missing totals are allowed. Do not aggregate mixed
currencies. Responses use snake_case fields, `amount_minor` as an exact integer
string, date strings, and revision starting at 1.

Dates must be unambiguous valid `YYYY-MM-DD` values in years 1900–9999. PostgreSQL
stores DATE values; queries explicitly return text to avoid pg timezone conversion.
The dashboard supplies the user's current local calendar date to the
pure deadline-state helper: due today = 0 days; passed < 0; due soon = 1–7 days.
Returned overrides deadline status. There is no implicit server timezone.

Deadline variants:

- No deadline: `{"source":"none"}`.
- Explicit: `{"source":"manual","date":"2026-11-20","confirmed":true}`.
- Window: as above, 1–3650 days. When purchase day does not count, date = purchase
  date + days; when it counts, date = purchase date + days − 1. The client must
  show this calculation before confirmation. An edited calculated result should
  be saved as a manual date. Deadlines cannot precede a known purchase date.

Merchant is trimmed, required, at most 160 characters. Description (500), policy
notes (2000), raw OCR (30000), and suggestion lengths are bounded. Unknown body
properties are rejected. Deadline confirmation timestamps are generated by the
server. Client-supplied OCR text/suggestions are not verified evidence.

## Ownership, files, and deletion

Receipt and optional policy links reference existing documents. Composite
foreign keys enforce the same owner even during concurrent operations. Missing
and other-owner attachments both produce the same generic 400 response. The
existing authenticated document download remains the only original-file path.
JPEG and PNG images use the existing upload endpoint. The server verifies the
decoded format, full image body, dimensions, and frame count using sharp. Maximum
5 MiB, 12 million pixels, and 8000 pixels per side. GIF/SVG/WebP/animated or
malformed images are rejected. PDF/text upload and extraction are retained;
images are not processed by the server's PDF/text processing endpoint.

No purchase deletion endpoint is introduced. Linked documents and owners cannot
be deleted while purchases reference them; no cascade deletes receipts. Replacing
or clearing a document link preserves the original document in its owner's library.
Saving a purchase never writes an object, so a failed save cannot leave a new
orphaned object. The review form retains successfully uploaded document IDs after
a failed purchase save; retry without reuploading. Closing/abandoning a form or
unlinking an attachment preserves the original as a normal standalone document
in the private library. Upload metadata failure cleanup remains unchanged.
After an interrupted response, refresh purchases before retrying: creates are
not idempotent and a lost successful response can otherwise lead to a duplicate.

The table enables RLS and revokes PUBLIC/anon/authenticated Data API access,
matching the repository's direct PostgreSQL connection/Express JWT architecture.
No browser Supabase keys or new services are introduced.

## Local verification and deployment status

Migration `006_purchases.sql` uses the existing numbered SQL runner. Historical
migrations are unchanged. **Do not run the migration with the current `.env`
unless its database has been verified as an intended local test database.**
Production publication was authorized after local review. Render's existing build
command applied migration 006 successfully. The table has RLS enabled and no
anon/authenticated SELECT access. The existing Render configuration is unchanged.
No new environment variables or services are required. Exact dependencies and
lockfile changes are committed. The private bucket's JPEG/PNG MIME allowlist update
is verified, and live receipt verification passed; see [deployment notes](deployment.md).

`npm run check` includes deterministic money/date/deadline tests.
`npm run test:integration` uses the configured database in disposable schemas;
explicitly override all DB settings to a disposable local PostgreSQL instance
before running it. Coverage includes migration preservation, two-account purchase
and document isolation, database ownership constraints, manual entry, confirmed
date edits, stale revisions, Returned filtering, and restricted linked-document
deletion, image isolation, image validation, scoped CSP, and calendar export.

## Browser OCR and privacy

- Tesseract.js **7.0.0**, its matching core **7.0.0**, English language data
  **1.0.0**, and sharp **0.35.5** are pinned with the npm lockfile. No paid OCR or
  AI API is used. The normal application server/private bucket receives the
  uploaded original and the explicitly saved OCR text; recognition occurs in
  the user's browser, not a third-party OCR service.
- Public OCR code/core/language data is served through explicit `/app/ocr/*`
  allowlisted filenames, not arbitrary `node_modules` paths. All core variants
  are available, including baseline, SIMD, and relaxed SIMD. The library chooses
  the supported variant. No runtime CDN is required.
- An invisible same-origin frame owns a dedicated worker per receipt. Parent
  messages check both origin and source. A completed scan removes the frame;
  cancelling, signing out, navigating away, or the 120-second timeout also removes
  it and its worker, including during asset initialization. One scan runs at a
  time. Manual entry remains available after cancellation, errors, and empty OCR.
- The OCR frame and worker responses allow `wasm-unsafe-eval` for WebAssembly;
  the main UI and other API responses do not. There is no `unsafe-eval`, external
  script origin, blob worker, or global security-header weakening. Blob image
  URLs are allowed for private authenticated previews and are revoked on close,
  sign-out, or replacement. No receipt is statically served or shared-cacheable.
- The existing no-store response policy also applies to public OCR assets. The
  typical LSTM core wrapper is about 3.9 MB, English data 3.0 MB compressed, plus
  the small library/worker scripts: approximately **7 MB per scan**, with no
  IndexedDB language cache. Repeated scans consume app-host egress. WASM consumes
  meaningful browser CPU/memory; low-memory/slow/mobile devices may need manual
  entry. The 12 MP cap bounds image work but is not a universal performance promise.
- A modern WebAssembly/Web Worker browser is required for OCR. Real Edge/Chromium
  was verified locally. Safari, Firefox, real mobile devices, screen readers, and
  calendar-client imports have not been independently tested. Manual entry and
  download are available when OCR is unavailable.

Tesseract sources: [worker API and asset options](https://github.com/naptha/tesseract.js/blob/master/docs/api.md),
[local asset loading](https://github.com/naptha/tesseract.js/blob/master/docs/local-installation.md),
[current project scope](https://github.com/naptha/tesseract.js).
The installed v7 source was also inspected: it needs the matching v7 core and
adds relaxed-SIMD variants beyond older examples. Image bounds use
[sharp's input pixel limit and strict decode options](https://sharp.pixelplumbing.com/api-constructor/).

## Conservative suggestions and observed sample results

The parser suggests only a plausible first merchant line, one unambiguous numeric
purchase date, one explicitly labeled total, and a supported identifiable currency.
It does not parse line items, interpret policy text, or use OCR confidence as field
proof. Dates such as `10/11/2026` are left blank; multiple distinct dates or totals
are flagged. `$` alone is not enough to choose USD/CAD/AUD. Currency codes, US$,
EUR/€, and GBP/£ can disambiguate. Named-month dates, handwritten receipts, localized
number formats, discounts/multiple totals, faded/skewed photos, and inconsistent
OCR may need manual correction. Unsupported currencies can be retained in notes
while total/currency stay blank.

Both fixtures are synthetic files in `public/samples/` with no real personal or
payment data. `node scripts/generate-receipts.cjs` regenerates them from simple
text artwork; regeneration is optional and not needed to deploy the files.

Observed using actual browser OCR locally on October 21, 2026:

| Fixture | Real OCR / parser observation |
| --- | --- |
| `maple-goods.png` | Read MAPLE GOODS, 2026-10-21, USD, and 34.56. Browser test corrected the confirmed amount to 34.57 while retaining the original OCR/suggestion. |
| `cedar-market.jpg` | Read CEDAR MARKET and its ambiguous 10/11/2026 date / $ total; date and currency/amount were intentionally left blank for review. |

These clear generated receipts are smoke tests, not an accuracy benchmark for
real-world receipts. The sample button uses the same authenticated upload and
real OCR path as an uploaded image, with no hidden prefilled results.

## Dashboard and review behavior

Cards show merchant, purchase date, exact amount/currency, saved deadline,
days remaining, and distinct Due soon/Due today/Deadline passed/No deadline/Returned
states. Sorting/filtering and counts are explicitly scoped to the current page
of up to 50 records. No currency totals are combined. Dates refresh on tab focus
and once a minute while visible. Returned is user-controlled in the edit form.

Every edit form starts with deadline confirmation unchecked. Purchase date/window
changes show a new proposed calculation but leave the saved deadline unchanged
until explicitly confirmed and saved. "Edit calculated date" switches the proposed
date to manual provenance. Calendar export always uses the **saved** deadline,
even if there are unsaved changes. Re-import after saving changes if necessary.
Calendar files use RFC 5545 DATE values, CRLF, UTF-8 line folding, text escaping,
and stable UUID-based event IDs. A DATE DTSTART with no DTEND/DURATION is one day
under [RFC 5545 §3.6.1](https://www.rfc-editor.org/rfc/rfc5545#section-3.6.1).

Policy notes and an optional existing/recent private document or new policy file
can be attached in the form. The recent-document selector shows up to 100 entries
and preserves any older currently linked document. Download policy to inspect it;
there is no AI policy interpretation. Keyboard labels, visible focus, live status,
literal text rendering, responsive layouts, and form confirmation are included.

## Local browser verification

`npm run test:browser` launches hidden local Edge/Chromium using an isolated
schema, temporary upload directory/profile, and disposable accounts. Set
`BROWSER_TEST_BINARY` if Edge is elsewhere. Explicitly point **all DB variables**
at local PostgreSQL; these tests must never use production credentials.
Optional `BROWSER_TEST_TRACKER_SCREENSHOT` saves a synthetic-data screenshot.

The real browser test covers registration/login → sample PNG upload → actual OCR
→ correction → calculated/confirmed deadline → saved dashboard entry → private
preview/original + policy downloads → calendar export → edit/reconfirmation →
Returned filter → actual JPEG OCR with ambiguity → initialization cancellation →
manual save → blocked OCR-library failure → manual save. It also retains the
existing PDF/text extraction/search/source/download, literal HTML-like text,
session expiry, account isolation, browser refresh, and 390-pixel layout checks.
No real customer receipt or production data was used.
