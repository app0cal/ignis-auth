import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import vm from "node:vm";

const clientSource = fs.readFileSync(new URL("../assets/auth/auth-client.js", import.meta.url), "utf8");
const loginSource = fs.readFileSync(new URL("../assets/auth/login.js", import.meta.url), "utf8");

function browser(source = clientSource, search = "") {
  const elements = new Map();
  class Element extends EventTarget {
    constructor() { super(); this.children = []; }
    setAttribute() {}
    append(element) { this.children.push(element); if (element.id) elements.set(element.id, element); }
    remove() { elements.delete(this.id); }
  }
  const document = new EventTarget();
  document.body = new Element();
  document.createElement = () => new Element();
  document.getElementById = (id) => elements.get(id);
  const form = new Element();
  const button = new Element();
  form.querySelector = () => button;
  for (const id of ["login-status", "password"]) elements.set(id, new Element());
  elements.set("login-form", form);
  const window = new EventTarget();
  window.location = { origin: "https://ignis.test", href: "https://ignis.test/", search, replace: vi.fn() };
  window.confirm = vi.fn(() => true);
  window.alert = vi.fn();
  let authenticated = true;
  let apiResponse = () => new Response("payload");
  const nativeFetch = vi.fn(async (input) => {
    if (input === "/api/auth/session") {
      return new Response(JSON.stringify({ mode: "password", authenticated }), { status: authenticated ? 200 : 401 });
    }
    return apiResponse(input);
  });
  window.fetch = nativeFetch;
  class XHR extends EventTarget {
    open(method, url, async = true) { this.method = method; this.url = url; this.async = async; }
    send() {
      this.readyState = 4;
      this.status = 401;
      this.responseText = "original response";
      this.dispatchEvent(new Event("loadend"));
    }
    getResponseHeader() { return "required"; }
  }
  const intervals = [];
  const context = { window, document, fetch: nativeFetch, XMLHttpRequest: XHR, URL, URLSearchParams, Request, Response,
    Event, queueMicrotask, setInterval: (fn) => intervals.push(fn) };
  vm.runInNewContext(source, context);
  return { window, document, elements, XHR, nativeFetch, intervals,
    setAuthenticated: (value) => { authenticated = value; },
    setResponse: (fn) => { apiResponse = fn; } };
}

const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

describe("browser authentication recovery", () => {
  it("observes marked own-origin 401s without consuming bodies, replaying requests, or navigating", async () => {
    const b = browser();
    await settle();
    const request = new Request("https://ignis.test/api/fs/writeFile", { method: "POST", body: "edit" });
    const response = new Response("original error body", { status: 401, headers: { "X-Ignis-Auth": "required" } });
    b.setResponse(() => response);
    const before = b.nativeFetch.mock.calls.length;
    const returned = await b.window.fetch(request);
    await settle();
    expect(returned).toBe(response);
    expect(await returned.text()).toBe("original error body");
    expect(b.nativeFetch.mock.calls.length).toBe(before + 1);
    expect(b.window.IgnisAuth.required).toBe(true);
    expect(b.elements.get("ignis-auth-notice").children[0].target).toBe("_blank");
    expect(b.window.location.replace).not.toHaveBeenCalled();
    await b.window.IgnisAuth.checkSession();
    expect(b.window.IgnisAuth.required).toBe(false);
    expect(b.elements.has("ignis-auth-notice")).toBe(false);
  });

  it("ignores upstream 401s and foreign responses, even with matching marker headers", async () => {
    const b = browser();
    await settle();
    b.setResponse(() => new Response("upstream denied", { status: 401 }));
    await b.window.fetch("/api/proxy");
    expect(b.window.IgnisAuth.required).toBe(false);
    b.setResponse(() => new Response("foreign denied", { status: 401, headers: { "X-Ignis-Auth": "required" } }));
    await b.window.fetch("https://foreign.test/api/resource");
    expect(b.window.IgnisAuth.required).toBe(false);
  });

  it("handles synchronous and asynchronous XHR without changing response semantics", async () => {
    for (const async of [false, true]) {
      const b = browser();
      await settle();
      const xhr = new b.XHR();
      xhr.open("GET", "/api/fs/readFile", async);
      xhr.send();
      await settle();
      expect(xhr.async).toBe(async);
      expect(xhr.responseText).toBe("original response");
      expect(b.window.IgnisAuth.required).toBe(true);
      expect(b.elements.has("ignis-auth-notice")).toBe(true);
      expect(b.window.location.replace).not.toHaveBeenCalled();
    }
  });

  it("polls for expiry and restores the existing page after reauthentication", async () => {
    const b = browser();
    await settle();
    const restored = vi.fn();
    b.window.addEventListener("ignis:auth-restored", restored);
    b.setAuthenticated(false);
    await b.intervals[0]();
    expect(b.window.IgnisAuth.required).toBe(true);
    b.setAuthenticated(true);
    await b.intervals[0]();
    expect(restored).toHaveBeenCalledTimes(1);
    expect(b.window.location.replace).not.toHaveBeenCalled();
  });
});

describe("login return targets", () => {
  it("retains local vault deep links and rejects external or non-app destinations", async () => {
    for (const [value, target] of [["/?vault=v&file=note.md", "/?vault=v&file=note.md"],
      ["//evil.test", "/"], ["/\\evil.test", "/"], ["https://evil.test", "/"],
      ["/api/fs/readFile", "/"], ["/login", "/"]]) {
      const b = browser(loginSource, `?returnTo=${encodeURIComponent(value)}`);
      await settle();
      expect(b.window.location.replace).toHaveBeenCalledWith(target);
    }
  });

  it("leaves the reauthentication tab on a success message", async () => {
    const b = browser(loginSource, "?reauth=1");
    await settle();
    expect(b.elements.get("login-form").hidden).toBe(true);
    expect(b.elements.get("login-status").textContent).toContain("return to your open editor");
    expect(b.window.location.replace).not.toHaveBeenCalled();
  });
});
