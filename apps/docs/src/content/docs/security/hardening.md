---
title: Hardening
description: Important security considerations.
---

Serving Ignis in a [secure context](/docs/security/remote-access/) and configuring [authentication](/docs/security/authentication/) are the essentials for any exposed instance. Two further settings shape the security surface, and are worth understanding before you open it up.

## The cross-origin proxy

Ignis runs a server-side proxy at `/api/proxy` so that plugins can reach hosts the browser would otherwise block by CORS. Since these requests pass through the server, the security surface extends to the server's network position.

By default the proxy reaches any public host and rejects private, loopback, and link-local addresses, which stops it from being turned into a probe of your internal network (a server-side request forgery, or SSRF, surface). The following two settings let you change what the proxy can reach:

- **The allowlist.** From the proxy settings in the [Settings](/docs/using/settings/) panel, you can narrow the proxy to specific hosts, or turn it off entirely if no plugin needs it. A narrower allowlist is a smaller risk surface.
- **`PROXY_ALLOW_PRIVATE_HOSTS`.** This environment variable grants the proxy access to specific private IPs or CIDRs, if you need Obsidian to access any LAN services. This deliberately reopens SSRF only to the targets you list, so keep it minimal and never widen it to a private range you do not control.

There is also a direct-fetch list setting that marks CORS-friendly hosts the browser fetches directly, bypassing the proxy. These requests do not pass through the server and so are not affected by the proxy's security implications.

## WebSocket origins

In password mode, every WebSocket upgrade requires a valid session and an Origin matching `IGNIS_PUBLIC_ORIGIN`. Expiry and logout revoke live connections. `WS_ORIGINS`, if set, adds another allowlist check.

In external mode, the gateway must authenticate WebSocket upgrades as well as HTTP requests. Set [`WS_ORIGINS`](/docs/server/environment/) to your browser origin; without it the application does not restrict origins in external mode. Never publish a backend port that bypasses the gateway.

## Sessions and trusted code

All authenticated browsers have owner access to every vault, setting, and server plugin. Community plugins run as trusted code in the signed-in browser; authentication does not sandbox them. Logout cannot erase already downloaded content from other tabs. Save changes before signing out and close tabs on shared devices.

Only set `IGNIS_TRUST_PROXY` for controlled proxy addresses that replace forwarded headers. The default ignores forwarded client IPs. With no trust configuration, clients behind a proxy share its login limit.
