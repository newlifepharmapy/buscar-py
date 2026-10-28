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
  // as 3 câmeras do iClinic juntas na página, cada uma com nome e crédito, e o link do topo na mesma janela
  const camsHtml = await cams.text();
  assert.equal((camsHtml.match(/class="cam-card"/g) || []).length, 3);
  assert.ok(camsHtml.includes('class="cam-grid cols-3"'));
  for (const [i, name] of ["Ponte da Amizade - Sentido Paraguai", "Aduana Brasileira", "Ponte da Amizade - Sentido Brasil"].entries()) {
    assert.ok(camsHtml.includes(`id="cam${i + 1}"`) && camsHtml.includes(`<span>${name}</span></h2>`), name);
  }
  assert.equal((camsHtml.match(/<span class="cam-credit">Fonte: Portal da Cidade<\/span>/g) || []).length, 3);
  assert.doesNotMatch(camsHtml, /<iframe/, "o player só é criado pelo script, quando a câmera aparece na tela");
  assert.match(html, /<a class="util-link is-live" href="\/cameras">/, "sem target: abre na mesma janela");
  // menu lateral do celular em todas as páginas: botão ☰ ligado ao painel, e o script dele
  const notFound = await (await fetch(base + "/nada")).text();
  for (const [name, page] of [["início", html], ["câmeras", camsHtml], ["404", notFound]]) {
    assert.match(page, /<button type="button" class="menu-btn" id="menuBtn" aria-haspopup="dialog" aria-controls="menu" aria-expanded="false"/, name);
    assert.match(page, /<dialog class="drawer" id="menu" aria-labelledby="menuTitle">/, name);
    assert.match(page, /href="\/\?cat=mochilas" data-cat="mochilas"/, name);
    assert.match(page, /<script src="\/?js\/menu\.js"><\/script>/, name);
  }
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
  assert.deepEqual((await s.json()).storage, { writable: true, persistent: true, volume: false });
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
  s.brand.primary = "#123456";
  s.topbar.links.push({ label: "iClinic", url: "https://iclinicpy.com/cameras", live: false, newTab: true });
  s.cameras.list = s.cameras.list.slice(0, 1);
  const r = await authed("PUT", "/api/admin/settings", { settings: s, version: cur.version }, { Origin: base });
  assert.equal(r.status, 200);
  const saved = await r.json();
  assert.equal(saved.version, cur.version + 1);
  const html = await (await fetch(base + "/")).text();
  assert.ok(html.includes("Título &lt;novo&gt; &amp; &quot;teste&quot;"));
  assert.ok(html.includes('href="https://iclinicpy.com/cameras" target="_blank" rel="noopener"'));
  assert.match(await (await fetch(base + "/theme.css")).text(), /--navy:#123456/);
  const stale = await authed("PUT", "/api/admin/settings", { settings: s, version: cur.version });
  assert.equal(stale.status, 409);
  const conflict = await stale.json();
  assert.equal(conflict.error, "O painel foi salvo em outra aba ou aparelho enquanto você editava.");
  assert.equal(conflict.version, saved.version, "o 409 traz a versão atual para o painel");
  const cams = await (await fetch(base + "/cameras")).text();
  assert.equal((cams.match(/class="cam-card"/g) || []).length, 1);
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

test("corpo JSON que não é um objeto dá 400, não erro interno", async () => {
  for (const body of [null, [], 5, "texto"]) {
    const r = await jsonReq("POST", "/api/admin/login", body, { "X-Forwarded-For": "5.5.5.5" });
    assert.equal(r.status, 400, "login " + JSON.stringify(body));
    assert.equal((await r.json()).error, "JSON inválido");
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  }
  const before = await (await authed("GET", "/api/admin/settings")).json();
  for (const body of [null, [], { settings: null }, { settings: [] }]) {
    const r = await authed("PUT", "/api/admin/settings", body);
    assert.equal(r.status, 400, "salvar " + JSON.stringify(body));
  }
  const after = await (await authed("GET", "/api/admin/settings")).json();
  assert.equal(after.version, before.version, "nada foi gravado");
  assert.deepEqual(after.settings, before.settings);
});

test("câmeras: link do YouTube vira player; endereço com símbolos é recusado", async () => {
  const cur = await (await authed("GET", "/api/admin/settings")).json();
  const keep = cur.settings.cameras.list[0];
  cur.settings.cameras.list = [keep,
    { name: "Ponte no YouTube", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=5s" },
    { name: "sandbox", url: "https://a;sandbox;b.example/" }, { name: "curinga", url: "https://*.example.com/x" }];
  const r = await authed("PUT", "/api/admin/settings", { settings: cur.settings, version: cur.version });
  assert.equal(r.status, 200);
  const list = (await r.json()).settings.cameras.list;
  assert.deepEqual(list.map((c) => c.url), [keep.url, "https://www.youtube.com/embed/dQw4w9WgXcQ?autoplay=1&mute=1&playsinline=1"]);
  const cams = await fetch(base + "/cameras");
  const frameSrc = cams.headers.get("content-security-policy").split("; ").find((d) => d.startsWith("frame-src"));
  assert.equal(frameSrc, "frame-src https://playerv.logicahost.com.br https://www.youtube.com");
});

test("campo inválido mantém o último valor salvo", async () => {
  let cur = await (await authed("GET", "/api/admin/settings")).json();
  const primary = cur.settings.brand.primary;
  assert.notEqual(primary, "#0c1a2e");
  cur.settings.brand.primary = "#12345"; // faltou um dígito
  cur.settings.rates = { auto: false, BRL: 560, PYG: 7.95 }; // "5,60" e "7.950" lidos do jeito errado
  const r = await authed("PUT", "/api/admin/settings", { settings: cur.settings, version: cur.version });
  cur = await r.json();
  assert.equal(cur.settings.brand.primary, primary);
  assert.deepEqual(cur.settings.rates, { auto: false, BRL: 5.35, PYG: 5800 });
  assert.match(await (await fetch(base + "/theme.css")).text(), new RegExp("--navy:" + primary));
  cur.settings.rates.auto = true;
  assert.equal((await authed("PUT", "/api/admin/settings", { settings: cur.settings, version: cur.version })).status, 200);
});

test("configurações sobrevivem a um reinício", async () => {
  await stop();
  await start();
  const html = await (await fetch(base + "/")).text();
  assert.ok(html.includes("Título &lt;novo&gt;"));
  // a sessão continua valendo (chave guardada no disco)
  assert.equal((await authed("GET", "/api/admin/settings")).status, 200);
});

test("Sair encerra a sessão, inclusive num cookie copiado", async () => {
  await login();
  const copied = cookie;
  await login(); // outra sessão, em outro aparelho
  const other = cookie;
  // sem sessão válida, "Sair" só apaga o cookie (ninguém de fora derruba o admin)
  assert.equal((await jsonReq("POST", "/api/admin/logout", {})).status, 200);
  assert.equal((await jsonReq("GET", "/api/admin/settings", undefined, { Cookie: copied })).status, 200);
  const out = await jsonReq("POST", "/api/admin/logout", {}, { Cookie: copied });
  assert.equal(out.status, 200);
  assert.match(out.headers.get("set-cookie"), /Max-Age=0/);
  for (const c of [copied, other]) {
    assert.equal((await jsonReq("GET", "/api/admin/settings", undefined, { Cookie: c })).status, 401);
    assert.deepEqual(await (await jsonReq("GET", "/api/admin/session", undefined, { Cookie: c })).json(), { enabled: true, loggedIn: false });
  }
  await stop();
  await start();
  assert.equal((await jsonReq("GET", "/api/admin/settings", undefined, { Cookie: copied })).status, 401, "continua encerrada depois de reiniciar");
  await login();
  assert.equal((await authed("GET", "/api/admin/settings")).status, 200, "entrar de novo funciona");
});

test("bloqueio depois de muitas senhas erradas", async () => {
  let last;
  for (let i = 0; i < 9; i++) last = await jsonReq("POST", "/api/admin/login", { password: "x" + i }, { "X-Forwarded-For": "9.9.9.9" });
  assert.equal(last.status, 429);
  assert.equal((await last.json()).error, "Muitas senhas erradas deste aparelho. Espere 15 minutos e tente de novo.");
  const other = await jsonReq("POST", "/api/admin/login", { password: PASS }, { "X-Forwarded-For": "8.8.8.8" });
  assert.equal(other.status, 200);
});

test("CF-Connecting-IP inventado não escapa do limite por IP", async () => {
  const codes = [];
  for (let i = 0; i < 10; i++) {
    const r = await jsonReq("POST", "/api/admin/login", { password: "x" + i }, { "X-Forwarded-For": "7.7.7.7", "CF-Connecting-IP": "10.0.0." + i });
    codes.push(r.status);
  }
  assert.deepEqual(codes, [401, 401, 401, 401, 401, 401, 401, 401, 429, 429]);
});

// Por último: depois dele, toda resposta do login demora uns 2 s.
test("muitas senhas erradas de vários IPs deixam o login lento, mas a senha certa entra", async () => {
  const codes = await Promise.all(Array.from({ length: 40 }, (_, i) =>
    jsonReq("POST", "/api/admin/login", { password: "x" }, { "X-Forwarded-For": "10.1.0." + (i + 1) }).then((r) => r.status)));
  assert.ok(codes.every((c) => c === 401), codes.join(","));
  let t = Date.now();
  const ok = await jsonReq("POST", "/api/admin/login", { password: PASS }, { "X-Forwarded-For": "198.51.100.7" });
  assert.equal(ok.status, 200);
  assert.ok(Date.now() - t >= 1900, "resposta mais lenta durante o ataque");
  t = Date.now();
  const wrong = await jsonReq("POST", "/api/admin/login", { password: "errada" }, { "X-Forwarded-For": "198.51.100.8" });
  assert.equal(wrong.status, 401, "um IP novo não é bloqueado pelos erros dos outros");
});
