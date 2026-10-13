(() => {
  const form = document.getElementById("login-form");
  const status = document.getElementById("login-status");
  const password = document.getElementById("password");
  const button = form.querySelector("button");
  const params = new URLSearchParams(window.location.search);

  function signedIn() {
    if (params.get("reauth") === "1") {
      form.hidden = true;
      status.textContent = "Signed in. You can close this tab and return to your open editor. Retry any failed saves there.";
      return;
    }
    const value = params.get("returnTo") || "/";
    let target = "/";
    try {
      const url = new URL(value, window.location.origin);
      if (value.startsWith("/") && !value.startsWith("//") &&
          url.origin === window.location.origin && ["/", "/index.html"].includes(url.pathname)) {
        target = url.pathname + url.search + url.hash;
      }
    } catch { /* fall back to the application root */ }
    window.location.replace(target);
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    button.disabled = true;
    status.textContent = "Signing in…";
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: password.value }),
      });
      password.value = "";
      if (response.ok) return signedIn();
      status.textContent = response.status === 429
        ? "Too many attempts. Please wait before trying again."
        : "Sign-in failed. Check your password and try again.";
    } catch {
      status.textContent = "Unable to reach Ignis. Please try again.";
    } finally {
      button.disabled = false;
    }
  });

  fetch("/api/auth/session").then((response) => {
    if (response.ok) signedIn();
  }).catch(() => {});
})();
