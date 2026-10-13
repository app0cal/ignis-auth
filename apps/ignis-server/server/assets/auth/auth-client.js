(() => {
  const nativeFetch = window.fetch.bind(window);
  let required = false;
  let checking = null;
  let mode = null;

  function ownApi(input) {
    try {
      const url = new URL(input instanceof Request ? input.url : input, window.location.href);
      return url.origin === window.location.origin && url.pathname.startsWith("/api/");
    } catch {
      return false;
    }
  }

  function showNotice() {
    if (!required || !document.body || document.getElementById("ignis-auth-notice")) return;
    const notice = document.createElement("div");
    notice.id = "ignis-auth-notice";
    notice.setAttribute("role", "alert");
    notice.textContent = "Your session ended. Changes cannot be saved until you sign in again. Keep this editor open; retry failed saves after signing in.";
    const link = document.createElement("a");
    link.href = "/login?reauth=1";
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "Sign in again";
    notice.append(link);
    document.body.append(notice);
  }

  function requireLogin() {
    if (required) return;
    required = true;
    window.dispatchEvent(new Event("ignis:auth-required"));
    // Synchronous XHR may report failure during initial bootstrap.
    queueMicrotask(showNotice);
  }

  async function checkSession() {
    if (checking) return checking;
    checking = (async () => {
      try {
        const response = await nativeFetch("/api/auth/session", { cache: "no-store" });
        if (response.status === 401) {
          requireLogin();
          return false;
        }
        if (!response.ok) return !required;
        const session = await response.json();
        mode = session.mode;
        if (required) {
          required = false;
          document.getElementById("ignis-auth-notice")?.remove();
          window.dispatchEvent(new Event("ignis:auth-restored"));
        }
        return true;
      } catch {
        // Network failures are not evidence that a session expired.
        return !required;
      }
    })();
    try { return await checking; }
    finally { checking = null; }
  }

  window.fetch = async (input, init) => {
    const response = await nativeFetch(input, init);
    if (ownApi(input) && response.status === 401 && response.headers.get("X-Ignis-Auth") === "required") {
      requireLogin();
    }
    return response;
  };

  const open = XMLHttpRequest.prototype.open;
  const send = XMLHttpRequest.prototype.send;
  const requests = new WeakMap();
  XMLHttpRequest.prototype.open = function (method, url, ...args) {
    const result = open.call(this, method, url, ...args);
    requests.set(this, ownApi(url));
    return result;
  };
  function inspect(xhr) {
    if (requests.get(xhr) && xhr.readyState === 4 && xhr.status === 401 &&
        xhr.getResponseHeader("X-Ignis-Auth") === "required") requireLogin();
  }
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("loadend", () => inspect(this), { once: true });
    const result = send.apply(this, args);
    inspect(this);
    return result;
  };

  window.IgnisAuth = {
    get required() { return required; },
    checkSession,
    requireLogin,
    async logout() {
      await checkSession();
      if (mode === "external") {
        window.alert("Sign out through your authentication proxy. Ignis does not manage that session.");
        return;
      }
      if (!window.confirm("Sign out of Ignis in this browser? Check that your changes are saved first. Other open tabs will also need to sign in again.")) return;
      try {
        const response = await nativeFetch("/api/auth/logout", { method: "POST" });
        if (!response.ok) throw new Error();
        requireLogin();
        // Keep the editor and any unsaved content in memory, just as on expiry.
      } catch {
        window.alert("Sign-out failed. Check your connection and try again.");
      }
    },
  };
  window.addEventListener("focus", checkSession);
  document.addEventListener("DOMContentLoaded", showNotice, { once: true });
  setInterval(checkSession, 15000);
  checkSession();
})();
