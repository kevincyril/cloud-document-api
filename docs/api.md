# Try the API in PowerShell

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
