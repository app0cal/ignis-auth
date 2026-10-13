const { randomBytes, createHash } = require("node:crypto");

const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const digest = (token) => createHash("sha256").update(token).digest("hex");

function createSessions({ now = Date.now, lifetime = SESSION_MS, maxSessions = 128 } = {}) {
  const sessions = new Map();

  function revoke(session) {
    if (!session || !sessions.delete(session.id)) return;
    clearTimeout(session.timer);
    for (const socket of session.sockets) socket.close(4004, "Authentication required");
    session.sockets.clear();
  }

  function active(session) {
    if (!session || sessions.get(session.id) !== session) return false;
    if (session.expiresAt <= now()) {
      revoke(session);
      return false;
    }
    return true;
  }

  function create() {
    for (const session of sessions.values()) active(session);
    if (sessions.size >= maxSessions) revoke(sessions.values().next().value);
    const token = randomBytes(32).toString("base64url");
    const session = { id: digest(token), expiresAt: now() + lifetime, sockets: new Set() };
    sessions.set(session.id, session);
    session.timer = setTimeout(() => revoke(session), lifetime);
    session.timer.unref?.();
    return { token, session };
  }

  function get(token) {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const session = sessions.get(digest(token));
    return active(session) ? session : null;
  }

  function bind(socket, session) {
    if (!active(session)) {
      socket.close(4004, "Authentication required");
      return;
    }
    session.sockets.add(socket);
    socket.once("close", () => session.sockets.delete(socket));
  }

  function close() {
    for (const session of sessions.values()) revoke(session);
  }

  return { create, get, active, revoke, bind, close };
}

module.exports = { createSessions, SESSION_MS };
