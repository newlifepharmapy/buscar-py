// Endereço principal (CANONICAL_HOST): o outro endereço e o http redirecionam para ele.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const net = require("net");

const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

async function serve(canonical) {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bpy-can-"));
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dir, CANONICAL_HOST: canonical, RATES_INTERVAL_MS: "3600000", NODE_ENV: "production" },
    stdio: "ignore",
  });
  const get = (url, host, proto = "https") => new Promise((resolve, reject) => {
    http.get({ port, path: url, headers: { Host: host, "X-Forwarded-Proto": proto } }, (res) => {
      let body = ""; res.on("data", (d) => { body += d; }); res.on("end", () => resolve({ status: res.statusCode, location: res.headers.location, body }));
    }).on("error", reject);
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await get("/health", "healthcheck.railway.app")).status === 200) break; } catch (e) { /* subindo */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return { get, stop: () => new Promise((r) => { child.once("exit", r); child.kill("SIGTERM"); }) };
}

test("www.buscarpy.com como endereço principal", async () => {
  const s = await serve("www.buscarpy.com");
  try {
    assert.equal((await s.get("/health", "healthcheck.railway.app", "http")).status, 200, "o healthcheck do Railway não é redirecionado");
    const apex = await s.get("/cameras?x=1", "buscarpy.com");
    assert.equal(apex.status, 301);
    assert.equal(apex.location, "https://www.buscarpy.com/cameras?x=1");
    const plain = await s.get("/", "www.buscarpy.com", "http");
    assert.equal(plain.status, 301);
    assert.equal(plain.location, "https://www.buscarpy.com/");
    const page = await s.get("/cameras", "www.buscarpy.com");
    assert.equal(page.status, 200);
    assert.ok(page.body.includes('<link rel="canonical" href="https://www.buscarpy.com/cameras">'));
    const map = await s.get("/sitemap.xml", "www.buscarpy.com");
    assert.ok(map.body.includes("<loc>https://www.buscarpy.com/cameras</loc>"));
    assert.ok((await s.get("/robots.txt", "www.buscarpy.com")).body.includes("Sitemap: https://www.buscarpy.com/sitemap.xml"));
  } finally { await s.stop(); }
});

test("buscarpy.com como endereço principal", async () => {
  const s = await serve("buscarpy.com");
  try {
    const www = await s.get("/", "www.buscarpy.com");
    assert.equal(www.status, 301);
    assert.equal(www.location, "https://buscarpy.com/");
    const page = await s.get("/", "buscarpy.com");
    assert.ok(page.body.includes('<link rel="canonical" href="https://buscarpy.com/">'));
    assert.ok((await s.get("/sitemap.xml", "buscarpy.com")).body.includes("<loc>https://buscarpy.com/</loc>"));
  } finally { await s.stop(); }
});
