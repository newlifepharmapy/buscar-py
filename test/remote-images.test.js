// Fotos e logos importadas: só baixa o que está no catálogo, confere o tipo e guarda no disco.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { RemoteImages, mapFromCatalog, looksLike } = require("../lib/remote-images");

const SRC = "https://us-ord-10.linodeobjects.com/bucket-prod/site/media/fotos/modelos/x.big.avif";
const AVIF = Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from("ftypavif"), Buffer.alloc(20)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 "), Buffer.alloc(8)]);
const quiet = { log() {}, warn() {} };
const catalog = {
  products: [
    { image: "img/cp/1.avif", image_src: SRC },
    { image: "img/cp/2.avif", image_src: "http://us-ord-10.linodeobjects.com/a.avif" },        // sem https
    { image: "img/cp/3.avif", image_src: "https://evil.example.com/a.avif" },                 // outro servidor
    { image: "img/cp/../4.avif", image_src: SRC },                                            // caminho estranho
    { image: "img/B07Q7GG8BD.jpg" },                                                          // produto de exemplo
  ],
  stores: [{ id: "loja", logo: "img/lojas/loja.webp", logo_src: "https://bucket-prod.us-ord-10.linodeobjects.com/l.webp" }],
};
function fakeFetch(body, calls = []) {
  return async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200, headers: new Map([["content-length", String(body.length)]]), arrayBuffer: async () => body };
  };
}

test("imagens externas: só caminhos do catálogo, https e servidores conhecidos", () => {
  const m = mapFromCatalog(catalog);
  assert.deepEqual([...m.keys()].sort(), ["/img/cp/1.avif", "/img/lojas/loja.webp"]);
  assert.equal(m.get("/img/cp/1.avif"), SRC);
});

test("imagens externas: confere os primeiros bytes", () => {
  assert.ok(looksLike("image/avif", AVIF));
  assert.ok(looksLike("image/webp", WEBP));
  assert.ok(!looksLike("image/avif", WEBP));
  assert.ok(!looksLike("image/webp", Buffer.from("<html><body>erro</body></html>")));
});

test("imagens externas: baixa uma vez, guarda no disco e não segue redirecionamento", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bpy-img-"));
  const calls = [];
  const r = new RemoteImages({ catalog, dir, fetchImpl: fakeFetch(AVIF, calls), log: quiet });
  assert.ok(r.has("/img/cp/1.avif"));
  assert.ok(!r.has("/img/cp/3.avif"));
  const [a, b] = await Promise.all([r.get("/img/cp/1.avif"), r.get("/img/cp/1.avif")]);
  assert.equal(calls.length, 1, "dois pedidos juntos, um download só");
  assert.equal(calls[0].opts.redirect, "error");
  assert.equal(a.type, "image/avif");
  assert.equal(a, b);
  assert.deepEqual(fs.readFileSync(path.join(dir, "remote-img", "1.avif")), AVIF);
  // depois de reiniciar, vem do disco sem baixar de novo
  const calls2 = [];
  const r2 = new RemoteImages({ catalog, dir, fetchImpl: fakeFetch(AVIF, calls2), log: quiet });
  assert.deepEqual((await r2.get("/img/cp/1.avif")).body, AVIF);
  assert.equal(calls2.length, 0);
});

test("imagens externas: arquivo que não é imagem é recusado e só tenta de novo mais tarde", async () => {
  const calls = [];
  const r = new RemoteImages({ catalog, dir: null, fetchImpl: fakeFetch(Buffer.from("<html>bloqueado</html>"), calls), log: quiet });
  await assert.rejects(r.get("/img/lojas/loja.webp"));
  await assert.rejects(r.get("/img/lojas/loja.webp"));
  assert.equal(calls.length, 1);
  await assert.rejects(r.get("/img/cp/3.avif"), /fora da lista/);
});

test("imagens externas: erro do servidor de origem não derruba o aquecimento", async () => {
  const r = new RemoteImages({ catalog, dir: null, fetchImpl: async () => ({ ok: false, status: 403, headers: new Map() }), log: quiet });
  assert.deepEqual(await r.warm(), { ok: 0, bad: 2 });
});
