import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";

const require = createRequire(import.meta.url);
const { hashPassword } = require("./password");
const { WebSocket } = require("ws");
const origin = "https://ignis.test";
let root;
let hash;
const children = new Set();

async function start(extra = {}, expectFailure = false) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("IGNIS_PASSWORD") || key.startsWith("IGNIS_AUTH") || key === "IGNIS_TRUST_PROXY") delete env[key];
  }
  const child = spawn(process.execPath, ["apps/ignis-server/server/index.js"], {
    env: { ...env, PORT: "0", VAULT_ROOT: path.join(root, "vaults"), DATA_ROOT: path.join(root, "data"),
      OBSIDIAN_ASSETS_PATH: path.join(root, "obsidian"), OBSIDIAN_TERMS_STRING: "test terms",
      IGNIS_PASSWORD_HASH: hash, IGNIS_PUBLIC_ORIGIN: origin, ...extra },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  let output = "";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server startup timed out: ${output}`)), 10000);
    function data(chunk) {
      output += chunk;
      const match = output.match(/Server running on http:\/\/localhost:(\d+)/);
      if (match && !expectFailure) {
        clearTimeout(timer);
        resolve({ child, base: `http://127.0.0.1:${match[1]}`, output: () => output });
      }
    }
    child.stdout.on("data", data);
    child.stderr.on("data", data);
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      children.delete(child);
      if (expectFailure) resolve({ code, output });
      else if (!/Server running/.test(output)) reject(new Error(output));
    });
  });
}

async function stop(child) {
  if (child.exitCode !== null) return;
  const done = once(child, "exit");
  child.kill("SIGTERM");
  await done;
}

async function login(base, headers = {}, password = "test owner password") {
  const response = await fetch(base + "/api/auth/login", {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ password }),
  });
  return { response, cookie: response.headers.get("set-cookie")?.split(";")[0] };
}

function rejectedUpgrade(base, headers) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace("http:", "ws:") + "/ws?vault=v", { headers });
    ws.on("unexpected-response", (_req, res) => { res.resume(); ws.terminate(); resolve(res.statusCode); });
    ws.on("open", () => { ws.terminate(); reject(new Error("Unexpected WebSocket access")); });
    ws.on("error", () => {});
  });
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ignis-auth-server-"));
  await fs.mkdir(path.join(root, "vaults", "v"), { recursive: true });
  await fs.mkdir(path.join(root, "obsidian"));
  await fs.writeFile(path.join(root, "vaults", "v", "note.md"), "private note");
  await fs.writeFile(path.join(root, "obsidian", "index.html"), '<script src="app.js"></script>');
  await fs.writeFile(path.join(root, "obsidian", "app.js"), "// private application asset");
  hash = await hashPassword("test owner password");
});
afterAll(async () => {
  await Promise.all([...children].map(stop));
  await fs.rm(root, { recursive: true, force: true });
});

describe("real server authentication boundary", () => {
  it("protects routes, attachments, static assets, and upgrades before application handlers", async () => {
    const { child, base } = await start();
    try {
      const rootResponse = await fetch(base + "/?vault=v&file=note.md", { redirect: "manual" });
      expect(rootResponse.status).toBe(302);
      expect(rootResponse.headers.get("location")).toContain("returnTo=%2F%3Fvault");
      const loginPage = await fetch(base + "/login");
      expect(loginPage.status).toBe(200);
      // Without JavaScript, never submit a password in a GET query string.
      expect(await loginPage.text()).toContain('method="post" action="/api/auth/login"');
      for (const route of ["/api/bootstrap", "/api/settings", "/api/vault/list", "/api/fs/readFile?vault=v&path=note.md",
        "/api/fs/download?vault=v&path=note.md", "/api/plugins", "/api/ext/headless-sync/status", "/vault-files/v/note.md",
        "/app.js", "/assets/index.html", "/auth-assets/login.html", "/api/version"]) {
        const response = await fetch(base + route);
        expect(response.status, route).toBe(401);
        expect(response.headers.get("cache-control"), route).toBe("private, no-store");
        expect(response.headers.get("x-ignis-auth")).toBe("required");
      }
      const proxy = await fetch(base + "/api/proxy", { method: "POST", headers: { Origin: origin } });
      expect(proxy.status).toBe(401);
      expect(await rejectedUpgrade(base, { Origin: origin })).toBe(401);
      const { response, cookie } = await login(base);
      expect(response.status).toBe(200);
      expect(response.headers.get("set-cookie")).toMatch(/HttpOnly/);
      expect(response.headers.get("set-cookie")).toMatch(/Secure/);
      expect(response.headers.get("set-cookie")).toMatch(/SameSite=Lax/);
      expect(response.headers.get("set-cookie")).not.toMatch(/Domain=/);
      const note = await fetch(base + "/vault-files/v/note.md", { headers: { Cookie: cookie } });
      expect(await note.text()).toBe("private note");
      expect(note.headers.get("cache-control")).toBe("private, no-store");
      const settings = await fetch(base + "/api/settings", { headers: { Cookie: cookie } });
      expect(settings.status).toBe(200);
      expect(await settings.text()).not.toContain(hash);
      expect(await rejectedUpgrade(base, { Cookie: cookie, Origin: "https://evil.test" })).toBe(401);
      const ws = new WebSocket(base.replace("http:", "ws:") + "/ws?vault=v", { headers: { Origin: origin, Cookie: cookie } });
      await once(ws, "open");
      const closed = once(ws, "close");
      const logout = await fetch(base + "/api/auth/logout", { method: "POST", headers: { Origin: origin, Cookie: cookie } });
      expect(logout.status).toBe(204);
      expect((await closed)[0]).toBe(4004);
      expect((await fetch(base + "/api/auth/session", { headers: { Cookie: cookie } })).status).toBe(401);
      expect(await rejectedUpgrade(base, { Origin: origin, Cookie: cookie })).toBe(401);
    } finally { await stop(child); }
  }, 15000);

  it("rejects cross-origin operations, oversized bodies, malformed JSON, and forged client IPs", async () => {
    const { child, base } = await start();
    try {
      expect((await login(base, { Origin: "https://evil.test" })).response.status).toBe(403);
      expect((await fetch(base + "/api/auth/login", { method: "POST" })).status).toBe(403);
      const malformed = await fetch(base + "/api/auth/login", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: "{" });
      expect(malformed.status).toBe(400);
      expect(await malformed.text()).not.toContain("SyntaxError");
      expect((await login(base, {}, "x".repeat(5000))).response.status).toBe(413);
      expect((await login(base, {}, "wrong")).response.status).toBe(401);
      const { cookie } = await login(base);
      for (const endpoint of ["/api/auth/logout", "/api/fs/writeFile", "/api/settings"]) {
        const response = await fetch(base + endpoint, { method: "POST", headers: { Cookie: cookie, Origin: "https://evil.test" } });
        expect(response.status).toBe(403);
      }
      const allowed = await fetch(base + "/api/auth/logout", { method: "POST", headers: { Cookie: cookie, Referer: origin + "/" } });
      expect(allowed.status).toBe(204);
      expect((await login(base, { "X-Forwarded-For": "203.0.113.1" }, "wrong")).response.status).toBe(401);
      expect((await login(base, { "X-Forwarded-For": "203.0.113.2" }, "wrong")).response.status).toBe(429);
    } finally { await stop(child); }
  }, 15000);

  it("keeps browser sessions independent and invalidates them on restart and credential rotation", async () => {
    let running = await start();
    const a = await login(running.base);
    const b = await login(running.base);
    await fetch(running.base + "/api/auth/logout", { method: "POST", headers: { Origin: origin, Cookie: a.cookie } });
    expect((await fetch(running.base + "/api/auth/session", { headers: { Cookie: b.cookie } })).status).toBe(200);
    await stop(running.child);
    running = await start();
    expect((await fetch(running.base + "/api/auth/session", { headers: { Cookie: b.cookie } })).status).toBe(401);
    await stop(running.child);
    running = await start({ IGNIS_PASSWORD_HASH: await hashPassword("replacement password") });
    try {
      expect((await login(running.base)).response.status).toBe(401);
      expect((await login(running.base, {}, "replacement password")).response.status).toBe(200);
    } finally { await stop(running.child); }
  }, 15000);

  it("fails startup for missing/malformed credentials and supports explicit external mode", async () => {
    const missing = await start({ IGNIS_PASSWORD_HASH: "" }, true);
    expect(missing.code).toBe(1);
    expect(missing.output).not.toContain("Server running");
    const invalid = await start({ IGNIS_PASSWORD_HASH: "do-not-log-this-value" }, true);
    expect(invalid.code).toBe(1);
    expect(invalid.output).not.toContain("do-not-log-this-value");
    // Remove the inherited password source rather than supplying an empty one.
    const { child, base } = await start({ IGNIS_AUTH_MODE: "external", IGNIS_PASSWORD_HASH: undefined });
    try {
      expect((await fetch(base + "/api/vault/list")).status).toBe(200);
      const session = await (await fetch(base + "/api/auth/session")).json();
      expect(session.mode).toBe("external");
      expect((await login(base)).response.status).toBe(404);
    } finally { await stop(child); }
  }, 15000);
});
