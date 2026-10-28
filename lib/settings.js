// Configurações editáveis pelo painel admin: validação e gravação em disco.
// Tudo que chega do painel passa por sanitize(): só entram os campos conhecidos, com tipo e tamanho
// conferidos. Textos são sempre texto puro (o HTML é escapado na hora de montar a página).
"use strict";
const fs = require("fs");
const path = require("path");
const DEFAULTS = require("./defaults");

const clone = (o) => JSON.parse(JSON.stringify(o));
const LIMITS = { short: 60, line: 160, text: 400 };
const LOGO_MAX = 400 * 1024; // bytes da imagem decodificada

function str(v, fallback, max) {
  if (typeof v !== "string") return fallback;
  // tira caracteres de controle (mantém quebras de linha só onde o campo aceita várias linhas)
  const s = v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  return s.slice(0, max);
}
function color(v, fallback) {
  return typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v.trim()) ? v.trim().toLowerCase() : fallback;
}
function bool(v, fallback) { return typeof v === "boolean" ? v : fallback; }
function num(v, fallback, min, max) {
  const n = typeof v === "string" ? Number(v.replace(",", ".")) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

// Links do topo: caminho do próprio site ("/cameras") ou endereço http(s) completo.
function linkUrl(v) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (/^\/(?![\/\\])[^\s]*$/.test(s)) return s.slice(0, 500);
  try {
    const u = new URL(s);
    if ((u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password) return u.href.slice(0, 500);
  } catch (e) { /* inválido */ }
  return null;
}
// Nome de servidor comum (letras, números, pontos e hífens). O endereço do player vai para o cabeçalho
// de segurança da página /cameras, então nada de "*", ";" ou outros símbolos.
const PLAIN_HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i;
const YT_ID = /^[\w-]{11}$/;
// Link normal do YouTube (vídeo, live ou youtu.be) -> código do vídeo; a página do YouTube não abre
// dentro de outro site, só o player (/embed/).
function youtubeId(u) {
  const host = u.hostname.toLowerCase().replace(/^(www|m)\./, "");
  let id = null;
  if (host === "youtu.be") id = u.pathname.split("/")[1];
  else if (host === "youtube.com" && u.pathname === "/watch") id = u.searchParams.get("v");
  else if (host === "youtube.com" && u.pathname.startsWith("/live/")) id = u.pathname.split("/")[2];
  return id && YT_ID.test(id) ? id : null;
}
// Câmeras: só players https (a página é https e o navegador bloquearia conteúdo misto).
function httpsUrl(v) {
  if (typeof v !== "string") return null;
  try {
    const u = new URL(v.trim().replace(/&amp;/g, "&"));
    if (u.protocol !== "https:" || u.username || u.password || !PLAIN_HOST.test(u.hostname)) return null;
    const yt = youtubeId(u);
    if (yt) return `https://www.youtube.com/embed/${yt}?autoplay=1&mute=1&playsinline=1`;
    return u.href.slice(0, 600);
  } catch (e) { /* inválido */ }
  return null;
}
function logo(v, fallback) {
  if (v === "" || v === null) return "";
  if (typeof v !== "string") return fallback;
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+=*)$/.exec(v);
  if (!m) return fallback;
  const bytes = Buffer.from(m[2], "base64");
  if (bytes.length > LOGO_MAX || bytes.length < 16) return fallback;
  // confere a assinatura do arquivo: o tipo declarado tem de bater com o conteúdo
  const sig = { png: [0x89, 0x50, 0x4e, 0x47], jpeg: [0xff, 0xd8, 0xff], webp: [0x52, 0x49, 0x46, 0x46] }[m[1]];
  if (!sig.every((b, i) => bytes[i] === b)) return fallback;
  if (m[1] === "webp" && bytes.toString("ascii", 8, 12) !== "WEBP") return fallback;
  return v;
}

// Mescla o que veio (do disco ou do painel) com a base, campo a campo: um campo que falta ou não
// passa na validação fica com o valor da base (os padrões, ou as últimas configurações salvas).
function sanitize(input, base) {
  const d = base || DEFAULTS;
  const i = input && typeof input === "object" ? input : {};
  const g = (k) => (i[k] && typeof i[k] === "object" ? i[k] : {});
  const b = g("brand"), seo = g("seo"), tb = g("topbar"), h = g("home"), f = g("footer"), r = g("rates"), c = g("cameras");

  const links = Array.isArray(tb.links)
    ? tb.links.slice(0, 6).map((l) => {
      if (!l || typeof l !== "object") return null;
      const url = linkUrl(l.url), label = str(l.label, "", 40);
      return url && label ? { label, url, live: bool(l.live, false), newTab: bool(l.newTab, false) } : null;
    }).filter(Boolean)
    : clone(d.topbar.links);

  const steps = d.home.steps.map((s, k) => {
    const x = Array.isArray(h.steps) && h.steps[k] && typeof h.steps[k] === "object" ? h.steps[k] : {};
    return { title: str(x.title, s.title, 80) || s.title, text: str(x.text, s.text, LIMITS.text) };
  });

  const tips = Array.isArray(c.tips) ? c.tips.slice(0, 8).map((t) => str(t, "", 200)).filter(Boolean) : clone(d.cameras.tips);
  const cams = Array.isArray(c.list)
    ? c.list.slice(0, 8).map((x) => {
      if (!x || typeof x !== "object") return null;
      const url = httpsUrl(x.url), name = str(x.name, "", 60);
      return url && name ? { name, url } : null;
    }).filter(Boolean)
    : clone(d.cameras.list);

  // campo obrigatório: se o painel mandar vazio, fica o valor da base
  const req = (v, def, max) => str(v, def, max) || def;
  return {
    brand: {
      name1: req(b.name1, d.brand.name1, 24),
      name2: str(b.name2, d.brand.name2, 12),
      primary: color(b.primary, d.brand.primary),
      accent: color(b.accent, d.brand.accent),
      logo: logo(b.logo, d.brand.logo),
    },
    seo: { title: req(seo.title, d.seo.title, 90), description: req(seo.description, d.seo.description, 300) },
    topbar: { message: str(tb.message, d.topbar.message, LIMITS.line), links },
    home: {
      eyebrow: str(h.eyebrow, d.home.eyebrow, 80),
      title: req(h.title, d.home.title, 120),
      lead: str(h.lead, d.home.lead, 300),
      photoTitle: req(h.photoTitle, d.home.photoTitle, 80),
      photoText: str(h.photoText, d.home.photoText, 200),
      photoButton: req(h.photoButton, d.home.photoButton, 30),
      photoFine: str(h.photoFine, d.home.photoFine, 160),
      howTitle: req(h.howTitle, d.home.howTitle, 60),
      steps,
    },
    footer: { about: str(f.about, d.footer.about, 300), note: str(f.note, d.footer.note, 300) },
    rates: { auto: bool(r.auto, d.rates.auto), BRL: num(r.BRL, d.rates.BRL, 1, 20), PYG: num(r.PYG, d.rates.PYG, 1000, 20000) },
    cameras: {
      title: req(c.title, d.cameras.title, 80),
      intro: str(c.intro, d.cameras.intro, 300),
      credit: str(c.credit, d.cameras.credit, 120),
      tips,
      list: cams,
    },
  };
}

// Armazena as configurações em DATA_DIR/settings.json. No Railway, DATA_DIR deve apontar para um volume
// (ex.: /data); sem volume o arquivo some a cada novo deploy, e o painel avisa isso.
class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, "settings.json");
    this.version = 0;
    this.savedAt = null;
    this.writable = false;
    // No Railway, só um volume sobrevive a um novo deploy; fora dele (ex.: no seu computador) o disco é permanente.
    const env = process.env;
    const onRailway = Boolean(env.RAILWAY_ENVIRONMENT_ID || env.RAILWAY_PROJECT_ID || env.RAILWAY_SERVICE_ID || env.RAILWAY_ENVIRONMENT);
    const d = path.resolve(dir), vol = env.RAILWAY_VOLUME_MOUNT_PATH && path.resolve(env.RAILWAY_VOLUME_MOUNT_PATH);
    this.persistent = !onRailway || Boolean(vol && (d === vol || d.startsWith(vol.endsWith(path.sep) ? vol : vol + path.sep)));
    this.listeners = [];
    try { fs.mkdirSync(dir, { recursive: true }); fs.accessSync(dir, fs.constants.W_OK); this.writable = true; } catch (e) { /* sem disco */ }
    this.data = sanitize({});
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      this.data = sanitize(raw.settings || raw);
      this.version = Number(raw.version) || 0;
      this.savedAt = raw.savedAt || null;
    } catch (e) {
      if (e.code !== "ENOENT") console.error("settings.json ilegível, usando os padrões:", e.message);
    }
  }
  get() { return this.data; }
  onChange(fn) { this.listeners.push(fn); }
  // Grava só se baseVersion for a versão atual (evita que duas abas do painel apaguem uma a outra).
  // Um campo inválido mantém o último valor salvo (não volta ao padrão de fábrica). "Restaurar padrão"
  // no painel funciona porque ele manda os valores padrão de forma explícita.
  save(input, baseVersion) {
    if (baseVersion != null && Number(baseVersion) !== this.version) {
      const err = new Error("conflict"); err.code = "CONFLICT"; throw err;
    }
    const data = sanitize(input, this.data);
    const version = this.version + 1, savedAt = new Date().toISOString();
    if (this.writable) {
      const tmp = this.file + "." + process.pid + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ version, savedAt, settings: data }, null, 2));
      fs.renameSync(tmp, this.file);
    }
    this.data = data; this.version = version; this.savedAt = savedAt;
    for (const fn of this.listeners) fn(data);
    return data;
  }
}

module.exports = { sanitize, Store, DEFAULTS, linkUrl, httpsUrl };
