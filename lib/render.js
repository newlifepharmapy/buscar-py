// Monta as páginas a partir dos modelos em views/ com as configurações do painel.
// Sintaxe dos modelos:
//   {{caminho.do.valor}}   texto escapado (seguro dentro de tags e de atributos entre aspas)
//   {{{bloco}}}            HTML gerado aqui mesmo (listas de links, câmeras, passos...)
//   {{> parcial}}          inclui views/partials/parcial.html
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const VIEWS = path.join(__dirname, "..", "views");
const DEFAULT_BRAND = require("./defaults").brand;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const get = (obj, p) => p.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
const hash = (s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 10);

const files = new Map();
function readView(rel, reload) {
  const file = path.join(VIEWS, rel);
  const hit = files.get(file);
  if (hit && !reload) return hit.text;
  const mtime = fs.statSync(file).mtimeMs;
  if (hit && hit.mtime === mtime) return hit.text;
  const text = fs.readFileSync(file, "utf8");
  files.set(file, { text, mtime });
  return text;
}

function fill(tpl, ctx, reload, depth = 0) {
  if (depth > 4) throw new Error("parciais aninhados demais");
  return tpl
    .replace(/\{\{>\s*([\w-]+)\s*\}\}/g, (m, name) => fill(readView(`partials/${name}.html`, reload), ctx, reload, depth + 1))
    .replace(/\{\{\{\s*([\w.]+)\s*\}\}\}|\{\{\s*([\w.]+)\s*\}\}/g, (m, raw, text) => {
      if (raw) { const v = get(ctx.raw, raw); return v == null ? "" : String(v); }
      const v = get(ctx, text);
      return v == null ? "" : esc(v);
    });
}

/* ---------- Cores ---------- */
function mix(hex, to, t) {
  const a = hex.match(/[0-9a-f]{2}/gi).map((x) => parseInt(x, 16));
  const b = to.match(/[0-9a-f]{2}/gi).map((x) => parseInt(x, 16));
  return "#" + a.map((v, i) => Math.round(v + (b[i] - v) * t).toString(16).padStart(2, "0")).join("");
}
function luminance(hex) {
  const [r, g, b] = hex.match(/[0-9a-f]{2}/gi).map((x) => {
    const c = parseInt(x, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
// Contraste do texto branco sobre a cor (o painel avisa abaixo de 4,5:1, mínimo para leitura).
const contrastWithWhite = (hex) => 1.05 / (luminance(hex) + 0.05);

// Só sobrescreve a paleta de app.css quando a cor foi trocada no painel (a padrão tem tons ajustados à mão).
function themeCss(brand) {
  const { blue, red } = brand;
  const vars = [];
  if (blue !== DEFAULT_BRAND.blue) {
    vars.push(`--blue:${blue}`, `--blue-700:${mix(blue, "#000000", 0.22)}`, `--blue-900:${mix(blue, "#000000", 0.6)}`,
      `--blue-50:${mix(blue, "#ffffff", 0.93)}`, `--blue-100:${mix(blue, "#ffffff", 0.85)}`);
  }
  if (red !== DEFAULT_BRAND.red) vars.push(`--red:${red}`, `--red-700:${mix(red, "#000000", 0.17)}`, `--red-50:${mix(red, "#ffffff", 0.92)}`);
  return vars.length ? `:root{${vars.join(";")}}\n` : "/* cores padrão */\n";
}

/* ---------- Números ---------- */
const brlText = (v) => "R$ " + v.toFixed(2).replace(".", ",");
const pygNum = (v) => String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
const pygText = (v) => "₲ " + pygNum(v);

/* ---------- Blocos ---------- */
const LIVE_DOT = '<span class="live-dot" aria-hidden="true"></span>';
const LOGO_SVG = '<svg class="logo-mark" viewBox="0 0 40 40" width="38" height="38" aria-hidden="true">' +
  '<rect class="lm-bg" width="40" height="40" rx="10"/>' +
  '<circle cx="17.5" cy="17.5" r="8.5" fill="none" stroke="#fff" stroke-width="3.6"/>' +
  '<path d="M24 24l7.5 7.5" stroke="#fff" stroke-width="4" stroke-linecap="round"/>' +
  '<rect class="lm-bar" x="6" y="33" width="28" height="3" rx="1.5"/></svg>';

function topLinks(links, current) {
  return links.map((l) => {
    const ext = l.newTab ? ' target="_blank" rel="noopener"' : "";
    const cur = current && l.url === current ? ' aria-current="page"' : "";
    return `<a class="util-link${l.live ? " is-live" : ""}" href="${esc(l.url)}"${ext}${cur}>${l.live ? LIVE_DOT : ""}${esc(l.label)}</a>`;
  }).join("");
}

function cameraTabs(list) {
  return list.map((c, i) =>
    `<button type="button" class="cam-tab" role="tab" id="camTab${i}" aria-controls="camStage" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}" data-src="${esc(c.url)}">${LIVE_DOT}${esc(c.name)}</button>`).join("");
}

function frameOrigins(settings) {
  const out = new Set();
  for (const c of settings.cameras.list) { try { out.add(new URL(c.url).origin); } catch (e) { /* ignorado */ } }
  return [...out];
}

// Contexto usado por todos os modelos.
function context(settings, fx, opts = {}) {
  const s = settings;
  const full = [s.brand.name1, s.brand.name2].filter(Boolean).join(" ");
  const logoV = s.brand.logo ? hash(s.brand.logo) : "";
  const fxTitle = fx.source === "manual"
    ? "Cotação de referência definida pela equipe do site"
    : `Cotação comercial do dólar (${fx.source === "google" ? "fonte: Google" : "fonte: " + fx.source}), atualizada a cada 5 minutos`;
  return {
    ...s,
    brand: { ...s.brand, full },
    page: { path: opts.path || "/", canonical: "https://" + (opts.host || "buscarpy.com") + (opts.path || "/") },
    fx: {
      BRL: fx.BRL, PYG: fx.PYG, at: fx.at || "", source: fx.source,
      brlText: brlText(fx.BRL), pygText: pygText(fx.PYG), title: fxTitle,
    },
    raw: {
      themeLink: opts.server ? `<link rel="stylesheet" href="/theme.css?v=${hash(themeCss(s.brand))}">` : "",
      logoMark: s.brand.logo ? `<img class="logo-img" src="/brand-logo?v=${logoV}" width="38" height="38" alt="">` : LOGO_SVG,
      topLinks: topLinks(s.topbar.links, opts.path),
      steps: s.home.steps.map((st) => `<li><h3>${esc(st.title)}</h3><p>${esc(st.text)}</p></li>`).join(""),
      cameraTabs: cameraTabs(s.cameras.list),
      cameraTips: s.cameras.tips.map((t) => `<li>${esc(t)}</li>`).join(""),
    },
  };
}

function render(view, settings, fx, opts = {}) {
  return fill(readView(view, opts.reload), context(settings, fx, opts), opts.reload);
}

module.exports = { render, themeCss, frameOrigins, contrastWithWhite, brlText, pygText, esc, hash, fill, context };
