# Dashboard Authentication

The Mercury dashboard (`/dashboard/*`) is protected by `MERCURY_API_SECRET`. All htmx partial requests and the SSE events stream require a valid `mercury_token` session cookie.

## How it works

### Login route

`GET /dashboard/login?token=<secret>` — the entry point for browser sessions.

- Validates `token` against `MERCURY_API_SECRET` using `timingSafeEqual`
- On success: sets `mercury_token` HttpOnly cookie and redirects to `/dashboard`
- On failure: returns `401 Invalid or missing token`
- Not protected by the dashboard auth middleware (it's the login endpoint itself)

## Auth flow

```
User navigates to https://<host>:<port>/dashboard/login?token=<MERCURY_API_SECRET>
  → agent sets mercury_token HttpOnly cookie
  → 302 /dashboard
  → dashboard loads, htmx requests include cookie ✅
```

## Key constraints

- `MERCURY_API_SECRET` should be set to a long random string. `mercury setup` auto-generates one.
- The cookie is HttpOnly — not accessible from JavaScript.
