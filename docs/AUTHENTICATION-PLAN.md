# Ignis authentication implementation

## Selected strategy

Single-owner password authentication with server-side sessions. All signed-in browsers have full access to every vault and setting. Credentials are deployment-managed, sessions do not survive restarts, and missing configuration fails startup. An explicit external mode preserves gateway-based deployments.

| Alternative | Benefit | Tradeoff relative to the selected strategy |
| --- | --- | --- |
| Individual local accounts | Per-person revocation and identity | Requires account management; private vaults also require authorization throughout plugins, sync, and settings. |
| Built-in OIDC | Provider-managed MFA and SSO | Adds identity-provider setup and availability dependencies. |
| External gateway only | Existing SSO/MFA capabilities, no local password handling | More deployment configuration; direct backend access bypasses the gateway. |
| Selected owner password | One-container operation, small storage model | No individual permissions, audit identity, or built-in MFA. |

code-server's [password login](https://coder.com/docs/code-server/guide) is the closer scope match. Kavita's [user permissions](https://wiki.kavitareader.com/guides/admin-settings/users/) represent a larger account/authorization feature.

## Flow, storage, and interfaces

1. Before listening, validate `IGNIS_AUTH_MODE`, the credential source, public origin, and trusted proxy addresses. Password mode requires exactly one of `IGNIS_PASSWORD_HASH`, `IGNIS_PASSWORD_HASH_FILE`, or `IGNIS_PASSWORD_FILE`. External mode rejects credential configuration to avoid misleading operators.
2. Load the secret once. Hash plaintext with asynchronous Node scrypt; encoded hashes use `ignis-scrypt-v1$<16-byte salt hex>$<32-byte key hex>`, with `N=131072`, `r=8`, `p=1`, and a 160 MiB memory ceiling. Compare derived keys in constant time. These settings follow [OWASP's scrypt guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).
3. Serve `/login` and an explicit list of non-sensitive login assets. `POST /api/auth/login` accepts JSON `{password}` and sets a fresh HttpOnly, SameSite=Lax, host-only cookie, Secure for HTTPS origins. `GET /api/auth/session` reports mode and expiry; `POST /api/auth/logout` revokes the current session.
4. Store only SHA-256 digests of random 256-bit session tokens, expiration timestamps, and associated socket references in memory. Expire after seven days; retain at most 128 sessions, evicting the oldest on overflow. Restart/credential rotation revokes all sessions. No users table, database service, database migration, or persistent session volume is needed.
5. A central Express gate protects APIs, vault downloads, static assets, and subsequently registered plugin routes. APIs return `401` with `AUTH_REQUIRED` and `X-Ignis-Auth: required`; main-page navigation redirects to login. Preserve only local app return URLs.
6. Require a matching Origin for unsafe requests, with same-origin Referer fallback only when Origin is absent. WebSocket upgrades require an exact browser Origin and a valid session. Check live session validity before incoming messages and all outgoing sends, including plugin sends. Revocation closes sockets with code 4004.
7. Observe browser fetch and synchronous/asynchronous XHR auth failures without consuming bodies or changing external requests. Keep the editor open, offer reauthentication in a separate tab, and pause/restart WebSocket reconnects. Do not silently replay mutations or discard unsaved editor state.

Login requests are limited to 4 KiB JSON and 1024 UTF-8 password bytes. Rate limits allow five attempts per IP and thirty per instance per fifteen-minute window. Limiter state is bounded and password verification concurrency is one. Forwarded IPs are ignored unless the operator configures explicit proxy IPs/CIDRs. Origin validation and cookie security use the configured public origin, never arbitrary forwarded headers.

## File inventory

Paths are relative to the repository root. New auth files contain the feature; existing API routers inherit its boundary rather than duplicating password logic.

| Files | Responsibility |
| --- | --- |
| `apps/ignis-server/server/auth/config.js` (new), `server/config.js` | Validate deployment auth configuration; expose the configuration reader. |
| `apps/ignis-server/server/auth/password.js` (new) | Bounded secret-file loading, versioned hash parsing, scrypt generation/verification. |
| `apps/ignis-server/server/auth/sessions.js` (new) | Session digests, caps, expiry timers, socket binding/revocation. |
| `apps/ignis-server/server/auth/index.js` (new) | Public auth endpoints/assets, origin enforcement, rate limits, protected-route gate, WebSocket adapter. |
| `apps/ignis-server/server/index.js` | Initialize auth before listening, mount its gate before parsers/routes, configure proxy trust, close sessions on shutdown. |
| `packages/server-core/src/ws.js` | Inject upgrade authorization and live-session checks into shared WebSocket code. |
| `apps/ignis-server/server/assets/auth/{login.html,login.js,auth-client.js,auth.css}` (new) | Standalone login, safe return navigation, HTTP failure observation, expiry notice, session polling and logout. |
| `apps/ignis-server/server/assets/index.html` | Load auth handling before Obsidian and the shim. |
| `packages/shim/src/ws-client.js` | Pause for auth loss, inspect session status after rejected upgrades, resume on reauthentication. |
| `packages/bridge/src/main.js` | Visible logout ribbon and command. |
| `apps/ignis-server/scripts/hash-password.js` (new) | Hidden prompt/stdin hash helper, usable through the image's Node entrypoint. |
| `apps/ignis-server/server/static/cache-headers.js`, `server/routes/bootstrap.js`, `server/routes/fs.js` | Private asset caching; no-store for private API/vault data. |
| `apps/ignis-server/docker-compose.yml`, both `examples/caddy-*/docker-compose.yml`, `.gitignore` | Local mounted-secret deployment; explicit external mode for private proxy backends; ignore local secrets. |
| `README.md`, `apps/ignis-server/README.md`, `CHANGELOG.md` | Setup and breaking upgrade guidance. |
| `apps/docs/src/content/docs/security/{authentication,remote-access,hardening}.md`, `server/{deploy,environment,updating}.md` | Operational setup, proxy boundaries, recovery, browser sessions, migration instructions. |
| New auth unit/integration/browser tests and existing WS/cache-header tests | Verify boundaries and recovery with a real composed server and deterministic browser transport checks. |

The existing Dockerfile already copies server assets and scripts. No new runtime dependency or Docker service is required. Auth configuration is deliberately absent from the existing settings and bootstrap APIs. Obsidian-account/headless-sync authentication remains a separate concern.

## Acceptance and rollout

- Test startup failures for missing, malformed, conflicting, and unreadable credentials without secret disclosure.
- Test password verification, unique salts, independent sessions, expiry, bounded storage, logout, restart, and credential rotation.
- Exercise the real server: deny unauthenticated APIs, attachments, downloads, application assets, plugin routes, and WS upgrades. Confirm legitimate access after login.
- Verify foreign/missing origins, forged forwarded headers, body limits, rate limits, secure cookies, generic parser errors, and revoked sockets.
- Verify synchronous XHR/fetch auth notices, non-auth upstream 401 handling, safe return URLs, reconnection, and absence of automatic request replay.
- Run focused tests, the complete test suite, lint, and build; smoke-test localhost and HTTPS/external gateway configurations where the environment permits.
- Release as a configuration-breaking change. Existing operators must configure credentials or external mode before upgrading. No vault or settings migration is required; restart invalidates sessions.

Auth protects access to the trusted-owner application; it does not sandbox community plugins or create user/vault isolation. Logout cannot erase content already downloaded by a browser.

## Implementation validation

- Full repository suite: 79 files / 853 tests passed before the final additional WS expiry test; that extra test passed in focused validation.
- Node 22 Docker runtime: all 30 authentication, browser-transport, and WebSocket tests passed.
- `npm run lint` and `npm run build` passed. Build warnings concern pre-existing direct eval and Svelte accessibility code.
- Headless Chromium: localhost HTTP and HTTPS reverse-proxy login/cookie/logout/reauthentication passed, preserving unsaved text in a test editor. HTTPS external Basic Auth gateway mode also passed.
- All three Compose configurations validated. The full Caddy/Authelia stacks and a live Obsidian session were not launched; server integration tests use fixture vaults/assets and browser smoke tests use a minimal editor.
