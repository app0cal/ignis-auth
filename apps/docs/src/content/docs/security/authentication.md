---
title: Authentication
description: Built-in owner login or an external authentication gateway.
---

Ignis defaults to a built-in **single-owner password login**. Every signed-in browser can read and write every vault, change settings, and manage plugins. There are no individual accounts or per-vault permissions. This login is separate from your Obsidian account and Headless Sync credentials.

## Configure a password

Choose exactly one credential source:

- `IGNIS_PASSWORD_FILE`: a mounted file containing your password. Ignis hashes it in memory at startup.
- `IGNIS_PASSWORD_HASH_FILE`: a mounted file containing a hash made by the Ignis helper. This avoids keeping a plaintext password on the host.
- `IGNIS_PASSWORD_HASH`: the same hash supplied directly as an environment variable. A mounted hash file avoids environment inspection and Docker Compose `$` interpolation concerns.

Use a strong, unique password. Restrict file access on the host, ensure the container's configured user can read the mounted file, and keep it out of version control. Files may have one trailing newline. Empty, unreadable, conflicting, or malformed credentials prevent startup. Changes take effect after restarting the container.

The [Docker deployment guide](/docs/server/deploy/) includes a mounted password secret. For example:

```yaml
services:
  ignis:
    image: nobbe/ignis:latest
    environment:
      IGNIS_PASSWORD_FILE: /run/secrets/ignis_password
      IGNIS_PUBLIC_ORIGIN: https://ignis.example.com
    secrets:
      - ignis_password
    # Keep the existing vault/data mounts and private proxy network.
secrets:
  ignis_password:
    file: ./.ignis-secrets/password
```

Set `IGNIS_PUBLIC_ORIGIN` to your browser's exact origin: scheme, hostname, and any non-default port, without a subpath. The default is `http://localhost:<PORT>`. Password login on other machines requires HTTPS through a reverse proxy or `tailscale serve`; see [Remote access](/docs/security/remote-access/). For a different local published port, set the origin to that port too.

### Generate a hash

From a source checkout with Node 22:

```bash
node apps/ignis-server/scripts/hash-password.js
```

Or use the container image without starting Ignis:

```bash
docker run --rm -it --entrypoint node nobbe/ignis:latest apps/ignis-server/scripts/hash-password.js
```

The prompt hides input. Copy only the resulting `ignis-scrypt-v1$...` line into your mounted hash file and configure `IGNIS_PASSWORD_HASH_FILE`. The helper also accepts stdin from a secret manager; it rejects password command-line arguments. It uses scrypt with a random salt, `N=131072`, `r=8`, and `p=1`. Hashes from other products are not interchangeable.

### Reset a forgotten password

Replace the configured password or hash file and restart the container. There is no email reset, default password, or public setup endpoint. This requires access to your deployment. Rotating the credential and restarting also revokes all existing browser sessions.

## Sessions and sign-out

Each browser receives an HttpOnly cookie and an independent session lasting seven days. HTTPS origins use a Secure cookie. Sessions are held only in memory: container restarts and image updates require logging in again. No database or additional volume is required.

Use the **Sign out of Ignis** ribbon icon or command to revoke this browser's session. Other tabs in that browser share the cookie and will also need to sign in. Other browsers remain signed in. At most 128 sessions are retained; a new login beyond that limit revokes the oldest.

On expiry, the editor stays open and shows a link to sign in in another tab. After signing in, return to the editor and retry any failed saves using the existing save-failure controls. Ignis does not automatically replay arbitrary failed requests. Logout prevents further server access but cannot erase content already downloaded into a tab; close tabs on shared devices.

Login permits five attempts per client IP and thirty attempts across the instance per fifteen-minute window, including successful attempts. Only one password verification runs at a time. A rate-limited response includes `Retry-After`. For reverse proxies, `IGNIS_TRUST_PROXY` can list explicit trusted proxy IPs/CIDRs for client-IP attribution. Only trust controlled proxies that replace forwarded headers. By default, forwarded headers are ignored and clients behind a proxy share its limit.

## External authentication

If your gateway already authenticates every request, set:

```yaml
environment:
  IGNIS_AUTH_MODE: external
  WS_ORIGINS: https://ignis.example.com
```

Remove all password credential variables in this mode. Ignis delegates authentication completely; it does not validate identity headers or verify that the gateway authenticated a request. Keep the backend port unpublished or otherwise reachable only by the gateway. The gateway must protect HTTP requests, attachments, plugin APIs, and WebSocket upgrades.

The repository includes [Caddy Basic Auth](https://github.com/Nystik-gh/ignis/tree/main/apps/ignis-server/examples/caddy-basic-auth) and [Caddy with Authelia](https://github.com/Nystik-gh/ignis/tree/main/apps/ignis-server/examples/caddy-authelia) examples configured for external mode. Authelia or another identity gateway can provide SSO and MFA. Sign out through that gateway; Ignis cannot revoke its session.

## Upgrading an existing installation

Before upgrading, configure a credential source and your public origin, or explicitly select external mode behind your existing gateway. There is no anonymous fallback. Vaults and existing settings need no migration. See [Updating](/docs/server/updating/).
