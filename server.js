// Buscar PY — servidor estático sem dependências, pensado para o Railway.
// Serve a pasta public/ com compressão, cache e cabeçalhos de segurança.
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const PORT = Number(process.env.PORT) || 8080;
const ROOT = path.join(__dirname, "public");
const PROD = process.env.NODE_ENV === "production";
const CANONICAL_HOST = (process.env.CANONICAL_HOST || "").toLowerCase(); // ex.: buscarpy.com

const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".png": "image/png", ".webp": "image/webp", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8", ".bin": "application/octet-stream", "": "application/octet-stream",
};
// Binários (pesos do modelo, vetores) quase não comprimem: não vale gastar CPU com eles.
const COMPRESSIBLE = /^(text\/|application\/(json|xml)|image\/svg)/;

const SECURITY = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "SAMEORIGIN",
  "Permissions-Policy": "camera=(self), microphone=(), geolocation=()",
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self' 'unsafe-eval'", // o TensorFlow.js precisa de eval
    "style-src 'self' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'self'",
  ].join("; "),
};

// Arquivos lidos e comprimidos uma vez e mantidos em memória (o site inteiro tem ~20 MB).
// Fora de produção, o arquivo é relido quando muda no disco.
const cache = new Map();
function load(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error("not a file");
  let entry = cache.get(file);
  if (entry && (PROD || entry.mtime === stat.mtimeMs)) return entry;
  const body = fs.readFileSync(file);
  const type = TYPES[path.extname(file).toLowerCase()] || TYPES[""];
  const tag = `${stat.size.toString(16)}-${Math.round(stat.mtimeMs).toString(16)}`;
  entry = { body, type, tag, mtime: stat.mtimeMs };
  if (COMPRESSIBLE.test(type) && body.length > 1024) {
    entry.br = zlib.brotliCompressSync(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } });
    entry.gz = zlib.gzipSync(body, { level: 9 });
  }
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

function hostOf(req) {
  return (req.headers.host || "").toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
}

function etagMatches(header, etag) {
  if (!header) return false;
  if (header.trim() === "*") return true;
  return header.split(",").some((t) => t.trim().replace(/^W\//, "") === etag);
}

function sendNotFound(req, res) {
  let notFound;
  try { notFound = load(path.join(ROOT, "404.html")); } catch (e) { notFound = { body: Buffer.from("Página não encontrada"), type: TYPES[".txt"] }; }
  res.writeHead(404, { ...SECURITY, "Content-Type": notFound.type, "Cache-Control": "no-cache" });
  res.end(req.method === "HEAD" ? undefined : notFound.body);
}

const server = http.createServer((req, res) => {
  if (req.url === "/health") { res.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" }); return res.end("ok"); }

  const host = hostOf(req);
  const proto = req.headers["x-forwarded-proto"];
  // www.buscarpy.com -> buscarpy.com e http -> https (o Railway termina o TLS e informa x-forwarded-proto)
  if (CANONICAL_HOST && (host === "www." + CANONICAL_HOST || (host === CANONICAL_HOST && proto === "http"))) {
    res.writeHead(301, { Location: `https://${CANONICAL_HOST}${req.url}` });
    return res.end();
  }
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { Allow: "GET, HEAD" }); return res.end(); }

  let rel;
  try { rel = decodeURIComponent(new URL(req.url, "http://x").pathname); } catch (e) { res.writeHead(400); return res.end(); }
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT + path.sep)) return sendNotFound(req, res);

  let entry;
  try { entry = load(file); } catch (e) { return sendNotFound(req, res); }

  const accept = req.headers["accept-encoding"] || "";
  let body = entry.body, enc = "";
  if (entry.br && /\bbr\b/.test(accept)) { body = entry.br; enc = "br"; }
  else if (entry.gz && /\bgzip\b/.test(accept)) { body = entry.gz; enc = "gzip"; }
  const etag = `"${entry.tag}${enc ? "-" + enc : ""}"`;
  const headers = { ...SECURITY, "Content-Type": entry.type, "Cache-Control": cacheControl(rel), ETag: etag, Vary: "Accept-Encoding" };
  if (proto === "https") headers["Strict-Transport-Security"] = "max-age=31536000";
  if (etagMatches(req.headers["if-none-match"], etag)) { res.writeHead(304, headers); return res.end(); }
  if (enc) headers["Content-Encoding"] = enc;
  headers["Content-Length"] = body.length;
  res.writeHead(200, headers);
  res.end(req.method === "HEAD" ? undefined : body);
});

warm(ROOT);
server.listen(PORT, () => console.log(`Buscar PY no ar na porta ${PORT}`));
// Encerra com calma: para de aceitar conexões e deixa as respostas em andamento terminarem.
process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10000).unref();
});
