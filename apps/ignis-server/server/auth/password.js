const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const { promisify } = require("node:util");

const scrypt = promisify(crypto.scrypt);
const OPTIONS = { N: 131072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 };
const PREFIX = "ignis-scrypt-v1";
const MAX_PASSWORD_BYTES = 1024;

function validPassword(value) {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= MAX_PASSWORD_BYTES;
}

function parseHash(encoded) {
  const parts = typeof encoded === "string" ? encoded.split("$") : [];
  if (parts.length !== 3 || parts[0] !== PREFIX ||
      !/^[a-f0-9]{32}$/.test(parts[1]) || !/^[a-f0-9]{64}$/.test(parts[2])) {
    throw new Error("Invalid Ignis password hash; generate it with scripts/hash-password.js");
  }
  return { salt: Buffer.from(parts[1], "hex"), key: Buffer.from(parts[2], "hex") };
}

async function hashPassword(password) {
  if (!validPassword(password)) {
    throw new Error("Password must contain between 1 and 1024 UTF-8 bytes");
  }
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 32, OPTIONS);
  return `${PREFIX}$${salt.toString("hex")}$${key.toString("hex")}`;
}

async function verifyPassword(password, encoded) {
  if (!validPassword(password)) return false;
  const { salt, key } = parseHash(encoded);
  const candidate = await scrypt(password, salt, 32, OPTIONS);
  return crypto.timingSafeEqual(key, candidate);
}

async function loadPassword(config) {
  if (config.mode === "external") return null;
  let value = config.secretValue;
  if (config.secretKey.endsWith("_FILE")) {
    let file;
    try {
      file = await fs.open(value, "r");
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 4096) throw new Error();
      value = await file.readFile("utf8");
    } catch {
      throw new Error("Cannot read authentication secret (must be a file of at most 4096 bytes)");
    } finally {
      await file?.close();
    }
    // Accept the single terminal newline commonly added by secret-file tools.
    value = value.replace(/\r?\n$/, "");
  }
  if (config.secretKey === "IGNIS_PASSWORD_FILE") return hashPassword(value);
  parseHash(value);
  return value;
}

module.exports = { hashPassword, verifyPassword, loadPassword, parseHash, validPassword };
