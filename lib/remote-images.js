// Fotos de produtos e logos de lojas que vêm de fora (o catálogo importado do Compras Paraguai).
// O site serve cada uma pelo próprio endereço (/img/cp/... e /img/lojas/...): o servidor baixa o arquivo
// uma vez, guarda no volume e depois responde do disco. Assim a página continua só com imagens do
// próprio site (a política de segurança não muda) e a busca por foto consegue ler os pixels.
// Só os arquivos listados no catálogo podem ser baixados, e só dos servidores de imagens conhecidos:
// o endereço nunca vem da requisição.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const HOSTS = new Set(["us-ord-10.linodeobjects.com", "bucket-prod.us-ord-10.linodeobjects.com"]);
const TYPES = { ".avif": "image/avif", ".webp": "image/webp", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png" };
const MAX_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 15000;
const RETRY_MS = 10 * 60 * 1000; // depois de uma falha, só tenta de novo 10 minutos depois

// Confere os primeiros bytes: o arquivo precisa ser mesmo uma imagem do tipo que o nome diz.
function looksLike(type, b) {
  if (b.length < 12) return false;
  if (type === "image/jpeg") return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (type === "image/png") return b.readUInt32BE(0) === 0x89504e47;
  if (type === "image/webp") return b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP";
  if (type === "image/avif") return b.toString("ascii", 4, 8) === "ftyp" && /^avi[fs]$/.test(b.toString("ascii", 8, 12));
  return false;
}

// Caminhos locais -> endereço de origem, tirados do catálogo (produtos com image_src e lojas com logo_src).
function mapFromCatalog(catalog) {
  const map = new Map();
  const add = (local, src) => {
    if (!local || !src) return;
    let u;
    try { u = new URL(src); } catch (e) { return; }
    const rel = "/" + String(local).replace(/^\/+/, "");
    if (u.protocol !== "https:" || !HOSTS.has(u.hostname) || !/^\/img\/(cp|lojas)\/[\w.-]+$/.test(rel)) return;
    if (!TYPES[path.extname(rel).toLowerCase()]) return;
    map.set(rel, u.href);
  };
  for (const p of catalog.products || []) add(p.image, p.image_src);
  for (const s of catalog.stores || []) add(s.logo, s.logo_src);
  return map;
}

class RemoteImages {
  constructor({ catalog, dir, fetchImpl = globalThis.fetch, log = console } = {}) {
    this.map = mapFromCatalog(catalog || {});
    this.dir = dir ? path.join(dir, "remote-img") : null;
    this.fetch = fetchImpl;
    this.log = log;
    this.mem = new Map();      // caminho -> {body, type, tag}
    this.pending = new Map();  // caminho -> Promise (um download por arquivo, mesmo com vários pedidos juntos)
    this.failed = new Map();   // caminho -> quando falhou
    if (this.dir) { try { fs.mkdirSync(this.dir, { recursive: true }); } catch (e) { this.dir = null; } }
  }
  has(rel) { return this.map.has(rel); }
  get size() { return this.map.size; }
  file(rel) { return this.dir && path.join(this.dir, path.basename(rel)); }
  entry(rel, body) {
    return { body, type: TYPES[path.extname(rel).toLowerCase()], tag: crypto.createHash("sha1").update(body).digest("hex").slice(0, 12) };
  }
  // Devolve a imagem (do disco ou baixada agora). Erro se não der para baixar.
  async get(rel) {
    if (!this.map.has(rel)) throw new Error("fora da lista");
    const hit = this.mem.get(rel);
    if (hit) return hit;
    const f = this.file(rel);
    if (f) {
      try {
        const body = fs.readFileSync(f);
        if (looksLike(TYPES[path.extname(rel).toLowerCase()], body)) { const e = this.entry(rel, body); this.mem.set(rel, e); return e; }
      } catch (e) { /* ainda não baixada */ }
    }
    const failedAt = this.failed.get(rel);
    if (failedAt && Date.now() - failedAt < RETRY_MS) throw new Error("falhou há pouco");
    if (!this.pending.has(rel)) {
      const job = this.download(rel).finally(() => this.pending.delete(rel));
      this.pending.set(rel, job);
    }
    return this.pending.get(rel);
  }
  async download(rel) {
    const src = this.map.get(rel), type = TYPES[path.extname(rel).toLowerCase()];
    try {
      const res = await this.fetch(src, { redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: "image/avif,image/webp,image/*" } });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const len = Number(res.headers.get("content-length") || 0);
      if (len > MAX_BYTES) throw new Error("grande demais");
      const body = Buffer.from(await res.arrayBuffer());
      if (body.length > MAX_BYTES) throw new Error("grande demais");
      if (!looksLike(type, body)) throw new Error("não é " + type);
      const f = this.file(rel);
      if (f) { try { fs.writeFileSync(f + ".tmp", body); fs.renameSync(f + ".tmp", f); } catch (e) { /* sem disco: fica só na memória */ } }
      const e = this.entry(rel, body);
      this.mem.set(rel, e);
      this.failed.delete(rel);
      return e;
    } catch (e) {
      this.failed.set(rel, Date.now());
      this.log.warn(`imagem ${rel}: não foi possível baixar (${e.message})`);
      throw e;
    }
  }
  // Na inicialização: baixa, uma de cada vez, as que ainda não estão no disco. Não atrapalha o site.
  async warm() {
    let ok = 0, bad = 0;
    for (const rel of this.map.keys()) {
      try { await this.get(rel); ok++; } catch (e) { bad++; }
    }
    if (this.map.size) this.log.log(`imagens externas: ${ok} de ${this.map.size} prontas${bad ? `, ${bad} com erro` : ""}`);
    return { ok, bad };
  }
}

module.exports = { RemoteImages, mapFromCatalog, looksLike, HOSTS };
