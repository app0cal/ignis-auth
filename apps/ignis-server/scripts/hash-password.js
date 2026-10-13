#!/usr/bin/env node
const { hashPassword } = require("../server/auth/password");

async function readPassword() {
  if (!process.stdin.isTTY) {
    const chunks = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 1026) throw new Error("Password input is too long");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
  }
  process.stderr.write("Password (input hidden): ");
  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (error) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off("data", onData);
      process.stderr.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    function onData(data) {
      for (const char of data) {
        if (char === "\u0003" || char === "\u0004") return finish(new Error("Cancelled"));
        if (char === "\r" || char === "\n") return finish();
        if (char === "\u007f" || char === "\b") value = [...value].slice(0, -1).join("");
        else if (char >= " ") value += char;
        if (Buffer.byteLength(value) > 1024) return finish(new Error("Password input is too long"));
      }
    }
    process.stdin.on("data", onData);
  });
}

async function main() {
  if (process.argv.length !== 2) throw new Error("Use a hidden prompt or stdin; password arguments are not accepted");
  console.log(await hashPassword(await readPassword()));
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
