const net = require("node:net");

const SECRET_KEYS = [
  "IGNIS_PASSWORD_HASH",
  "IGNIS_PASSWORD_HASH_FILE",
  "IGNIS_PASSWORD_FILE",
];

function readAuthConfig(env = process.env) {
  const mode = env.IGNIS_AUTH_MODE ?? "password";
  if (!["password", "external"].includes(mode)) {
    throw new Error("IGNIS_AUTH_MODE must be password or external");
  }

  const sources = SECRET_KEYS.filter((key) => env[key] !== undefined);
  if (mode === "password" && sources.length !== 1) {
    throw new Error("Password authentication requires exactly one IGNIS_PASSWORD_HASH, IGNIS_PASSWORD_HASH_FILE, or IGNIS_PASSWORD_FILE");
  }
  if (sources.some((key) => !env[key]?.trim())) {
    throw new Error("Authentication credentials must not be empty");
  }
  if (mode === "external" && sources.length) {
    throw new Error("Remove password credentials when selecting external authentication");
  }

  let origin;
  try {
    const value = env.IGNIS_PUBLIC_ORIGIN ?? `http://localhost:${env.PORT || 8080}`;
    const parsed = new URL(value);
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      throw new Error();
    }
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
      throw new Error();
    }
    origin = parsed.origin;
  } catch {
    throw new Error("IGNIS_PUBLIC_ORIGIN must be an HTTPS origin (HTTP is allowed only for localhost or a loopback IP)");
  }

  const trustProxy = env.IGNIS_TRUST_PROXY?.split(",").map((s) => s.trim()) || [];
  for (const address of trustProxy) {
    const [ip, prefix, extra] = address.split("/");
    const family = net.isIP(ip);
    if (!family || extra !== undefined || (prefix !== undefined &&
      (!/^\d+$/.test(prefix) || Number(prefix) < 1 || Number(prefix) > (family === 4 ? 32 : 128)))) {
      throw new Error("IGNIS_TRUST_PROXY must contain explicit proxy IPs or CIDRs (not /0)");
    }
  }

  return {
    mode,
    origin,
    secure: origin.startsWith("https:"),
    trustProxy,
    secretKey: sources[0],
    secretValue: env[sources[0]],
  };
}

module.exports = { readAuthConfig };
