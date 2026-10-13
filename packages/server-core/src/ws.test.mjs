import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createRequire } from "module";
import http from "http";
import path from "path";
import fs from "fs";
import os from "os";
import { once } from "node:events";

const require = createRequire(import.meta.url);
const { setupWebSocket, heartbeatSweep } = require("./ws.js");
const { WebSocket } = require("ws");
const watcher = require("./watcher.js");
const { createSessions } = require("../../../apps/ignis-server/server/auth/sessions.js");

function fakeSocket(isAlive) {
  return { isAlive, ping: vi.fn(), terminate: vi.fn() };
}

describe("ws heartbeat sweep", () => {
  it("terminates a socket that has not ponged since the last sweep", () => {
    const dead = fakeSocket(false);

    heartbeatSweep([dead]);

    expect(dead.terminate).toHaveBeenCalledTimes(1);
    expect(dead.ping).not.toHaveBeenCalled();
  });

  it("pings a live socket and marks it pending until its next pong", () => {
    const alive = fakeSocket(true);

    heartbeatSweep([alive]);

    expect(alive.ping).toHaveBeenCalledTimes(1);
    expect(alive.terminate).not.toHaveBeenCalled();
    expect(alive.isAlive).toBe(false);
  });

  it("terminates the dead and pings the live in the same sweep", () => {
    const dead = fakeSocket(false);
    const alive = fakeSocket(true);

    heartbeatSweep(new Set([dead, alive]));

    expect(dead.terminate).toHaveBeenCalledTimes(1);
    expect(dead.ping).not.toHaveBeenCalled();
    expect(alive.ping).toHaveBeenCalledTimes(1);
    expect(alive.terminate).not.toHaveBeenCalled();
    expect(alive.isAlive).toBe(false);
  });
});

describe("closeVaultSockets", () => {
  let server;
  let wss;
  let base;
  let tmpDir;

  function connect(vaultId) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${base}/ws?vault=${vaultId}`);

      ws.on("open", () => resolve(ws));
      ws.on("error", reject);
    });
  }

  function closeCode(ws) {
    return new Promise((resolve) => ws.on("close", (code) => resolve(code)));
  }

  beforeAll(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ws-test-"));

    for (const name of ["vault-a", "vault-b"]) {
      await fs.promises.mkdir(path.join(tmpDir, name));
    }

    server = http.createServer();
    wss = setupWebSocket(server, {
      getVaultPath: (vaultId) => {
        const vaultPath = path.join(tmpDir, vaultId);

        return fs.existsSync(vaultPath) ? vaultPath : null;
      },
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `ws://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    await watcher._reset();
    wss.close();
    await new Promise((resolve) => server.close(resolve));
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it("closes every client of the vault and leaves other vaults connected", async () => {
    const a1 = await connect("vault-a");
    const a2 = await connect("vault-a");
    const b1 = await connect("vault-b");

    const closed = Promise.all([closeCode(a1), closeCode(a2)]);

    wss.closeVaultSockets("vault-a");

    expect(await closed).toEqual([4002, 4002]);
    expect(b1.readyState).toBe(WebSocket.OPEN);

    const bClosed = closeCode(b1);
    b1.close();
    await bClosed;
  });

  it("does nothing for a vault with no clients", () => {
    expect(() => wss.closeVaultSockets("vault-never-connected")).not.toThrow();
  });

  it("survives a client sending an invalid frame", async () => {
    const bad = await connect("vault-a");
    const badClosed = closeCode(bad);

    bad._socket.write(Buffer.from([0xff, 0xff, 0xff, 0xff]));
    await badClosed;

    const fresh = await connect("vault-a");

    expect(fresh.readyState).toBe(WebSocket.OPEN);

    const freshClosed = closeCode(fresh);
    fresh.close();
    await freshClosed;
  });
});

describe("live connection authorization", () => {
  it("blocks direct sends and incoming messages after expiry, even before the expiry timer runs", async () => {
    let now = 0;
    const sessions = createSessions({ now: () => now, lifetime: 10000 });
    const { token, session } = sessions.create();
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ws-auth-test-"));
    const server = http.createServer();
    const wss = setupWebSocket(server, {
      getVaultPath: () => tmpDir,
      authorizeUpgrade: (req) => sessions.get(req.headers.authorization),
      isConnectionAuthorized: sessions.active,
      onAuthorizedConnection: (socket, context) => sessions.bind(socket, context),
    });
    const handler = vi.fn();
    wss.messageHandlers.set("mutate", handler);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `ws://127.0.0.1:${server.address().port}/ws?vault=v`;
    try {
      const connected = once(wss, "connection");
      const client = new WebSocket(base, { headers: { Authorization: token } });
      const [peer] = await connected;
      await once(client, "open");
      const received = vi.fn();
      client.on("message", received);
      const closed = once(client, "close");
      now = session.expiresAt;
      peer.send("must not be delivered");
      expect((await closed)[0]).toBe(4004);
      expect(received).not.toHaveBeenCalled();

      const fresh = sessions.create();
      const connection = once(wss, "connection");
      const next = new WebSocket(base, { headers: { Authorization: fresh.token } });
      await connection;
      await once(next, "open");
      const nextClosed = once(next, "close");
      now = fresh.session.expiresAt;
      next.send(JSON.stringify({ type: "mutate" }));
      expect((await nextClosed)[0]).toBe(4004);
      expect(handler).not.toHaveBeenCalled();
    } finally {
      sessions.close();
      for (const client of wss.clients) client.terminate();
      wss.close();
      await new Promise((resolve) => server.close(resolve));
      await watcher._reset();
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
