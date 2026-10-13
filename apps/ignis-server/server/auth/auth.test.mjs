import { describe, it, expect, vi } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

const require = createRequire(import.meta.url);
const { readAuthConfig } = require("./config");
const { hashPassword, verifyPassword, loadPassword, parseHash } = require("./password");
const { createSessions } = require("./sessions");
const { sameOrigin, createLimiter } = require("./index");

describe("authentication configuration", () => {
  it("requires exactly one credential source by default", () => {
    expect(() => readAuthConfig({})).toThrow("exactly one");
    expect(() => readAuthConfig({ IGNIS_PASSWORD_HASH: "a", IGNIS_PASSWORD_FILE: "b" })).toThrow("exactly one");
    expect(() => readAuthConfig({ IGNIS_PASSWORD_HASH: "" })).toThrow("empty");
    expect(() => readAuthConfig({ IGNIS_AUTH_MODE: "none" })).toThrow("password or external");
    expect(readAuthConfig({ IGNIS_AUTH_MODE: "external" }).mode).toBe("external");
    expect(() => readAuthConfig({ IGNIS_AUTH_MODE: "external", IGNIS_PASSWORD_FILE: "x" })).toThrow("Remove password");
  });

  it("validates public origins and explicit proxy addresses", () => {
    const env = { IGNIS_PASSWORD_HASH: "test" };
    expect(readAuthConfig(env)).toMatchObject({ origin: "http://localhost:8080", secure: false, trustProxy: [] });
    expect(readAuthConfig({ ...env, IGNIS_PUBLIC_ORIGIN: "https://ignis.example:8443/", IGNIS_TRUST_PROXY: "127.0.0.1,10.1.0.0/24,::1" }))
      .toMatchObject({ origin: "https://ignis.example:8443", secure: true, trustProxy: ["127.0.0.1", "10.1.0.0/24", "::1"] });
    for (const origin of ["http://192.168.1.2", "https://host/app", "https://user:pass@host", "https://host/?x=1", "null", "https://host/#x"]) {
      expect(() => readAuthConfig({ ...env, IGNIS_PUBLIC_ORIGIN: origin })).toThrow("HTTPS origin");
    }
    for (const proxy of ["true", "*", "0.0.0.0/0", "::/0", "10.1.0.0/33", "127.0.0.1/"]) {
      expect(() => readAuthConfig({ ...env, IGNIS_TRUST_PROXY: proxy })).toThrow("explicit proxy");
    }
  });
});

describe("credentials", () => {
  it("salts hashes, verifies passwords, and rejects unsupported formats", async () => {
    const one = await hashPassword("a strong test password");
    const two = await hashPassword("a strong test password");
    expect(one).not.toBe(two);
    expect(await verifyPassword("a strong test password", one)).toBe(true);
    expect(await verifyPassword("wrong password", one)).toBe(false);
    expect(await verifyPassword("x".repeat(1025), one)).toBe(false);
    expect(() => parseHash("$argon2id$unsupported")).toThrow("Invalid Ignis");
    expect(() => parseHash(one + "$extra")).toThrow();
    await expect(hashPassword("")).rejects.toThrow();
  });

  it("reads mounted passwords/hashes and fails closed without leaking paths or secrets", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ignis-auth-secret-"));
    try {
      const file = path.join(root, "secret");
      await fs.writeFile(file, "test password\n");
      const encoded = await loadPassword(readAuthConfig({ IGNIS_PASSWORD_FILE: file }));
      expect(await verifyPassword("test password", encoded)).toBe(true);
      await fs.writeFile(file, encoded + "\n");
      expect(await loadPassword(readAuthConfig({ IGNIS_PASSWORD_HASH_FILE: file }))).toBe(encoded);
      await fs.writeFile(file, "secret-contents-not-a-hash");
      await expect(loadPassword(readAuthConfig({ IGNIS_PASSWORD_HASH_FILE: file }))).rejects.toThrow("Invalid Ignis");
      await fs.writeFile(file, "x".repeat(4097));
      await expect(loadPassword(readAuthConfig({ IGNIS_PASSWORD_FILE: file }))).rejects.toThrow("at most 4096");
      await expect(loadPassword(readAuthConfig({ IGNIS_PASSWORD_FILE: root }))).rejects.toThrow("Cannot read authentication secret");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("sessions", () => {
  it("stores digests, expires sessions, and revokes their sockets independently", () => {
    let time = 100;
    const sessions = createSessions({ now: () => time, lifetime: 1000, maxSessions: 2 });
    const a = sessions.create();
    const b = sessions.create();
    expect(a.session.id).not.toBe(a.token);
    expect(sessions.get(a.token)).toBe(a.session);
    expect(sessions.get("malformed")).toBe(null);
    const socket = new EventEmitter();
    socket.close = vi.fn();
    sessions.bind(socket, a.session);
    sessions.revoke(a.session);
    expect(socket.close).toHaveBeenCalledWith(4004, "Authentication required");
    expect(sessions.get(a.token)).toBe(null);
    expect(sessions.get(b.token)).toBe(b.session);
    time = 1100;
    expect(sessions.get(b.token)).toBe(null);
    sessions.close();
  });

  it("bounds session storage and clears idle sockets on the expiry timer", () => {
    vi.useFakeTimers();
    try {
      const sessions = createSessions({ lifetime: 1000, maxSessions: 1 });
      const a = sessions.create();
      const b = sessions.create();
      expect(sessions.get(a.token)).toBe(null);
      const socket = new EventEmitter();
      socket.close = vi.fn();
      sessions.bind(socket, b.session);
      vi.advanceTimersByTime(1000);
      expect(socket.close).toHaveBeenCalledWith(4004, "Authentication required");
      expect(sessions.get(b.token)).toBe(null);
      sessions.close();
    } finally { vi.useRealTimers(); }
  });
});

describe("origin and abuse protection", () => {
  it("requires an exact Origin or same-origin Referer and never falls back from a bad Origin", () => {
    const origin = "https://ignis.example";
    expect(sameOrigin({ headers: { origin } }, origin)).toBe(true);
    expect(sameOrigin({ headers: { referer: origin + "/page" } }, origin)).toBe(true);
    for (const headers of [{}, { origin: "null" }, { origin: origin + ".evil" }, { origin: "https://evil", referer: origin }]) {
      expect(sameOrigin({ headers }, origin)).toBe(false);
    }
  });

  it("limits clients and the whole instance with time-limited windows", () => {
    let time = 0;
    const allow = createLimiter(() => time);
    for (let i = 0; i < 5; i++) expect(allow("one")).toBe(true);
    expect(allow("one")).toBe(false);
    for (let i = 0; i < 25; i++) expect(allow(String(i))).toBe(true);
    expect(allow("new-ip")).toBe(false);
    time = 900001;
    expect(allow("one")).toBe(true);
  });
});
