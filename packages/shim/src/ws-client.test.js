import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createWsClient } from "./ws-client.js";

let sockets;

beforeEach(() => {
  sockets = [];

  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      sockets.push(this);
    }
    send() {}
    close() {}
  }

  FakeWebSocket.OPEN = 1;
  globalThis.WebSocket = FakeWebSocket;
  globalThis.window = { location: { protocol: "http:", host: "localhost" } };
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  delete globalThis.WebSocket;
  delete globalThis.window;
});

describe("ws-client onOpen", () => {
  it("fires on the first open and again on a re-open", () => {
    const client = createWsClient();
    const onOpen = vi.fn();
    client.onOpen(onOpen);

    client.connect("v1");
    sockets[0].onopen();
    expect(onOpen).toHaveBeenCalledTimes(1);

    sockets[0].onclose();
    vi.advanceTimersByTime(2000);
    sockets[1].onopen();

    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it("stops firing after unsubscribe", () => {
    const client = createWsClient();
    const onOpen = vi.fn();
    const off = client.onOpen(onOpen);

    client.connect("v1");
    sockets[0].onopen();
    off();

    sockets[0].onclose();
    vi.advanceTimersByTime(2000);
    sockets[1].onopen();

    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

describe("ws-client channels", () => {
  const SUBSCRIBE = JSON.stringify({
    type: "subscribe-channel",
    channel: "metadata",
  });

  function open(socket) {
    socket.readyState = 1;
    socket.send = vi.fn();
    socket.onopen();
  }

  it("subscribes on the first open and again on a re-open", () => {
    const client = createWsClient();
    client.channel("metadata").subscribe("revision", vi.fn());

    client.connect("v1");
    open(sockets[0]);

    expect(sockets[0].send).toHaveBeenCalledWith(SUBSCRIBE);

    sockets[0].onclose();
    vi.advanceTimersByTime(2000);
    open(sockets[1]);

    expect(sockets[1].send).toHaveBeenCalledWith(SUBSCRIBE);
  });

  it("routes a channel message to its subscriber", () => {
    const client = createWsClient();
    const handler = vi.fn();
    client.channel("metadata").subscribe("revision", handler);

    client.connect("v1");
    open(sockets[0]);
    sockets[0].onmessage({
      data: JSON.stringify({
        channel: "metadata",
        type: "revision",
        etag: '"a-1"',
      }),
    });

    expect(handler).toHaveBeenCalledWith({
      channel: "metadata",
      type: "revision",
      etag: '"a-1"',
    });
  });
});

describe("ws-client authentication", () => {
  it("pauses rejected upgrades until reauthentication and then reconnects", async () => {
    const events = new EventTarget();
    window.addEventListener = events.addEventListener.bind(events);
    window.removeEventListener = events.removeEventListener.bind(events);
    window.IgnisAuth = {
      required: false,
      requireLogin() { this.required = true; },
      checkSession: vi.fn(async () => false),
    };
    const client = createWsClient();
    client.connect("v1");
    sockets[0].onclose({ code: 4004 });
    await vi.advanceTimersByTimeAsync(10000);
    expect(window.IgnisAuth.checkSession).toHaveBeenCalled();
    expect(sockets).toHaveLength(1);
    window.IgnisAuth.required = false;
    events.dispatchEvent(new Event("ignis:auth-restored"));
    await vi.advanceTimersByTimeAsync(2000);
    expect(sockets).toHaveLength(2);
    client.disconnect();
    events.dispatchEvent(new Event("ignis:auth-restored"));
    await vi.advanceTimersByTimeAsync(2000);
    expect(sockets).toHaveLength(2);
  });
});
