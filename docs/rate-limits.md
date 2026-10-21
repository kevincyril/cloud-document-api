# Request rate limits

Each endpoint has a separate allowance. All attempts count, including requests
that return validation errors or processing failures.

| Endpoint | Allowance | Identity |
| --- | --- | --- |
| `POST /auth/login` | 20 requests per 15 minutes | Connection IP address |
| `POST /auth/register` | 5 requests per hour | Connection IP address |
| `POST /documents/upload` | 20 requests per 15 minutes | Authenticated user ID |
| `POST /documents/:id/process` | 20 requests per 15 minutes | Authenticated user ID |

Exceeding an allowance returns HTTP `429`:

```json
{"status":"error","message":"Too many requests; try again later"}
```

The `Retry-After` response header gives the wait in seconds. `RateLimit` and
`RateLimit-Policy` headers describe the allowance. Windows start with the first
request for that identity. Users behind the same IP share authentication limits,
but their authenticated upload and processing allowances are separate.

Authentication runs before upload and processing limits. Upload limits run
before Multer buffers the file. Refreshing a JWT does not reset a user's budget.

Counters currently use the library's in-memory store: restarting the API resets
them, and separate API processes have separate counters. Before running multiple
instances, configure a shared store such as Redis. These limits do not bound the
number of simultaneous requests or replace file validation and resource limits.

Express currently uses its default `trust proxy: false`. Forwarded client-IP
headers are not trusted. When choosing hosting, configure trusted proxies to
match that provider's network; otherwise a reverse proxy can make users share
one IP allowance. Do not set `trust proxy: true` without checking the network.

The values are defined in `src/middleware/rate-limit.middleware.ts`.
Run the isolated checks with `node --test scripts/rate-limiting.test.cjs`.
