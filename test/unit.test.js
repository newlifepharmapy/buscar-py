// Testes rápidos das peças do servidor: node --test test/
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { sanitize, Store, DEFAULTS, httpsUrl } = require("../lib/settings");
const { Rates, parseGoogle } = require("../lib/rates");
const { Auth, clientIp } = require("../lib/auth");
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

test("câmeras: só nome de servidor comum (nada de ; ou * no cabeçalho de segurança)", () => {
  assert.equal(httpsUrl("https://a;sandbox;b.example/"), null);
  assert.equal(httpsUrl("https://*.example.com/x"), null);
  assert.equal(httpsUrl("https://exemplo..com/x"), null);
  assert.equal(httpsUrl("https://cam-1.exemplo.com.br:8443/p?a=1"), "https://cam-1.exemplo.com.br:8443/p?a=1");
  assert.equal(httpsUrl("https://Cam.Exemplo.com/p"), "https://cam.exemplo.com/p");
});

test("câmeras: link normal do YouTube vira o player", () => {
  const embed = (id) => `https://www.youtube.com/embed/${id}?autoplay=1&mute=1&playsinline=1`;
  assert.equal(httpsUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10s"), embed("dQw4w9WgXcQ"));
  assert.equal(httpsUrl("https://m.youtube.com/watch?feature=share&amp;v=dQw4w9WgXcQ"), embed("dQw4w9WgXcQ"));
  assert.equal(httpsUrl("https://youtube.com/live/abc_DEF-123?si=x"), embed("abc_DEF-123"));
  assert.equal(httpsUrl("https://youtu.be/AAAAAAAAAAA?si=x"), embed("AAAAAAAAAAA"));
  // o player já pronto fica como está; código inválido não é convertido
  assert.equal(httpsUrl("https://www.youtube.com/embed/AAAAAAAAAAA?autoplay=1"), "https://www.youtube.com/embed/AAAAAAAAAAA?autoplay=1");
  assert.equal(httpsUrl("https://www.youtube.com/watch?v=curto"), "https://www.youtube.com/watch?v=curto");
  assert.equal(httpsUrl("http://www.youtube.com/watch?v=dQw4w9WgXcQ"), null);
  const s = sanitize({ cameras: { list: [{ name: "yt", url: "https://youtu.be/dQw4w9WgXcQ" }] } });
  assert.deepEqual(R.frameOrigins(s), ["https://www.youtube.com"]);
});

test("sanitize: cores, números e limites", () => {
  const s = sanitize({ brand: { primary: "red", accent: "#ABCDEF" }, rates: { BRL: "5,1", PYG: 99 }, home: { title: "x".repeat(500), steps: [{ title: "" }] } });
  assert.equal(s.brand.primary, DEFAULTS.brand.primary);
  assert.equal(s.brand.accent, "#abcdef");
  // as cores da identidade anterior (azul e vermelho) não valem mais: ficam as da identidade v3
  const old = sanitize({ brand: { blue: "#0038a8", red: "#d52b1e" } });
  assert.equal(old.brand.primary, "#0c1a2e");
  assert.equal(old.brand.accent, "#c9a961");
  assert.ok(!("blue" in old.brand) && !("red" in old.brand));
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

test("render: texto do painel dentro de parciais não é processado de novo", () => {
  const s = sanitize({
    topbar: { message: "Promo {{brand.blue}} até {{x}} fim", links: [{ label: "Ver {{seo.title}}", url: "/cameras" }] },
    brand: { name1: "Loja {{seo.title}}" },
  });
  const html = R.render("index.html", s, { BRL: 5.5, PYG: 7000, source: "manual", at: "" }, { server: true, path: "/" });
  assert.ok(html.includes('<span class="util-msg">Promo {{brand.blue}} até {{x}} fim</span>'));
  assert.ok(html.includes(">Ver {{seo.title}}</a>"));
  assert.ok(html.includes("<span>Loja {{seo.title}}</span>"));
  assert.ok(!html.includes("{{>"), "parcial sem incluir");
});

test("render: frame-src só com origens https comuns", () => {
  const s = { cameras: { list: [
    { url: "https://a;sandbox;b.example/" }, { url: "https://*.example.com/x" }, { url: "http://cam.example.com/" },
    { url: "https://cam.example.com:8443/p" }, { url: "https://cam.example.com:8443/q" }, { url: "nada" },
  ] } };
  assert.deepEqual(R.frameOrigins(s), ["https://cam.example.com:8443"]);
});

test("render: dica da cotação com o nome das fontes", () => {
  const title = (source) => R.context(sanitize({}), { BRL: 5.45, PYG: 7800, source, at: "" }).fx.title;
  assert.equal(title("google"), "Cotação comercial do dólar (fonte: Google), conferida a cada 5 minutos");
  assert.equal(title("google+awesomeapi"), "Cotação comercial do dólar (fonte: Google e AwesomeAPI), conferida a cada 5 minutos");
  assert.equal(title("er-api"), "Cotação comercial do dólar (fonte: ExchangeRate-API), conferida a cada 5 minutos");
  assert.equal(title("manual"), "Cotação de referência definida pela equipe do site");
});

test("render: todas as páginas sem marcadores sobrando", () => {
  const s = sanitize({});
  for (const v of ["index.html", "cameras.html", "404.html"]) {
    const html = R.render(v, s, { BRL: 5.45, PYG: 7900, source: "manual", at: "" }, { server: true, path: "/" });
    assert.ok(!/\{\{|\}\}/.test(html), v);
  }
});

test("tema: cores derivadas", () => {
  assert.ok(!R.themeCss(DEFAULTS.brand).includes("--"), "cores padrão não sobrescrevem app.css");
  const css = R.themeCss({ primary: "#123456", accent: DEFAULTS.brand.accent });
  assert.match(css, /--navy:#123456/);
  assert.match(css, /--navy-900:#0b1f34/);
  assert.ok(!css.includes("--gold"));
  const gold = R.themeCss({ primary: DEFAULTS.brand.primary, accent: "#e0b84c" });
  assert.match(gold, /--gold:#e0b84c/);
  assert.match(gold, /--gold-100:#f9f1db/);
  assert.ok(!gold.includes("--navy"));
  assert.ok(R.contrastWithWhite(DEFAULTS.brand.primary) > 4.5);
  assert.ok(R.contrastWithWhite("#ffff00") < 4.5);
  assert.ok(R.contrast(DEFAULTS.brand.primary, DEFAULTS.brand.accent) > 4.5, "ouro sobre azul-tinta é legível");
});

test("Google: lê data-last-price da moeda certa", () => {
  const html = `<div data-last-price="1.0842" data-currency-code="EUR"></div><div jsname="x" data-source="USD" data-target="BRL" data-last-price="5.6123" data-last-normal-market-timestamp="1"></div>`;
  assert.equal(parseGoogle(html, "BRL"), 5.6123);
  assert.equal(parseGoogle('<div class="YMlKec fxKbKc">7,089.50</div>', "PYG"), 7089.5);
  assert.ok(Number.isNaN(parseGoogle("<html>consent</html>", "BRL")));
});

test("Google: nunca usa a cotação de outro par da página", () => {
  // página de outro par (GBP-CNY): antes devolvia 9.188086, dentro da faixa do real
  assert.ok(Number.isNaN(parseGoogle('<div class="x" data-source="GBP" data-target="CNY" data-last-price="9.188086">', "BRL")));
  // par invertido antes do certo
  const inv = '<div data-source="BRL" data-target="USD" data-last-price="0.18"></div><div data-source="USD" data-target="BRL" data-last-price="5.45"></div>';
  assert.equal(parseGoogle(inv, "BRL"), 5.45);
  // mesma moeda, mas a partir do euro
  assert.ok(Number.isNaN(parseGoogle('<div data-source="EUR" data-target="BRL" data-last-price="6.1"></div>', "BRL")));
  // sem data-source: vale a marcação com data-target certo
  assert.equal(parseGoogle('<div data-target="PYG" data-last-price="7089.5"></div>', "PYG"), 7089.5);
  // há cotações na página, mas nenhuma nossa: não cai no número grande do topo
  assert.ok(Number.isNaN(parseGoogle('<div data-source="GBP" data-target="CNY" data-last-price="9.1"></div><div class="YMlKec fxKbKc">9.1</div>', "BRL")));
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
  assert.deepEqual([r.state.BRL.value, r.state.BRL.source], [5.5, "awesome"], "a reserva perto do valor anterior vale");
  vals.awesome.BRL = new Error("fora do ar");
  await r.refresh();
  assert.equal(r.state.BRL.value, 5.5, "não pode aceitar salto sem confirmação");
  assert.match(r.errors["BRL:salto"], /^Valor ignorado \(google: 6,5\): mudou mais de 10% em relação à última cotação \(5,5\)/);
  vals.awesome.BRL = 6.45; // agora a reserva confirma
  await r.refresh();
  assert.deepEqual([r.state.BRL.value, r.state.BRL.source], [6.5, "google"]);
  assert.equal(r.errors["BRL:salto"], undefined);
});

test("cotação: a primeira leitura precisa de uma segunda fonte que concorde", async () => {
  // o Google lê um valor errado logo na primeira vez: não pode grudar
  const vals = { google: { BRL: 6.31, PYG: 7810 }, awesome: { BRL: 5.45, PYG: 7800 }, er: { BRL: 5.46, PYG: 7805 } };
  const r = new Rates({ sources: fakeSources(vals) });
  for (let i = 0; i < 3; i++) await r.refresh();
  assert.deepEqual([r.state.BRL.value, r.state.BRL.source], [5.45, "awesome"], "vale a de maior prioridade do par que concorda");
  assert.deepEqual([r.state.PYG.value, r.state.PYG.source], [7810, "google"]);
  // fontes discordam e não há terceira: nada é aceito, com aviso legível
  const r2 = new Rates({ sources: fakeSources({ google: { BRL: 6.31, PYG: 7810 }, awesome: { BRL: 5.45, PYG: new Error("x") }, er: { BRL: new Error("x"), PYG: new Error("x") } }) });
  await r2.refresh();
  assert.equal(r2.state.BRL, null);
  assert.equal(r2.errors["BRL:salto"], "As fontes não concordam (google: 6,31; awesome: 5,45). Nenhum valor foi aceito; o site segue com o valor manual até duas fontes concordarem.");
  // sem valor anterior e só uma fonte respondendo: não há com o que conferir, vale
  assert.deepEqual([r2.state.PYG.value, r2.state.PYG.source], [7810, "google"]);
  assert.equal(r2.effective(sanitize({})).BRL, DEFAULTS.rates.BRL, "sem leitura aceita, o site usa o valor manual");
});

test("cotação: erro antigo de uma reserva some quando ela não é mais consultada", async () => {
  const vals = { google: { BRL: new Error("HTTP 429"), PYG: new Error("HTTP 429") }, awesome: { BRL: new Error("HTTP 500"), PYG: new Error("HTTP 500") }, er: { BRL: 5.45, PYG: 7800 } };
  const r = new Rates({ sources: fakeSources(vals) });
  await r.refresh();
  assert.deepEqual(Object.keys(r.errors).sort(), ["BRL:awesome", "BRL:google", "PYG:awesome", "PYG:google"]);
  vals.google = { BRL: 5.46, PYG: 7810 };
  await r.refresh();
  assert.deepEqual(r.errors, {});
  assert.equal(r.state.BRL.source, "google");
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
  assert.ok(!a.verify(t.replace("v2.", "v2.9"), 2000));
  const b = new Auth({ password: "outra-senha-2", secret: "k" });
  assert.ok(!b.verify(t, 2000), "trocar a senha derruba sessões");
  for (let i = 0; i < 8; i++) assert.ok(!a.check("errada", "1.1.1.1", 5000));
  assert.ok(!a.check("senha-forte-1", "1.1.1.1", 5000), "bloqueado depois de 8 erros");
  assert.ok(a.check("senha-forte-1", "2.2.2.2", 5000));
  assert.ok(new Auth({ password: "curta" }).enabled === false);
});

test("login: o limite somando todos os IPs só deixa mais lento, não tranca a senha certa", () => {
  const a = new Auth({ password: "senha-forte-1", secret: "k" });
  for (let i = 0; i < 40; i++) assert.ok(!a.check("errada", "10.1.0." + i, 5000));
  assert.ok(a.throttled(5000));
  assert.ok(!a.blocked("7.7.7.7", 5000));
  assert.ok(a.check("senha-forte-1", "7.7.7.7", 5000), "a senha certa entra mesmo durante o ataque");
  assert.ok(!a.throttled(5000 + 15 * 60e3), "passa depois de 15 minutos");
  // o bloqueio por IP continua
  for (let i = 0; i < 8; i++) a.check("errada", "6.6.6.6", 6000);
  assert.ok(a.blocked("6.6.6.6", 6000));
  assert.ok(!a.check("senha-forte-1", "6.6.6.6", 6000));
  assert.ok(a.globalFails.length <= 40, "a lista global não cresce sem limite");
});

test("login: CF-Connecting-IP só vale com TRUST_CLOUDFLARE=1", () => {
  const req = (headers) => ({ headers, socket: { remoteAddress: "3.3.3.3" } });
  const both = req({ "cf-connecting-ip": "1.1.1.1", "x-forwarded-for": "9.9.9.9, 2.2.2.2" });
  assert.equal(clientIp(both, false), "2.2.2.2", "sem a variável, vale o último IP do X-Forwarded-For");
  assert.equal(clientIp(both, true), "1.1.1.1");
  assert.equal(clientIp(req({ "cf-connecting-ip": "1.1.1.1" }), false), "3.3.3.3");
  assert.equal(clientIp(req({})), "3.3.3.3");
  const old = process.env.TRUST_CLOUDFLARE;
  try {
    delete process.env.TRUST_CLOUDFLARE;
    assert.equal(clientIp(both), "2.2.2.2");
    process.env.TRUST_CLOUDFLARE = "1";
    assert.equal(clientIp(both), "1.1.1.1");
  } finally { if (old === undefined) delete process.env.TRUST_CLOUDFLARE; else process.env.TRUST_CLOUDFLARE = old; }
});

test("login: Sair encerra todas as sessões, mesmo depois de reiniciar", () => {
  const dir = tmp();
  const a = new Auth({ password: "senha-forte-1", dir });
  const t1 = a.issue(1000), t2 = a.issue(2000);
  assert.ok(a.verify(t1, 3000) && a.verify(t2, 3000));
  a.revokeAll(3000);
  assert.ok(!a.verify(t1, 4000) && !a.verify(t2, 4000), "cookie copiado deixa de valer");
  const t3 = a.issue(3000); // login logo depois de sair, no mesmo milissegundo
  assert.ok(a.verify(t3, 4000));
  const b = new Auth({ password: "senha-forte-1", dir }); // reinício: chave e hora da saída vêm do disco
  assert.ok(!b.verify(t1, 4000));
  assert.ok(b.verify(t3, 4000));
  assert.ok(!new Auth({ password: "senha-forte-1", secret: "k" }).verify("v1.99999999999999.x.abc", 4000));
});

test("Store: campo inválido mantém o último valor salvo, não o padrão", () => {
  const st = new Store(tmp());
  st.save({ brand: { primary: "#114477" }, rates: { auto: false, BRL: 5.8, PYG: 7950 }, home: { title: "Meu título" } }, 0);
  const saved = st.get();
  st.save({ ...saved, brand: { ...saved.brand, primary: "#11447" }, rates: { auto: false, BRL: 560, PYG: "7.950" }, home: { ...saved.home, title: "" } }, 1);
  assert.equal(st.get().brand.primary, "#114477");
  assert.equal(st.get().rates.BRL, 5.8);
  assert.equal(st.get().rates.PYG, 7950);
  assert.equal(st.get().home.title, "Meu título", "campo obrigatório vazio fica com o último valor");
  // "Restaurar padrão": o painel manda os valores padrão de forma explícita
  st.save({ ...st.get(), brand: { ...DEFAULTS.brand } }, 2);
  assert.equal(st.get().brand.primary, DEFAULTS.brand.primary);
});

test("Store: avisa que o disco é temporário no Railway sem volume", () => {
  const keys = ["RAILWAY_ENVIRONMENT", "RAILWAY_ENVIRONMENT_ID", "RAILWAY_PROJECT_ID", "RAILWAY_SERVICE_ID", "RAILWAY_VOLUME_MOUNT_PATH"];
  const old = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    for (const k of keys) delete process.env[k];
    const dir = tmp();
    assert.equal(new Store(dir).persistent, true, "fora do Railway o disco é permanente");
    process.env.RAILWAY_ENVIRONMENT_ID = "abc";
    assert.equal(new Store(dir).persistent, false, "no Railway sem volume, some no próximo deploy");
    process.env.RAILWAY_VOLUME_MOUNT_PATH = dir;
    assert.equal(new Store(dir).persistent, true);
    assert.equal(new Store(path.join(dir, "sub")).persistent, true);
    process.env.RAILWAY_VOLUME_MOUNT_PATH = dir.slice(0, -1); // /tmp/bpy-abc -> /tmp/bpy-ab não é o mesmo lugar
    assert.equal(new Store(dir).persistent, false);
  } finally {
    for (const k of keys) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; }
  }
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

test("cotação: lê o preço de venda da Casa Matriz no quadro da Bonanza Cambios", () => {
  const { parseBonanza } = require("../lib/rates");
  const board = JSON.stringify({ sucursales: [
    { cod: 2, cotizaciones: [{ prefix: "usa", compra: 5650, venta: 5835 }], arbitrajes: [{ prefix: "dore", compra: 5.15, venta: 5.42 }] },
    { cod: 0, cotizaciones: [{ prefix: "brasil", compra: 1080, venta: 1150 }, { prefix: "usa", compra: 5720, venta: 5830 }],
      arbitrajes: [{ prefix: "doeu", venta: 1.17 }, { prefix: "dore", compra: 5.12, venta: 5.4 }] },
  ] });
  assert.equal(parseBonanza(board, "PYG"), 5830);
  assert.equal(parseBonanza(board, "BRL"), 5.4);
  assert.ok(Number.isNaN(parseBonanza(JSON.stringify({ sucursales: [] }), "BRL")));
});
