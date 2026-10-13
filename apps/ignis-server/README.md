# Ignis Server

The self-hosted Docker variant of Ignis. For the project overview and feature list, see the [root README](../../README.md).

Setup, configuration, and operations documentation is at **[ignis.thiefling.com/docs](https://ignis.thiefling.com/docs/)**:

- [Deploy with Docker](https://ignis.thiefling.com/docs/server/deploy/)
- [Environment variables](https://ignis.thiefling.com/docs/server/environment/)
- [Updating](https://ignis.thiefling.com/docs/server/updating/)
- [Remote access](https://ignis.thiefling.com/docs/security/remote-access/) and [Authentication](https://ignis.thiefling.com/docs/security/authentication/)
- [Settings](https://ignis.thiefling.com/docs/using/settings/) and [Hardening](https://ignis.thiefling.com/docs/security/hardening/)

To build the image from source, run `docker compose up` against the [`docker-compose.yml`](docker-compose.yml) in this directory.

Built-in password authentication is enabled by default. For the source compose file, create `.ignis-secrets/password` beside it and open `http://localhost:8082`. Configure `IGNIS_PUBLIC_ORIGIN` for remote HTTPS access. Existing authentication gateways must explicitly select `IGNIS_AUTH_MODE=external`. See [the implementation plan](../../docs/AUTHENTICATION-PLAN.md).
