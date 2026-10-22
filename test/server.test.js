// Testes do servidor de verdade (sobe numa porta livre com uma pasta de dados temporária).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");

const PASS = "senha-de-teste-123";
let port, dir, child, base;

function freePort() {
  return new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
}
async function start() {
  child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dir, ADMIN_PASSWORD: PASS, RATES_INTERVAL_MS: "3600000", NODE_ENV: "production" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(base + "/health"); if (r.ok) return; } catch (e) { /* subindo */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("servidor não subiu");
}
const stop = () => new Promise((r) => { child.once("exit", r); child.kill("SIGTERM"); });
const jsonReq = (method, url, body, headers = {}) => fetch(base + url, {
  method, headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
});

test.before(async () => {
  port = await freePort(); base = `http://127.0.0.1:${port}`;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bpy-srv-"));
  await start();
});
test.after(async () => { await stop(); });

let cookie = "";
async function login() {
  const r = await jsonReq("POST", "/api/admin/login", { password: PASS });
  assert.equal(r.status, 200);
  cookie = r.headers.get("set-cookie").split(";")[0];
  return r;
}
const authed = (method, url, body, h = {}) => jsonReq(method, url, body, { Cookie: cookie, ...h });

test("páginas públicas", async () => {
  const r = await fetch(base + "/");
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.ok(html.includes("<title>Buscar PY"));
  assert.ok(html.includes('href="/cameras"'));
  const r2 = await fetch(base + "/", { headers: { "If-None-Match": r.headers.get("etag") } });
  assert.equal(r2.status, 304);
  const head = await fetch(base + "/", { method: "HEAD" });
  assert.equal(head.status, 200);
  const cams = await fetch(base + "/cameras");
  assert.equal(cams.status, 200);
  assert.match(cams.headers.get("content-security-policy"), /frame-src https:\/\/playerv\.logicahost\.com\.br/);
  assert.doesNotMatch(cams.headers.get("content-security-policy"), /unsafe-eval/);
  assert.match(r.headers.get("content-security-policy"), /frame-src 'none'/);
  const rates = await (await fetch(base + "/api/rates")).json();
  assert.ok(rates.BRL > 1 && rates.PYG > 1000);
});

test("caminhos fora de public/ não vazam", async () => {
  for (const p of ["/../server.js", "/%2e%2e/server.js", "/..%2fserver.js", "/admin/../../lib/auth.js", "/%00"]) {
    const r = await fetch(base + p);
    assert.ok(r.status === 404 || r.status === 400, p + " -> " + r.status);
    const t = await r.text();
    assert.ok(!t.includes("ADMIN_PASSWORD") && !t.includes("createHmac"), p);
  }
});

test("painel exige login", async () => {
  assert.equal((await fetch(base + "/api/admin/settings")).status, 401);
  assert.equal((await jsonReq("PUT", "/api/admin/settings", { settings: {} })).status, 401);
  const wrong = await jsonReq("POST", "/api/admin/login", { password: "errada" });
  assert.equal(wrong.status, 401);
  const r = await login();
  const sc = r.headers.get("set-cookie");
  assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Strict/);
  const s = await authed("GET", "/api/admin/settings");
  assert.equal(s.status, 200);
  assert.equal(s.headers.get("cache-control"), "no-store");
  const adm = await fetch(base + "/admin/");
  assert.match(adm.headers.get("x-robots-tag"), /noindex/);
  assert.match(adm.headers.get("content-security-policy"), /frame-ancestors 'none'/);
});

test("proteção contra pedidos de outro site", async () => {
  assert.equal((await fetch(base + "/api/admin/settings", { method: "PUT", headers: { Cookie: cookie, "Content-Type": "text/plain" }, body: "{}" })).status, 415);
  assert.equal((await authed("PUT", "/api/admin/settings", { settings: {} }, { Origin: "https://evil.example" })).status, 403);
  assert.equal((await authed("DELETE", "/api/admin/settings")).status, 405);
});

test("salvar publica no site, com controle de versão", async () => {
  const cur = await (await authed("GET", "/api/admin/settings")).json();
  const s = cur.settings;
  s.home.title = 'Título <novo> & "teste"';
  s.brand.blue = "#123456";
  s.topbar.links.push({ label: "iClinic", url: "https://iclinicpy.com/cameras", live: false, newTab: true });
  s.cameras.list = s.cameras.list.slice(0, 1);
  const r = await authed("PUT", "/api/admin/settings", { settings: s, version: cur.version }, { Origin: base });
  assert.equal(r.status, 200);
  const saved = await r.json();
  assert.equal(saved.version, cur.version + 1);
  const html = await (await fetch(base + "/")).text();
  assert.ok(html.includes("Título &lt;novo&gt; &amp; &quot;teste&quot;"));
  assert.ok(html.includes('href="https://iclinicpy.com/cameras" target="_blank" rel="noopener"'));
  assert.match(await (await fetch(base + "/theme.css")).text(), /--blue:#123456/);
  const stale = await authed("PUT", "/api/admin/settings", { settings: s, version: cur.version });
  assert.equal(stale.status, 409);
  const cams = await (await fetch(base + "/cameras")).text();
  assert.equal((cams.match(/class="cam-tab"/g) || []).length, 1);
});

test("logo enviado vira /brand-logo", async () => {
  const cur = await (await authed("GET", "/api/admin/settings")).json();
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
  cur.settings.brand.logo = "data:image/png;base64," + png.toString("base64");
  const r = await authed("PUT", "/api/admin/settings", { settings: cur.settings, version: cur.version });
  assert.equal(r.status, 200);
  const html = await (await fetch(base + "/")).text();
  assert.match(html, /<img class="logo-img" src="\/brand-logo\?v=[0-9a-f]+"/);
  const img = await fetch(base + "/brand-logo");
  assert.equal(img.headers.get("content-type"), "image/png");
  assert.equal(Buffer.from(await img.arrayBuffer()).length, png.length);
});

test("corpo grande demais é recusado", async () => {
  const r = await authed("PUT", "/api/admin/settings", { settings: { x: "a".repeat(1300 * 1024) }, version: 0 });
  assert.equal(r.status, 413);
});

test("configurações sobrevivem a um reinício", async () => {
  await stop();
  await start();
  const html = await (await fetch(base + "/")).text();
  assert.ok(html.includes("Título &lt;novo&gt;"));
  // a sessão continua valendo (chave guardada no disco)
  assert.equal((await authed("GET", "/api/admin/settings")).status, 200);
});

test("bloqueio depois de muitas senhas erradas", async () => {
  let last;
  for (let i = 0; i < 9; i++) last = await jsonReq("POST", "/api/admin/login", { password: "x" + i }, { "X-Forwarded-For": "9.9.9.9" });
  assert.equal(last.status, 429);
  const other = await jsonReq("POST", "/api/admin/login", { password: PASS }, { "X-Forwarded-For": "8.8.8.8" });
  assert.equal(other.status, 200);
});
