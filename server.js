// Buscar PY — servidor sem dependências, pensado para o Railway.
// Serve o site (public/), monta as páginas com as configurações do painel (views/), mantém a cotação
// do dólar atualizada e expõe o painel admin em /admin.
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const { Store } = require("./lib/settings");
const { Rates } = require("./lib/rates");
const { Auth } = require("./lib/auth");
const R = require("./lib/render");
const DEFAULTS = require("./lib/defaults");

const PORT = Number(process.env.PORT) || 8080;
const ROOT = path.join(__dirname, "public");
const PROD = process.env.NODE_ENV === "production";
const CANONICAL_HOST = (process.env.CANONICAL_HOST || "").toLowerCase(); // ex.: buscarpy.com
// Onde ficam settings.json e a última cotação. No Railway, um volume montado é usado automaticamente.
const DATA_DIR = path.resolve(process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, "storage"));

const store = new Store(DATA_DIR);
const rates = new Rates({ dir: store.writable ? DATA_DIR : null, intervalMs: Number(process.env.RATES_INTERVAL_MS) || 5 * 60 * 1000 });
const auth = new Auth({ password: process.env.ADMIN_PASSWORD, secret: process.env.SESSION_SECRET, dir: store.writable ? DATA_DIR : null });

const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".png": "image/png", ".webp": "image/webp", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8", ".bin": "application/octet-stream", "": "application/octet-stream",
};
// Binários (pesos do modelo, vetores) quase não comprimem: não vale gastar CPU com eles.
const COMPRESSIBLE = /^(text\/|application\/(json|xml)|image\/svg)/;

// Política de segurança de conteúdo. frames: origens dos players das câmeras (só na página /cameras).
function csp({ evalJs = false, frames = [], ancestors = "'self'" } = {}) {
  return [
    "default-src 'self'",
    "script-src 'self'" + (evalJs ? " 'unsafe-eval'" : ""), // o TensorFlow.js da busca por foto precisa de eval
    "style-src 'self' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "frame-src " + (frames.length ? frames.join(" ") : "'none'"),
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors " + ancestors,
  ].join("; ");
}
const BASE_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(self), microphone=(), geolocation=()",
};
const SECURITY = { ...BASE_HEADERS, "X-Frame-Options": "SAMEORIGIN", "Content-Security-Policy": csp({ evalJs: true }) };
const ADMIN_HEADERS = {
  ...BASE_HEADERS, "X-Frame-Options": "DENY", "X-Robots-Tag": "noindex, nofollow", "Cache-Control": "no-store",
  "Content-Security-Policy": csp({ ancestors: "'none'" }),
};

/* ---------- Arquivos estáticos ---------- */
// Lidos e comprimidos uma vez e mantidos em memória (o site inteiro tem ~20 MB).
// Fora de produção, o arquivo é relido quando muda no disco.
const cache = new Map();
function compress(entry) {
  if (COMPRESSIBLE.test(entry.type) && entry.body.length > 1024) {
    entry.br = zlib.brotliCompressSync(entry.body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } });
    entry.gz = zlib.gzipSync(entry.body, { level: 9 });
  }
  return entry;
}
function load(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error("not a file");
  let entry = cache.get(file);
  if (entry && (PROD || entry.mtime === stat.mtimeMs)) return entry;
  const body = fs.readFileSync(file);
  const type = TYPES[path.extname(file).toLowerCase()] || TYPES[""];
  const tag = `${stat.size.toString(16)}-${Math.round(stat.mtimeMs).toString(16)}`;
  entry = compress({ body, type, tag, mtime: stat.mtimeMs });
  cache.set(file, entry);
  return entry;
}
// Pré-carrega tudo na inicialização para não comprimir durante as requisições.
function warm(dir) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) warm(full);
    else load(full);
  }
}
function cacheControl(rel) {
  // fotos de produto têm nome fixo (código do produto) e não mudam: 7 dias
  if (/^\/img\//.test(rel)) return "public, max-age=604800";
  // todo o resto (HTML, CSS, JS, dados, modelo e TensorFlow.js) revalida com o ETag:
  // sem mudança a resposta é um 304 vazio, e um deploy novo aparece na hora
  return "no-cache";
}

/* ---------- Páginas montadas com as configurações ---------- */
// Refeitas só quando as configurações ou a cotação mudam.
const pages = new Map();
store.onChange(() => pages.clear());
rates.onChange(() => pages.clear());
function page(view, pagePath) {
  const key = view + "|" + pagePath;
  if (PROD && pages.has(key)) return pages.get(key);
  const s = store.get();
  const html = R.render(view, s, rates.effective(s), { server: true, path: pagePath, host: CANONICAL_HOST || "buscarpy.com", reload: !PROD });
  const body = Buffer.from(html);
  const entry = compress({ body, type: TYPES[".html"], tag: R.hash(html) });
  pages.set(key, entry);
  return entry;
}
function generated(text, type) {
  const body = Buffer.from(text);
  return compress({ body, type, tag: R.hash(text) });
}

/* ---------- Respostas ---------- */
function hostOf(req) {
  return (req.headers.host || "").toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
}
function etagMatches(header, etag) {
  if (!header) return false;
  if (header.trim() === "*") return true;
  return header.split(",").some((t) => t.trim().replace(/^W\//, "") === etag);
}
function send(req, res, entry, extra, status = 200) {
  const accept = req.headers["accept-encoding"] || "";
  let body = entry.body, enc = "";
  if (entry.br && /\bbr\b/.test(accept)) { body = entry.br; enc = "br"; }
  else if (entry.gz && /\bgzip\b/.test(accept)) { body = entry.gz; enc = "gzip"; }
  const etag = `"${entry.tag}${enc ? "-" + enc : ""}"`;
  const headers = { ...SECURITY, "Content-Type": entry.type, "Cache-Control": "no-cache", ETag: etag, Vary: "Accept-Encoding", ...extra };
  if (req.headers["x-forwarded-proto"] === "https") headers["Strict-Transport-Security"] = "max-age=31536000";
  if (status === 200 && etagMatches(req.headers["if-none-match"], etag)) { res.writeHead(304, headers); return res.end(); }
  if (enc) headers["Content-Encoding"] = enc;
  headers["Content-Length"] = body.length;
  res.writeHead(status, headers);
  res.end(req.method === "HEAD" ? undefined : body);
}
function sendNotFound(req, res) {
  try { return send(req, res, page("404.html", "/404"), { "Cache-Control": "no-cache" }, 404); } catch (e) {
    res.writeHead(404, { ...SECURITY, "Content-Type": TYPES[".txt"] });
    return res.end("Página não encontrada");
  }
}
function json(res, status, obj, extra) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { ...ADMIN_HEADERS, "Content-Type": TYPES[".json"], "Content-Length": Buffer.byteLength(body), ...extra });
  res.end(body);
}
function redirect(res, to) { res.writeHead(301, { Location: to }); res.end(); }

/* ---------- API ---------- */
function clientIp(req) {
  const cf = req.headers["cf-connecting-ip"];
  if (cf) return String(cf).trim();
  const xff = req.headers["x-forwarded-for"];
  // o Railway acrescenta o IP de quem conectou no fim da lista; o começo pode ter sido inventado pelo cliente
  if (xff) return String(xff).split(",").pop().trim();
  return req.socket.remoteAddress || "?";
}
function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0, tooBig = false;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (tooBig) { if (size > limit * 8) req.destroy(); return; } // descarta o resto sem guardar
      if (size > limit) { tooBig = true; chunks.length = 0; reject(Object.assign(new Error("grande demais"), { status: 413 })); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (tooBig) return;
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch (e) { reject(Object.assign(new Error("JSON inválido"), { status: 400 })); }
    });
    req.on("error", reject);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function adminState() {
  const s = store.get();
  return {
    settings: s,
    version: store.version,
    savedAt: store.savedAt,
    defaults: DEFAULTS,
    storage: { writable: store.writable, persistent: store.persistent && store.writable },
    rates: { effective: rates.effective(s), ...rates.status() },
    contrast: { blue: R.contrastWithWhite(s.brand.blue), red: R.contrastWithWhite(s.brand.red) },
  };
}

async function api(req, res, rel, secure) {
  if (rel === "/api/rates" && (req.method === "GET" || req.method === "HEAD")) {
    const e = rates.effective(store.get());
    return json(res, 200, { BRL: e.BRL, PYG: e.PYG, at: e.at, source: e.source, auto: e.auto }, { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" });
  }
  if (!rel.startsWith("/api/admin/")) return json(res, 404, { error: "não encontrado" });

  const mutating = req.method === "POST" || req.method === "PUT";
  if (mutating) {
    // Proteção contra envio a partir de outro site: o cookie já é SameSite=Strict, e aqui conferimos
    // também que o pedido é JSON e veio do mesmo endereço.
    if (!/^application\/json\b/i.test(req.headers["content-type"] || "")) return json(res, 415, { error: "envie JSON" });
    const origin = req.headers.origin;
    if (origin) {
      let oh = "";
      try { oh = new URL(origin).host.toLowerCase(); } catch (e) { /* inválido */ }
      if (oh !== (req.headers.host || "").toLowerCase()) return json(res, 403, { error: "origem não permitida" });
    }
  } else if (req.method !== "GET") {
    return json(res, 405, { error: "método não permitido" }, { Allow: "GET, POST, PUT" });
  }

  if (rel === "/api/admin/session" && req.method === "GET") {
    return json(res, 200, { enabled: auth.enabled, loggedIn: auth.verify(auth.tokenFrom(req)) });
  }
  if (rel === "/api/admin/login" && req.method === "POST") {
    if (!auth.enabled) return json(res, 503, { error: "Painel desativado: defina a variável ADMIN_PASSWORD (mínimo de 8 caracteres) no Railway." });
    const ip = clientIp(req);
    if (auth.blocked(ip)) return json(res, 429, { error: "Muitas tentativas erradas. Espere 15 minutos e tente de novo." });
    let body;
    try { body = await readJson(req, 4096); } catch (e) { return json(res, e.status || 400, { error: e.message }); }
    if (!auth.check(body.password, ip)) {
      await sleep(400 + Math.random() * 300);
      return json(res, 401, { error: "Senha incorreta." });
    }
    console.log(`painel: login de ${ip}`);
    return json(res, 200, { ok: true }, { "Set-Cookie": auth.cookie(auth.issue(), secure) });
  }
  if (rel === "/api/admin/logout" && req.method === "POST") {
    return json(res, 200, { ok: true }, { "Set-Cookie": auth.clearCookie(secure) });
  }

  // Daqui para baixo, só com sessão válida.
  if (!auth.verify(auth.tokenFrom(req))) return json(res, 401, { error: "Sessão expirada. Entre de novo." });

  if (rel === "/api/admin/settings" && req.method === "GET") return json(res, 200, adminState());
  if (rel === "/api/admin/settings" && req.method === "PUT") {
    let body;
    try { body = await readJson(req, 1200 * 1024); } catch (e) { return json(res, e.status || 400, { error: e.status === 413 ? "Conteúdo grande demais (a imagem do logo pode ter até 400 KB)." : e.message }); }
    try {
      store.save(body.settings, body.version);
    } catch (e) {
      if (e.code === "CONFLICT") return json(res, 409, { error: "Outra pessoa salvou alterações enquanto você editava. Recarregue para ver a versão atual.", ...adminState() });
      console.error("painel: erro ao salvar", e);
      return json(res, 500, { error: "Não foi possível gravar as alterações no disco." });
    }
    console.log(`painel: configurações salvas (versão ${store.version}) por ${clientIp(req)}`);
    return json(res, 200, adminState());
  }
  if (rel === "/api/admin/rates/refresh" && req.method === "POST") {
    await rates.refresh().catch(() => {});
    return json(res, 200, adminState());
  }
  return json(res, 404, { error: "não encontrado" });
}

/* ---------- Roteamento ---------- */
async function handle(req, res) {
  if (req.url === "/health") { res.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" }); return res.end("ok"); }

  const host = hostOf(req);
  const proto = req.headers["x-forwarded-proto"];
  // www.buscarpy.com -> buscarpy.com e http -> https (o Railway termina o TLS e informa x-forwarded-proto)
  if (CANONICAL_HOST && (host === "www." + CANONICAL_HOST || (host === CANONICAL_HOST && proto === "http"))) {
    return redirect(res, `https://${CANONICAL_HOST}${req.url}`);
  }

  let rel;
  try { rel = decodeURIComponent(new URL(req.url, "http://x").pathname); } catch (e) { res.writeHead(400); return res.end(); }
  if (rel.includes("\0")) { res.writeHead(400); return res.end(); }

  if (rel.startsWith("/api/")) return api(req, res, rel, proto === "https" || (!proto && PROD));
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { Allow: "GET, HEAD" }); return res.end(); }

  // páginas montadas
  if (rel === "/" || rel === "/index.html") return send(req, res, page("index.html", "/"));
  if (rel === "/cameras") {
    const frames = R.frameOrigins(store.get());
    return send(req, res, page("cameras.html", "/cameras"), { "Content-Security-Policy": csp({ frames }) });
  }
  if (rel === "/cameras/" || rel === "/cameras.html" || rel === "/camaras") return redirect(res, "/cameras");
  if (rel === "/admin") return redirect(res, "/admin/");
  if (rel === "/theme.css") return send(req, res, generated(R.themeCss(store.get().brand), TYPES[".css"]));
  if (rel === "/brand-logo") {
    const m = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(store.get().brand.logo || "");
    if (!m) return sendNotFound(req, res);
    const body = Buffer.from(m[2], "base64");
    return send(req, res, { body, type: m[1], tag: crypto.createHash("sha1").update(body).digest("hex").slice(0, 12) }, { "Cache-Control": "public, max-age=31536000, immutable" });
  }

  // arquivos de public/
  let file = rel.endsWith("/") ? rel + "index.html" : rel;
  file = path.normalize(path.join(ROOT, file));
  if (!file.startsWith(ROOT + path.sep)) return sendNotFound(req, res);
  let entry;
  try { entry = load(file); } catch (e) { return sendNotFound(req, res); }
  if (rel.startsWith("/admin/")) return send(req, res, entry, ADMIN_HEADERS);
  return send(req, res, entry, { "Cache-Control": cacheControl(rel) });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) { res.writeHead(500, { "Content-Type": TYPES[".txt"] }); res.end("Erro interno"); }
    else res.destroy();
  });
});

warm(ROOT);
rates.start();
server.listen(PORT, () => {
  console.log(`Buscar PY no ar na porta ${PORT}`);
  console.log(`Configurações em ${DATA_DIR} (${store.writable ? (store.persistent ? "gravável e permanente" : "gravável, mas some no próximo deploy: monte um volume") : "somente leitura"})`);
  if (!auth.enabled) console.log("Painel admin desativado: defina ADMIN_PASSWORD (mínimo de 8 caracteres).");
});
// Encerra com calma: para de aceitar conexões e deixa as respostas em andamento terminarem.
process.on("SIGTERM", () => {
  rates.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10000).unref();
});
