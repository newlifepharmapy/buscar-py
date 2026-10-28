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
const BRAND = require("./brand");
const { SOURCES } = require("./rates");
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

// Junta os parciais ao modelo antes de preencher os valores.
function expand(tpl, reload, depth = 0) {
  if (depth > 4) throw new Error("parciais aninhados demais");
  return tpl.replace(/\{\{>\s*([\w-]+)\s*\}\}/g, (m, name) => expand(readView(`partials/${name}.html`, reload), reload, depth + 1));
}
// Os valores entram numa passada só: um "{{...}}" digitado no painel aparece como foi escrito.
function fill(tpl, ctx, reload) {
  return expand(tpl, reload).replace(/\{\{\{\s*([\w.]+)\s*\}\}\}|\{\{\s*([\w.]+)\s*\}\}/g, (m, raw, text) => {
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
// Contraste entre duas cores (o painel avisa abaixo de 4,5:1, mínimo para leitura).
function contrast(a, b) {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
// Texto branco sobre a cor principal (botões, barra da cotação, rodapé).
const contrastWithWhite = (hex) => contrast(hex, "#ffffff");

// Só sobrescreve a paleta de app.css quando a cor foi trocada no painel (a padrão tem tons ajustados à mão).
// primary: azul-tinta da identidade (botões, títulos, barra e rodapé); accent: ouro (o "PY", a seta do
// símbolo, destaques sobre fundo escuro). O verde do menor preço não muda: ele tem significado próprio.
function themeCss(brand) {
  const { primary, accent } = brand;
  const vars = [];
  if (primary !== DEFAULT_BRAND.primary) {
    vars.push(`--navy:${primary}`, `--navy-600:${mix(primary, "#ffffff", 0.08)}`, `--navy-400:${mix(primary, "#ffffff", 0.2)}`,
      `--navy-900:${mix(primary, "#000000", 0.4)}`);
  }
  if (accent !== DEFAULT_BRAND.accent) {
    vars.push(`--gold:${accent}`, `--gold-600:${mix(accent, "#000000", 0.16)}`, `--gold-700:${mix(accent, "#000000", 0.38)}`,
      `--gold-100:${mix(accent, "#ffffff", 0.8)}`);
  }
  return vars.length ? `:root{${vars.join(";")}}\n` : "/* cores padrão */\n";
}

/* ---------- Números ---------- */
const brlText = (v) => "R$ " + v.toFixed(2).replace(".", ",");
const pygNum = (v) => String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
const pygText = (v) => "₲ " + pygNum(v);

/* ---------- Blocos ---------- */
const LIVE_DOT = '<span class="live-dot" aria-hidden="true"></span>';
// Logo: o símbolo "b" e, com o nome padrão, o "BUSCAR PY" desenhado da identidade. Com outro nome
// (trocado no painel), o nome vai em texto no mesmo estilo.
const LOGO_SVG = `<svg class="logo-mark" viewBox="${BRAND.SYMBOL_VIEWBOX}" aria-hidden="true" focusable="false">${BRAND.SYMBOL}</svg>`;
const WORDMARK_SVG = `<svg class="logo-word" viewBox="${BRAND.WORDMARK_VIEWBOX}" aria-hidden="true" focusable="false">` +
  `<path class="lw-ink" d="${BRAND.WORDMARK_INK}"/><path class="lw-py" d="${BRAND.WORDMARK_PY}"/></svg>`;
function logoWord(brand) {
  if (brand.name1.toLowerCase() === "buscar" && brand.name2.toLowerCase() === "py") return WORDMARK_SVG;
  return `<span class="logo-text"><span>${esc(brand.name1)}</span>${brand.name2 ? `<span class="logo-py">${esc(brand.name2)}</span>` : ""}</span>`;
}

function topLinks(links, current) {
  return links.map((l) => {
    const ext = l.newTab ? ' target="_blank" rel="noopener"' : "";
    const cur = current && l.url === current ? ' aria-current="page"' : "";
    return `<a class="util-link${l.live ? " is-live" : ""}" href="${esc(l.url)}"${ext}${cur}>${l.live ? LIVE_DOT : ""}${esc(l.label)}</a>`;
  }).join("");
}

// Câmeras: todas na mesma página, cada uma com o nome em cima e o crédito embaixo (como no iClinic).
// O player só é criado pelo cameras.js quando a câmera aparece na tela; aqui vai só a capa.
const PLAY_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>';
function cameraCards(list, credit) {
  if (!list.length) return '<p class="cams-empty">Nenhuma câmera cadastrada no momento.</p>';
  return list.map((c, i) => {
    const name = esc(c.name), sr = `<span class="sr-only"> ${name}</span>`;
    return `<article class="cam-card" id="cam${i + 1}" aria-labelledby="camName${i}" data-src="${esc(c.url)}">` +
      `<h2 class="cam-name" id="camName${i}">${LIVE_DOT}<span>${name}</span></h2>` +
      '<div class="cam-stage"><div class="cam-cover">' +
      '<p class="cam-cover-msg">Ative o JavaScript para assistir.</p>' +
      `<button type="button" class="btn btn-primary cam-play" hidden>${PLAY_ICON}<span class="cam-play-txt">Assistir ao vivo</span>${sr}</button>` +
      '</div></div>' +
      '<div class="cam-bar">' +
      (credit ? `<span class="cam-credit">${esc(credit)}</span>` : "") +
      '<span class="cam-actions">' +
      `<button type="button" class="btn btn-sm cam-toggle" hidden>Pausar${sr}</button>` +
      `<button type="button" class="btn btn-sm cam-full" hidden>Tela cheia${sr}</button>` +
      "</span></div></article>";
  }).join("");
}
// Colunas da grade no computador: 3 câmeras lado a lado; com 2 ou 4, duas por linha (nenhuma fica sozinha).
function cameraCols(n) { return n <= 1 ? "cols-1" : n === 2 || n === 4 ? "cols-2" : "cols-3"; }

// Origens dos players para o frame-src da página /cameras. Só entra origem https com nome de servidor
// comum: um símbolo como ";" ou "*" mudaria o sentido do cabeçalho de segurança.
const SAFE_ORIGIN = /^https:\/\/[a-z0-9.-]+(:\d+)?$/i;
function frameOrigins(settings) {
  const out = new Set();
  for (const c of settings.cameras.list) {
    try { const o = new URL(c.url).origin; if (SAFE_ORIGIN.test(o)) out.add(o); } catch (e) { /* ignorado */ }
  }
  return [...out];
}

// Nome das fontes da cotação para o visitante: "google+awesomeapi" -> "Google e AwesomeAPI".
const SOURCE_LABELS = Object.fromEntries(SOURCES.map((s) => [s.id, s.label]));
const sourceLabel = (source) => String(source || "").split("+").filter(Boolean).map((id) => SOURCE_LABELS[id] || id).join(" e ");

// Contexto usado por todos os modelos.
function context(settings, fx, opts = {}) {
  const s = settings;
  const full = [s.brand.name1, s.brand.name2].filter(Boolean).join(" ");
  const logoV = s.brand.logo ? hash(s.brand.logo) : "";
  const fxTitle = fx.source === "manual"
    ? "Cotação de referência definida pela equipe do site"
    : String(fx.source).split("+").includes("bonanza")
      ? "Cotação de venda do dólar na Bonanza Cambios (Ciudad del Este), conferida a cada 5 minutos"
      : `Cotação comercial do dólar (fonte: ${sourceLabel(fx.source)}), conferida a cada 5 minutos`;
  return {
    ...s,
    brand: { ...s.brand, full },
    page: { path: opts.path || "/", canonical: "https://" + (opts.host || "www.buscarpy.com") + (opts.path || "/") },
    fx: {
      BRL: fx.BRL, PYG: fx.PYG, at: fx.at || "", source: fx.source,
      brlText: brlText(fx.BRL), pygText: pygText(fx.PYG), title: fxTitle,
    },
    raw: {
      themeLink: opts.server ? `<link rel="stylesheet" href="/theme.css?v=${hash(themeCss(s.brand))}">` : "",
      logoMark: s.brand.logo ? `<img class="logo-img" src="/brand-logo?v=${logoV}" width="30" height="30" alt="">` : LOGO_SVG,
      logoWord: logoWord(s.brand),
      topLinks: topLinks(s.topbar.links, opts.path),
      steps: s.home.steps.map((st) => `<li><h3>${esc(st.title)}</h3><p>${esc(st.text)}</p></li>`).join(""),
      cameraCards: cameraCards(s.cameras.list, s.cameras.credit),
      cameraCols: cameraCols(s.cameras.list.length),
      cameraTips: s.cameras.tips.map((t) => `<li>${esc(t)}</li>`).join(""),
    },
  };
}

function render(view, settings, fx, opts = {}) {
  return fill(readView(view, opts.reload), context(settings, fx, opts), opts.reload);
}

module.exports = { render, themeCss, frameOrigins, sourceLabel, contrast, contrastWithWhite, brlText, pygText, esc, hash, fill, context };
