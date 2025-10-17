# Firebase HTTP Proxy

A minimal Firebase-hosted HTTP proxy implemented as a Cloud Function (Express). The proxy forwards requests to a target URL while enforcing basic protections:
- optional API key authentication
- allowed-hosts whitelist (supports comma-separated hostnames and leading wildcards like `*.example.com`)
- header passthrough (with hop-by-hop header filtering)
- streaming uploads and streaming/chunked downloads
- CORS support

IMPORTANT: Running an open proxy is a serious security and abuse risk. Always configure the allowed hosts and require an API key. Add rate-limiting and monitoring before public use.

Repo layout

- firebase.json — Firebase configuration (rewrites to function)
- .firebaserc — Firebase project aliases
- .github/workflows — CI + deploy workflows
- functions/
  - package.json — function dependencies
  - index.js — Express proxy implementation

How it works

The function provides a single endpoint:
- POST or GET to `/proxy` with a `url` query parameter or a JSON `{"url":"https://example.com/path"}` body.
- The function validates the requested host against the configured ALLOWED_HOSTS and checks an API key if configured.
- The function forwards method, headers (filtered), and body, and relays the response status, headers, and body back to the client; it supports streaming uploads and streaming/chunked responses.

Security & Hardening (Recommended)

1. Configure ALLOWED_HOSTS to a minimal set of domains you intend to call.
2. Require an API key (set via `firebase functions:config:set` or GitHub Actions secrets) and validate it in requests.
3. Add rate limiting (e.g., Cloud Run + API Gateway or an in-process limiter).
4. Add logging and alerting for abuse patterns.
5. Consider signed requests, OAuth, or other authorization for higher security.
6. Do not deploy this as an open proxy.

Setup & deploy

1. Install Firebase CLI:
   npm install -g firebase-tools

2. Login and select/create a project:
   firebase login
   firebase projects:create my-proxy-project
   firebase use --add my-proxy-project

3. Install dependencies:
   cd functions
   npm ci
   cd ..

4. Configure runtime settings (example via GitHub Actions secrets or locally):
   firebase functions:config:set proxy.allowed_hosts="example.com,api.example.com" proxy.api_key="MY_SECRET_KEY"

   Or set environment variables in CI: `PROXY_ALLOWED_HOSTS`, `PROXY_API_KEY`, `PROXY_TIMEOUT_MS`.

5. Deploy (or push to main to trigger GitHub Actions deploy):
   firebase deploy --only functions

Example usage:

curl -H "X-API-KEY: MY_SECRET_KEY" "https://<REGION>-<PROJECT>.cloudfunctions.net/proxy?url=https://example.com/api"

Notes

- This implementation intentionally keeps logic small and readable. Extend it to include timeouts, retry strategies, request size limits, logging, and rate limiting before production use.
- If you plan to proxy binary data, the function passes through request and response streams; keep an eye on memory/timeout limits.

License: MIT