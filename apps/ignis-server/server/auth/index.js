const express = require("express");
const path = require("node:path");
const { loadPassword, verifyPassword, validPassword } = require("./password");
const { createSessions, SESSION_MS } = require("./sessions");

const COOKIE = "ignis_session";
const NO_STORE = "private, no-store";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const ASSETS = new Set(["login.js", "auth-client.js", "auth.css"]);

function readCookie(req) {
  const values = (req.headers.cookie || "").split(";")
    .map((part) => part.trim()).filter((part) => part.startsWith(`${COOKIE}=`));
  return values.length === 1 ? values[0].slice(COOKIE.length + 1) : null;
}

function sameOrigin(req, origin) {
  if (req.headers.origin !== undefined) return req.headers.origin === origin;
  try {
    return new URL(req.headers.referer).origin === origin;
  } catch {
    return false;
  }
}

function createLimiter(now = Date.now) {
  const clients = new Map();
  let global = { count: 0, expires: 0 };
  return (ip) => {
    const time = now();
    for (const [key, value] of clients) {
      if (value.expires <= time) clients.delete(key);
    }
    if (global.expires <= time) global = { count: 0, expires: time + 15 * 60 * 1000 };
    let client = clients.get(ip);
    if (!client) {
      if (clients.size >= 2048) return false;
      client = { count: 0, expires: time + 15 * 60 * 1000 };
      clients.set(ip, client);
    }
    if (client.count >= 5 || global.count >= 30) return false;
    client.count++;
    global.count++;
    return true;
  };
}

async function createAuth(config, { sessions = createSessions(), now = Date.now } = {}) {
  const passwordHash = await loadPassword(config);
  const external = config.mode === "external";
  const router = express.Router();
  const assets = path.join(__dirname, "..", "assets", "auth");
  const allowAttempt = createLimiter(now);
  let verifying = false;
  const cookieOptions = { httpOnly: true, sameSite: "lax", secure: config.secure, path: "/" };
  const sessionFor = (req) => sessions.get(readCookie(req));

  function unauthorized(res) {
    return res.status(401).set("X-Ignis-Auth", "required").json({
      error: "Authentication required", code: "AUTH_REQUIRED",
    });
  }

  // Install first, before parsers and dynamically registered application routes.
  router.use((req, res, next) => {
    res.set("Cache-Control", NO_STORE);
    res.set("X-Content-Type-Options", "nosniff");
    if (!external && !SAFE_METHODS.has(req.method) && !sameOrigin(req, config.origin)) {
      return res.status(403).json({ error: "Request origin not allowed", code: "ORIGIN_DENIED" });
    }
    next();
  });

  router.get("/login", (_req, res) => {
    res.set("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    res.set("Referrer-Policy", "no-referrer");
    res.sendFile(path.join(assets, "login.html"));
  });
  router.get("/auth-assets/:file", (req, res, next) => {
    if (!ASSETS.has(req.params.file)) return next();
    res.sendFile(path.join(assets, req.params.file));
  });
  router.get("/api/auth/session", (req, res) => {
    const session = sessionFor(req);
    if (!external && !session) return unauthorized(res);
    res.json({ mode: config.mode, authenticated: true, expiresAt: session?.expiresAt ?? null });
  });
  router.post("/api/auth/login", (req, res, next) => {
    if (external) return res.status(404).json({ error: "Local login is disabled" });
    if (!allowAttempt(req.ip)) {
      return res.status(429).set("Retry-After", "900").json({ error: "Too many login attempts; try again later" });
    }
    if (verifying) return res.status(429).set("Retry-After", "1").json({ error: "Login busy; try again" });
    if (!req.is("application/json")) return res.status(415).json({ error: "Expected application/json" });
    next();
  }, express.json({ limit: "4kb", inflate: false }), async (req, res) => {
    if (!validPassword(req.body?.password)) return res.status(400).json({ error: "Invalid password input" });
    // Check again after body parsing: multiple requests can arrive while a body streams.
    if (verifying) return res.status(429).set("Retry-After", "1").json({ error: "Login busy; try again" });
    verifying = true;
    try {
      if (!await verifyPassword(req.body.password, passwordHash)) {
        return res.status(401).json({ error: "Invalid password" });
      }
      sessions.revoke(sessionFor(req));
      const { token, session } = sessions.create();
      res.cookie(COOKIE, token, { ...cookieOptions, maxAge: SESSION_MS });
      res.json({ authenticated: true, expiresAt: session.expiresAt });
    } catch {
      res.status(503).json({ error: "Authentication temporarily unavailable" });
    } finally {
      verifying = false;
    }
  });
  router.post("/api/auth/logout", (req, res) => {
    sessions.revoke(sessionFor(req));
    res.clearCookie(COOKIE, cookieOptions);
    res.status(204).end();
  });

  // Sanitize parser/sendFile errors here so Express never returns internal details.
  router.use((err, _req, res, _next) => {
    const status = [400, 404, 413, 415].includes(err.status) ? err.status : 500;
    res.status(status).json({ error: "Authentication request failed" });
  });

  router.use((req, res, next) => {
    if (external || sessionFor(req)) return next();
    if (["GET", "HEAD"].includes(req.method) && ["/", "/index.html"].includes(req.path)) {
      return res.redirect(302, `/login?returnTo=${encodeURIComponent(req.originalUrl)}`);
    }
    return unauthorized(res);
  });

  return {
    router,
    close: sessions.close,
    websocket: {
      authorizeUpgrade: (req) => external ? {} :
        (req.headers.origin === config.origin ? sessionFor(req) : null),
      isConnectionAuthorized: (session) => external || sessions.active(session),
      onAuthorizedConnection: (socket, session) => {
        if (!external) sessions.bind(socket, session);
      },
    },
  };
}

module.exports = { createAuth, createLimiter, sameOrigin };
