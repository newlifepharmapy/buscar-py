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
// Os tons derivados que viram texto pequeno são escurecidos aos poucos até ficarem legíveis (4,5:1)
// no fundo mais escuro em que aparecem: a pessoa não edita esses tons no painel, então não há o que avisar.
const MIST = "#f6f5f1", GREEN_100 = "#e4f5eb";
function readableOn(hex, bg, start) {
  for (let i = 0; start + i * 0.04 <= 1; i++) {
    const c = mix(hex, "#000000", start + i * 0.04);
    if (contrast(c, bg) >= 4.5) return c;
  }
  return "#000000";
}
function themeCss(brand) {
  const { primary, accent } = brand;
  const vars = [];
  if (primary !== DEFAULT_BRAND.primary) {
    // --navy-400: links e botões de texto sobre o fundo névoa; --navy-600: fundo do botão sob o mouse, com texto branco
    const link = mix(primary, "#ffffff", 0.2), hover = mix(primary, "#ffffff", 0.08);
    vars.push(`--navy:${primary}`,
      `--navy-600:${contrast(hover, "#ffffff") >= 4.5 ? hover : mix(primary, "#000000", 0.08)}`,
      `--navy-400:${contrast(link, MIST) >= 4.5 ? link : readableOn(primary, MIST, 0)}`,
      `--navy-900:${mix(primary, "#000000", 0.4)}`);
  }
  if (accent !== DEFAULT_BRAND.accent) {
    // --gold-700: texto pequeno em ouro (sobretítulo, categoria, estrelas), no máximo sobre o verde-claro do menor preço
    vars.push(`--gold:${accent}`, `--gold-600:${mix(accent, "#000000", 0.16)}`, `--gold-700:${readableOn(accent, GREEN_100, 0.38)}`,
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
// Logo: o símbolo "b" e, com o nome padrão, o "buscar py" desenhado da identidade. Com outro nome
// (trocado no painel), o nome vai em texto no mesmo estilo.
const LOGO_SVG = `<svg class="logo-mark" viewBox="${BRAND.SYMBOL_VIEWBOX}" aria-hidden="true" focusable="false">${BRAND.SYMBOL}</svg>`;
const WORDMARK_SVG = `<svg class="logo-word" viewBox="${BRAND.WORDMARK_VIEWBOX}" stroke-width="${BRAND.WORDMARK_STROKE}" stroke-linejoin="round" aria-hidden="true" focusable="false">` +
  `<path class="lw-ink" d="${BRAND.WORDMARK_INK}"/><path class="lw-py" d="${BRAND.WORDMARK_PY}"/></svg>`;
function logoWord(brand) {
  if (brand.name1.toLowerCase() === "buscar" && brand.name2.toLowerCase() === "py") return WORDMARK_SVG;
  return `<span class="logo-text"><span>${esc(brand.name1)}</span>${brand.name2 ? ` <span class="logo-py">${esc(brand.name2)}</span>` : ""}</span>`;
}

function topLinks(links, current) {
  return links.map((l) => {
    const ext = l.newTab ? ' target="_blank" rel="noopener"' : "";
    const cur = current && l.url === current ? ' aria-current="page"' : "";
    return `<a class="util-link${l.live ? " is-live" : ""}" href="${esc(l.url)}"${ext}${cur}>${l.live ? LIVE_DOT : ""}${esc(l.label)}</a>`;
  }).join("");
}

// Menu lateral do celular: as categorias do catálogo (lidas uma vez) e, embaixo, os links da barra superior.
// Cada categoria é um link para /?cat=...: fora da página inicial ele abre a categoria; nela, o app.js
// intercepta o toque e só troca a vitrine.
// BUSCA_CATALOG: outro catálogo (a demonstração estática usa um só com os produtos de exemplo)
const CATALOG = process.env.BUSCA_CATALOG || path.join(__dirname, "..", "public", "data", "catalog.json");
let catalog = null;
function readCatalog() {
  if (!catalog) {
    try { catalog = JSON.parse(fs.readFileSync(CATALOG, "utf8")); } catch (e) { catalog = {}; }
  }
  return catalog;
}
let categories = null;
function catalogCategories() {
  if (!categories) categories = (readCatalog().categories || []).map((c) => ({ id: String(c.id), name: String(c.name) }));
  return categories;
}
// Lojas reais (com logo, do diretório do Compras Paraguai): primeiro as que têm produtos aqui, da que tem
// mais para a que tem menos; depois as outras, em ordem alfabética.
let stores = null;
function catalogStores() {
  if (!stores) {
    const cat = readCatalog(), count = new Map();
    for (const p of cat.products || []) for (const o of p.offers || []) count.set(o.store, (count.get(o.store) || 0) + 1);
    stores = (cat.stores || []).filter((st) => st.real && st.logo)
      .map((st) => ({ ...st, products: count.get(st.id) || 0 }))
      .sort((a, b) => b.products - a.products || a.name.localeCompare(b.name, "pt-BR"));
  }
  return stores;
}
const storesWithProducts = () => catalogStores().filter((st) => st.products);
// Números da página inicial já no HTML (o app.js recalcula do mesmo jeito: só as lojas com ofertas contam)
let stats = null;
function catalogStats() {
  if (!stats) {
    const cat = readCatalog(), products = cat.products || [], sellers = new Set(), cities = new Set();
    for (const p of products) for (const o of p.offers || []) sellers.add(o.store);
    const list = (cat.stores || []).filter((st) => sellers.has(st.id));
    for (const st of list) for (const c of st.cities && st.cities.length ? st.cities : st.city ? [st.city] : []) cities.add(c);
    const n = (k) => k.toLocaleString("pt-BR");
    stats = { products: n(products.length), offers: n(products.reduce((a, p) => a + (p.offers || []).length, 0)), stores: n(list.length), cities: n(cities.size) };
  }
  return stats;
}
const logoImg = (st, w, h, lazy = true) => `<img src="/${esc(String(st.logo).replace(/^\/+/, ""))}" alt="${esc(st.name)}" width="${w}" height="${h}"${lazy ? ' loading="lazy"' : ""} decoding="async">`;
// Faixa de logos na página inicial (como a do Compras Paraguai): cada logo mostra os produtos daquela loja.
// Carrossel numa fileira só, andando da direita para a esquerda: a lista vai duas vezes seguidas e a animação
// desliza exatamente uma lista (a segunda cópia fica escondida dos leitores de tela e do Tab).
const PAUSE_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><path class="i-pause" d="M8 5v14M16 5v14" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/><path class="i-play" d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>';
function storeStrip(brand, max = 24) {
  // como a faixa "Lojas Premium" do Compras Paraguai: as premium primeiro, entre as que têm produtos aqui
  const list = storesWithProducts().sort((a, b) => (b.premium ? 1 : 0) - (a.premium ? 1 : 0)).slice(0, max);
  if (!list.length) return "";
  const items = (copy) => list.map((st) => `<li><a class="strip-logo" href="/?loja=${encodeURIComponent(st.id)}" title="Ver os produtos da ${esc(st.name)}"${copy ? ' tabindex="-1"' : ""}>${logoImg(st, 120, 60, false)}</a></li>`).join("");
  return `<section class="stores-strip" id="storesStrip" aria-labelledby="stripTitle"><div class="container">
    <div class="strip-head"><h2 id="stripTitle">Lojas no ${esc(brand)}</h2><div class="strip-tools">
      <button type="button" class="strip-pause" id="stripPause" hidden>${PAUSE_ICON}<span>Pausar</span></button>
      <a class="strip-all" href="/lojas">Ver todas as lojas${CHEVRON.replace("drawer-chev", "strip-chev")}</a></div></div>
    <div class="strip-view"><div class="strip-track">
      <ul class="strip" role="list">${items(false)}</ul><ul class="strip strip-copy" role="list" aria-hidden="true">${items(true)}</ul>
    </div></div>
  </div></section>`;
}
// Rodapé: as lojas com mais produtos e o link para todas
function footStores(max = 6) {
  const list = storesWithProducts().slice(0, max);
  if (!list.length) return "";
  const items = list.map((st) => `<li><a href="/?loja=${encodeURIComponent(st.id)}">${esc(st.name)}</a></li>`).join("");
  return `<div class="foot-stores"><h3>Lojas</h3><ul>${items}<li><a href="/lojas">Todas as lojas</a></li></ul></div>`;
}
// De onde vêm os dados (rodapé). Os produtos de exemplo continuam com lojas e preços inventados.
const ABO = '<a href="https://amazon-berkeley-objects.s3.amazonaws.com/index.html" target="_blank" rel="noopener">Amazon Berkeley Objects</a> (CC BY 4.0)';
function dataNote() {
  const cat = readCatalog(), date = importDate();
  const real = (cat.products || []).some((p) => p.source === "comprasparaguai");
  if (!real) return `Versão de demonstração: imagens e nomes de produtos do ${ABO}. Lojas, preços e histórico são fictícios.`;
  return `Produtos importados, lojas e preços: <a href="https://www.comprasparaguai.com.br/" target="_blank" rel="noopener">Compras Paraguai</a>, consultados em ${date}. ` +
    `Os demais produtos são exemplos, com imagens e nomes do ${ABO} e lojas, preços e histórico fictícios.`;
}
// Data da leitura das lojas reais ("2026-10-28" -> "28/10/2026")
function importDate() {
  const d = (readCatalog().imported || {}).date || "";
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d.slice(8, 10) + "/" + d.slice(5, 7) + "/" + d.slice(0, 4) : "";
}
// sem acento e em minúsculas, para o filtro da página /lojas ("Visãovip" acha com "visao")
const fold = (t) => String(t).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
// Tipos de loja para o filtro de /lojas, do mais comum para o menos comum
function storeSpecs() {
  const n = new Map();
  for (const st of catalogStores()) if (st.specialty) n.set(st.specialty, (n.get(st.specialty) || 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "pt-BR"))
    .map(([sp, k]) => `<option value="${esc(sp)}">${esc(sp)} (${k})</option>`).join("");
}
function storesIntro(full) {
  const n = catalogStores().length, m = storesWithProducts().length;
  const many = (k) => `${k} ${k === 1 ? "loja" : "lojas"}`;
  if (!n) return `As lojas do Paraguai com preços no ${full} vão aparecer aqui.`;
  return n === m ? `${many(n)} do Paraguai com preços no ${full}. Escolha uma loja para ver os produtos dela.`
    : `${many(n)} do Paraguai, ${m} delas já com preços no ${full}. Escolha uma loja para ver os produtos dela.`;
}
// Página /lojas: um cartão por loja com logo, especialidade, horário e os botões.
function storeCards(brand) {
  return catalogStores().map((st) => {
    const cities = (st.cities && st.cities.length ? st.cities : [st.city]).filter(Boolean);
    const meta = [st.specialty, cities.join(", ")].filter(Boolean).map(esc).join(" · ");
    const site = /^https?:\/\/[^\s"<>]+$/.test(st.website || "") ? `<a class="btn btn-sm btn-ghost" href="${esc(st.website)}" target="_blank" rel="noopener nofollow">Site da loja<span class="sr-only"> ${esc(st.name)} (abre em outra aba)</span></a>` : "";
    return `<li class="store-card" id="${esc(st.id)}" data-name="${esc(fold(st.name))}" data-spec="${esc(st.specialty || "")}"${st.products ? " data-has" : ""}>
      <div class="store-card-logo">${logoImg(st, 140, 70)}</div>
      <div class="store-card-body">
        <h2>${esc(st.name)}</h2>
        ${meta ? `<p class="store-card-meta">${meta}</p>` : ""}
        ${st.hours ? `<p class="store-card-hours">${esc(st.hours)}</p>` : ""}
        ${st.products ? `<p class="store-card-count">${st.products} ${st.products === 1 ? "produto" : "produtos"} no ${esc(brand)}</p>` : ""}
      </div>
      <div class="store-card-actions">${st.products ? `<a class="btn btn-sm btn-primary" href="/?loja=${encodeURIComponent(st.id)}">Ver produtos<span class="sr-only"> da ${esc(st.name)}</span></a>` : ""}${site}</div>
    </li>`;
  }).join("");
}
const CHEVRON = '<svg class="drawer-chev" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
function catMenu(current) {
  const all = [{ id: "", name: "Todas as categorias" }, ...catalogCategories()];
  return all.map((c) => {
    const href = c.id ? `/?cat=${encodeURIComponent(c.id)}` : "/";
    const cur = current === "/" && !c.id ? ' aria-current="true"' : "";
    return `<li><a class="drawer-item" href="${esc(href)}" data-cat="${esc(c.id)}"${cur}><span>${esc(c.name)}</span>${CHEVRON}</a></li>`;
  }).join("");
}
function menuLinks(links, current) {
  if (!links.length) return "";
  const items = links.map((l) => {
    const ext = l.newTab ? ' target="_blank" rel="noopener"' : "";
    const cur = current && l.url === current ? ' aria-current="page"' : "";
    return `<li><a class="drawer-item drawer-link" href="${esc(l.url)}"${ext}${cur}>${l.live ? LIVE_DOT : ""}<span>${esc(l.label)}</span>${CHEVRON}</a></li>`;
  }).join("");
  return `<nav class="drawer-sec" aria-labelledby="menuLinksTitle"><h2 class="drawer-title" id="menuLinksTitle">Atalhos</h2><ul class="drawer-list">${items}</ul></nav>`;
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
  // a página /lojas entra nos atalhos sozinha quando há lojas reais (e o painel ainda não tem esse link)
  const links = opts.server && catalogStores().length && !s.topbar.links.some((l) => l.url === "/lojas")
    ? [...s.topbar.links, { label: "Lojas", url: "/lojas", live: false, newTab: false }] : s.topbar.links;
  const fxTitle = fx.source === "manual"
    ? "Cotação de referência definida pela equipe do site"
    : String(fx.source).split("+").includes("bonanza")
      ? "Cotação de venda do dólar na Bonanza Cambios, filial Jebai (Ciudad del Este), conferida a cada 5 minutos"
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
      topLinks: topLinks(links, opts.path),
      catMenu: catMenu(opts.path || "/"),
      menuLinks: menuLinks(links, opts.path),
      steps: s.home.steps.map((st) => `<li><h3>${esc(st.title)}</h3><p>${esc(st.text)}</p></li>`).join(""),
      cameraCards: cameraCards(s.cameras.list, s.cameras.credit),
      cameraCols: cameraCols(s.cameras.list.length),
      cameraTips: s.cameras.tips.map((t) => `<li>${esc(t)}</li>`).join(""),
      // a demonstração estática não serve as logos das lojas (elas vêm pelo servidor)
      storeStrip: opts.server ? storeStrip(full) : "",
      storeCards: storeCards(full),
      storeSpecs: storeSpecs(),
      storesEmpty: catalogStores().length ? "" : '<p class="cams-empty">Nenhuma loja cadastrada no momento.</p>',
      footStores: footStores(),
      dataNote: dataNote(),
    },
    stats: catalogStats(),
    lojas: {
      count: catalogStores().length,
      intro: storesIntro(full),
      note: `Lojas, logos e horários consultados${importDate() ? " em " + importDate() : ""} no Compras Paraguai. Horários e preços podem mudar: confirme com a loja antes de ir.`,
      disclaimer: `O ${full} não é dono nem representante das lojas listadas.`,
    },
  };
}

function render(view, settings, fx, opts = {}) {
  return fill(readView(view, opts.reload), context(settings, fx, opts), opts.reload);
}

module.exports = { render, themeCss, frameOrigins, sourceLabel, contrast, contrastWithWhite, brlText, pygText, esc, hash, fill, context };
