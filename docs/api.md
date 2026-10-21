# Receipt and purchase API (local implementation)

Authenticated `/purchases` supports create, list, detail, and full replacement
with revision checks. See the [purchase contract](return-tracker.md) for exact
money, date, confirmation, and document ownership rules. Migration 006 is required
on an explicitly chosen local test database. JPEG/PNG originals use the existing
`POST /documents/upload` endpoint and owner-checked downloads. Valid images are
decoded server-side, must be single-frame, at most 5 MiB/12 megapixels/8000 pixels
per side, and must match their declared MIME type. `POST /documents/:id/process`
continues to process only PDF/text; receipt OCR runs in the browser. Raw OCR and
suggestions are untrusted, bounded input saved separately from confirmed fields.
`GET /purchases/:id/calendar` downloads an all-day `.ics` for the saved confirmed
deadline (409 if absent, 404 for a missing/other-owner purchase). It schedules no
application reminder. Application commit `f47722b` is deployed with migration 006;
the private bucket's JPEG/PNG allowlist and the live upload/OCR flow are verified.

# Try the API in PowerShell

Private search and source-unit retrieval are deployed. For local development,
apply migration 005 to your local database and reprocess documents before testing.
Public browser: https://cloud-document-api.onrender.com/app/.

Start the local API first. Registration and login use API account credentials;
they are different from your PostgreSQL credentials. These commands prompt
privately for the password and keep the JWT in a terminal variable.

```powershell
$baseUrl = "http://localhost:3000"
$email = Read-Host "API account email"
$passwordInput = Read-Host "API account password" -AsSecureString
$credential = [pscredential]::new($email, $passwordInput)
$password = $credential.GetNetworkCredential().Password
$registration = @{ name = "Student tester"; email = $email; password = $password } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "$baseUrl/auth/register" -ContentType "application/json" -Body $registration | Select-Object status, message
$loginBody = @{ email = $email; password = $password } | ConvertTo-Json
$loginResponse = Invoke-RestMethod -Method Post -Uri "$baseUrl/auth/login" -ContentType "application/json" -Body $loginBody
$headers = @{ Authorization = "Bearer $($loginResponse.token)" }
Remove-Variable password, registration, loginBody, credential, passwordInput
```

Skip registration if the account already exists. Do not print `$loginResponse`
or `$headers`: they contain the token. Variables disappear in a new terminal;
log in again when needed. Tokens expire after one hour.

Upload using `curl.exe` because older Windows PowerShell lacks
`Invoke-RestMethod -Form`. Replace the path with your own PDF:

```powershell
$upload = curl.exe --silent --show-error -X POST "$baseUrl/documents/upload" -H "Authorization: Bearer $($loginResponse.token)" -F "document=@sample.pdf;type=application/pdf" | ConvertFrom-Json
$documentId = $upload.document.id
Invoke-RestMethod -Method Post -Uri "$baseUrl/documents/$documentId/process" -Headers $headers
Invoke-RestMethod -Uri "$baseUrl/documents/$documentId" -Headers $headers
Invoke-RestMethod -Uri "$baseUrl/documents?limit=20&offset=0" -Headers $headers
Invoke-WebRequest -Uri "$baseUrl/documents/$documentId/download" -Headers $headers -OutFile downloaded.pdf
```

For text, use `document=@sample.txt;type=text/plain`; save the file as UTF-8.
Send only one `document` file, with no extra form fields. Maximum size is
5,242,880 bytes. A PDF header is checked at upload, but damaged or encrypted PDFs
can still fail when processed. A scanned PDF may extract no useful text.

Expected status sequence: `uploaded` -> `processing` -> `completed` or `failed`.
GET metadata returns NULL result fields before processing or after failure.
POST processing returns `analysis.text`, `wordCount`, and `characterCount`;
GET metadata uses database names `extracted_text`, `word_count`, and
`character_count`. `size_bytes` is a string because PostgreSQL BIGINT values can
exceed JavaScript's safe integer range.

| Status | Meaning |
| --- | --- |
| 400 | Invalid UUID, JSON, pagination, form fields, or account input |
| 401 | Missing/invalid/expired JWT or incorrect login |
| 403 | Authenticated role is not allowed |
| 404 | Unknown route, missing document, or another owner's document |
| 409 | Duplicate email or document already processing |
| 413 | File/JSON body too large |
| 415 | Unsupported file type or invalid UTF-8/PDF signature |
| 422 | Unreadable or password-protected PDF |
| 429 | Request limit reached; wait for `Retry-After` seconds |
| 500 | Unexpected server failure; internal details are hidden |
| 503 | Database or remote document storage unavailable |

Opening a POST URL in a browser sends GET and does not process a file. Import
`docs/openapi.json` into an API client for the full request/response definitions.

## Private search and source references

Use the same authenticated `$headers` from login:

```powershell
$query = [uri]::EscapeDataString("network sockets")
$matches = Invoke-RestMethod -Uri "$baseUrl/search?q=$query&limit=20&offset=0" -Headers $headers
$matches.results | Select-Object document_id, document_name, page_number, rank, excerpt
# Only inspect the first result when at least one match exists:
if ($matches.results.Count -gt 0) {
    $match = $matches.results[0]
    Invoke-RestMethod -Uri "$baseUrl/documents/$($match.document_id)/units/$($match.unit_index)" -Headers $headers
}
```

Results contain `document_id`, `document_name`, `unit_index`, `page_number`,
`rank`, and a plain-text `excerpt` of at most 600 characters. PDF page numbers
are physical one-based viewer positions; text files have null page numbers.
Only completed, indexed documents owned by the verified JWT user can match.
A different account's source unit returns the same 404 as a nonexistent unit.
No client-supplied owner parameter is accepted.

`q` must trim to 1-200 characters without control characters. Missing, blank,
array/object, or extra parameters return 400. `limit` defaults to 20 (1-50),
`offset` defaults to 0 (0-1000). `pagination.hasMore` indicates another accessible
page. Results sort by rank descending, then document ID and unit index. Separate
pages can change while documents are processed; there is no snapshot cursor.

Search uses English `plainto_tsquery`, `ts_rank_cd`, and `ts_headline` with empty
highlight markers. All remaining terms must match within one PDF page/text unit;
English stemming and stop words apply. Quotes/operators do not provide phrase
or Boolean syntax. Punctuation-only/stop-word-only queries return 200 with an
empty result list. Document filenames are displayed but not indexed. This is
lexical retrieval, not fuzzy/substring/semantic search or generated answers.
Non-English documents may match inconsistently with English language rules.
Long text units are subject to PostgreSQL full-text size/position limits.

Old completed documents have no page records until reprocessed. Retry clears old
results first, so a failed attempt cannot leave old search matches. PDFs with no
extractable text complete with a clear no-OCR message and no matches; OCR and
summarization are not implemented. Excerpts and source text must be rendered as
text (`textContent`), never interpreted as HTML.
