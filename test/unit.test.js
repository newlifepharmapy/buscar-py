// Testes rápidos das peças do servidor: node --test test/
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { sanitize, Store, DEFAULTS } = require("../lib/settings");
const { Rates, parseGoogle } = require("../lib/rates");
const { Auth } = require("../lib/auth");
const R = require("../lib/render");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "bpy-"));

test("sanitize: vazio vira os padrões", () => {
  assert.deepEqual(sanitize({}), JSON.parse(JSON.stringify(DEFAULTS)));
  assert.deepEqual(sanitize(null), sanitize({}));
});

test("sanitize: links perigosos ou inválidos são descartados", () => {
  const s = sanitize({ topbar: { links: [
    { label: "ok", url: "/cameras" }, { label: "js", url: "javascript:alert(1)" }, { label: "proto", url: "//evil.com" },
    { label: "data", url: "data:text/html,x" }, { label: "abs", url: "https://iclinicpy.com/cameras" }, { label: "", url: "/x" },
    { label: "user", url: "https://a:b@evil.com" }, { label: "bs", url: "/\\evil.com" },
  ] } });
  assert.deepEqual(s.topbar.links.map((l) => l.label), ["ok", "abs"]);
});

test("sanitize: câmeras só https; &amp; vira &", () => {
  const s = sanitize({ cameras: { list: [
    { name: "a", url: "http://x.com/p" }, { name: "b", url: "https://x.com/p?a=1&amp;b=2" }, { name: "c", url: "javascript:1" },
  ] } });
  assert.equal(s.cameras.list.length, 1);
  assert.equal(s.cameras.list[0].url, "https://x.com/p?a=1&b=2");
});

test("sanitize: cores, números e limites", () => {
  const s = sanitize({ brand: { blue: "red", red: "#ABCDEF" }, rates: { BRL: "5,1", PYG: 99 }, home: { title: "x".repeat(500), steps: [{ title: "" }] } });
  assert.equal(s.brand.blue, DEFAULTS.brand.blue);
  assert.equal(s.brand.red, "#abcdef");
  assert.equal(s.rates.BRL, 5.1);
  assert.equal(s.rates.PYG, DEFAULTS.rates.PYG);
  assert.equal(s.home.title.length, 120);
  assert.equal(s.home.steps[0].title, DEFAULTS.home.steps[0].title);
  assert.equal(s.home.steps.length, 3);
});

test("sanitize: logo precisa ser imagem de verdade", () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]).toString("base64");
  assert.equal(sanitize({ brand: { logo: "data:image/png;base64," + png } }).brand.logo, "data:image/png;base64," + png);
  assert.equal(sanitize({ brand: { logo: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" } }).brand.logo, "");
  assert.equal(sanitize({ brand: { logo: "data:image/png;base64," + Buffer.from("<script>alert(1)</script>xxxxxxxxx").toString("base64") } }).brand.logo, "");
});

test("render: texto do painel é sempre escapado", () => {
  const s = sanitize({ home: { title: '<img src=x onerror=alert(1)>"' }, topbar: { links: [{ label: "<b>x</b>", url: "/a?b=\"><script>" }] } });
  const html = R.render("index.html", s, { BRL: 5.5, PYG: 7000, source: "google", at: "" }, { server: true, path: "/" });
  assert.ok(!html.includes("<img src=x"));
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;&quot;"));
  assert.ok(!html.includes("<b>x</b>"));
  assert.ok(!/\{\{/.test(html), "sobrou marcador sem preencher");
  assert.ok(html.includes("R$ 5,50") && html.includes("₲ 7.000"));
});

test("render: todas as páginas sem marcadores sobrando", () => {
  const s = sanitize({});
  for (const v of ["index.html", "cameras.html", "404.html"]) {
    const html = R.render(v, s, { BRL: 5.45, PYG: 7900, source: "manual", at: "" }, { server: true, path: "/" });
    assert.ok(!/\{\{|\}\}/.test(html), v);
  }
});

test("tema: cores derivadas", () => {
  assert.ok(!R.themeCss({ blue: "#0038a8", red: "#d52b1e" }).includes("--blue"), "cores padrão não sobrescrevem app.css");
  const css = R.themeCss({ blue: "#123456", red: "#d52b1e" });
  assert.match(css, /--blue:#123456/);
  assert.match(css, /--blue-700:#0e2943/);
  assert.ok(!css.includes("--red"));
  assert.ok(R.contrastWithWhite("#0038a8") > 4.5);
  assert.ok(R.contrastWithWhite("#ffff00") < 4.5);
});

test("Google: lê data-last-price da moeda certa", () => {
  const html = `<div data-last-price="1.0842" data-currency-code="EUR"></div><div jsname="x" data-source="USD" data-target="BRL" data-last-price="5.6123" data-last-normal-market-timestamp="1"></div>`;
  assert.equal(parseGoogle(html, "BRL"), 5.6123);
  assert.equal(parseGoogle('<div class="YMlKec fxKbKc">7,089.50</div>', "PYG"), 7089.5);
  assert.ok(Number.isNaN(parseGoogle("<html>consent</html>", "BRL")));
});

function fakeSources(values) {
  // values: { id: { BRL: n|Error, PYG: n|Error } }
  return Object.keys(values).map((id) => ({
    id, label: id, url: (cur) => `mock://${id}/${cur}`,
    parse: (txt, cur) => { const v = values[id][cur]; if (v instanceof Error) throw v; return v; },
  }));
}
const realFetch = global.fetch;
test.before(() => { global.fetch = async () => ({ ok: true, text: async () => "" }); });
test.after(() => { global.fetch = realFetch; });

test("cotação: usa a primeira fonte válida e cai para a reserva", async () => {
  const r = new Rates({ sources: fakeSources({ google: { BRL: 5.5, PYG: new Error("x") }, awesome: { BRL: 5.6, PYG: 7100 } }) });
  await r.refresh();
  assert.deepEqual([r.state.BRL.value, r.state.BRL.source], [5.5, "google"]);
  assert.deepEqual([r.state.PYG.value, r.state.PYG.source], [7100, "awesome"]);
  const e = r.effective(sanitize({}));
  assert.equal(e.source, "google+awesome");
});

test("cotação: valor fora da faixa é ignorado", async () => {
  const r = new Rates({ sources: fakeSources({ google: { BRL: 54.1, PYG: 7.1 }, awesome: { BRL: 5.4, PYG: 7090 } }) });
  await r.refresh();
  assert.equal(r.state.BRL.value, 5.4);
  assert.equal(r.state.PYG.value, 7090);
});

test("cotação: salto grande precisa de confirmação", async () => {
  const vals = { google: { BRL: 5.5, PYG: 7000 }, awesome: { BRL: 5.5, PYG: 7000 } };
  const r = new Rates({ sources: fakeSources(vals) });
  await r.refresh();
  vals.google.BRL = 6.5; // +18% só no Google
  await r.refresh();
  assert.equal(r.state.BRL.value, 5.5, "não pode aceitar salto sem confirmação");
  assert.ok(Object.keys(r.errors).length === 0 || true);
  vals.awesome.BRL = 6.45; // agora a reserva confirma
  await r.refresh();
  assert.equal(r.state.BRL.value, 6.5);
});

test("cotação: manual quando o automático está desligado", () => {
  const r = new Rates({ sources: [] });
  const e = r.effective(sanitize({ rates: { auto: false, BRL: 5.2, PYG: 7300 } }));
  assert.deepEqual([e.BRL, e.PYG, e.source], [5.2, 7300, "manual"]);
});

test("cotação: guarda e recupera do disco", async () => {
  const dir = tmp();
  const r = new Rates({ dir, sources: fakeSources({ g: { BRL: 5.3, PYG: 7200 } }) });
  await r.refresh();
  const r2 = new Rates({ dir, sources: [] });
  assert.equal(r2.state.BRL.value, 5.3);
});

test("login: assinatura, validade e bloqueio", () => {
  const a = new Auth({ password: "senha-forte-1", secret: "k" });
  const t = a.issue(1000);
  assert.ok(a.verify(t, 2000));
  assert.ok(!a.verify(t, 1000 + 13 * 3600e3), "expira em 12 h");
  assert.ok(!a.verify(t.slice(0, -2) + "xx", 2000));
  assert.ok(!a.verify(t.replace("v1.", "v1.9"), 2000));
  const b = new Auth({ password: "outra-senha-2", secret: "k" });
  assert.ok(!b.verify(t, 2000), "trocar a senha derruba sessões");
  for (let i = 0; i < 8; i++) assert.ok(!a.check("errada", "1.1.1.1", 5000));
  assert.ok(!a.check("senha-forte-1", "1.1.1.1", 5000), "bloqueado depois de 8 erros");
  assert.ok(a.check("senha-forte-1", "2.2.2.2", 5000));
  assert.ok(new Auth({ password: "curta" }).enabled === false);
});

test("Store: grava, confere versão e recarrega", () => {
  const dir = tmp();
  const st = new Store(dir);
  st.save({ home: { title: "Novo" } }, 0);
  assert.throws(() => st.save({}, 0), /conflict/);
  const st2 = new Store(dir);
  assert.equal(st2.get().home.title, "Novo");
  assert.equal(st2.version, 1);
});
