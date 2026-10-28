/* Buscar PY — interface do comparador. Depende de tf (TensorFlow.js), BuscaVision e BuscaText. */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const DIM = 1280;
  const PAGE = 24;
  const SAVE_MIN = 0.10; // abaixo de 10% de diferença entre lojas, a economia não aparece no card

  const S = {
    cat: null, text: "", cities: new Set(), stores: new Set(), pmin: null, pmax: null, stock: true,
    sort: "rel", shown: PAGE,
    img: null,        // {deep, color} da consulta atual
    imgScores: null,  // Float32Array com a similaridade de cada produto
    guessCat: null,   // categoria escolhida nos chips "Parece ser"
    colorW: 0.10, minSim: 0.25,
  };
  let D, E, C, textIndex, storeById, catById, model = null, modelLoading = null;
  let queryId = 0;  // invalida análises de imagem antigas quando o usuário muda de ideia

  const fmtUsd = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtBrl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
  const fmtInt = new Intl.NumberFormat("pt-BR");
  const fmtPyg = new Intl.NumberFormat("es-PY", { maximumFractionDigits: 0 });
  const usd = (v) => "US$ " + fmtUsd.format(v);
  // símbolo da moeda com a bandeira na frente (a bandeira é enfeite: o símbolo já diz a moeda)
  const cur = (flag, sym) => `<span class="cur"><span class="flag flag-${flag}" aria-hidden="true"></span>${sym}</span>`;
  const brl = (v) => fmtBrl.format(v * D.rates.BRL);
  const pygNum = (v) => fmtPyg.format(Math.round(v * D.rates.PYG / 100) * 100);
  const pyg = (v) => "₲ " + pygNum(v);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const plural = (n, one, many) => `${fmtInt.format(n)} ${n === 1 ? one : many}`;
  // Similaridade bruta para uma porcentagem legível. No catálogo, o cosseno fica em ~0,47 entre produtos sem
  // relação, ~0,67 no 10º mais parecido e ~0,80 no mais parecido; acima de 0,80 já é o mesmo modelo (100%).
  const simPct = (s) => Math.max(0, Math.min(1, (s - 0.45) / 0.35));
  const headerH = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--header-h")) || 0;
  const reduceMotion = () => { try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { return false; } };
  const CAM_ICON = '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" d="M4 8h3l1.6-2.4h6.8L17 8h3v11H4z"/><circle cx="12" cy="13.2" r="3.4" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
  const X_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';

  // Arquivos binários (vetores e pesos do modelo). Em hospedagens que só servem texto,
  // o build publica cada um como base64 em "<arquivo>.b64.txt" e define window.BUSCA_B64 = true.
  async function fetchBin(path) {
    if (!window.BUSCA_B64) return fetch(path).then((r) => { if (!r.ok) throw new Error(path); return r.arrayBuffer(); });
    const txt = await fetch(path + ".b64.txt").then((r) => { if (!r.ok) throw new Error(path); return r.text(); });
    const bin = atob(txt.trim());
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }

  async function loadGraph(dir) {
    const mj = await fetch(dir + "/model.json").then((r) => r.json());
    const specs = [], parts = [];
    for (const g of mj.weightsManifest) {
      specs.push(...g.weights);
      for (const p of g.paths) parts.push(await fetchBin(dir + "/" + p));
    }
    const total = parts.reduce((a, b) => a + b.byteLength, 0);
    const data = new Uint8Array(total);
    let o = 0;
    for (const b of parts) { data.set(new Uint8Array(b), o); o += b.byteLength; }
    return tf.loadGraphModel(tf.io.fromMemory({ modelTopology: mj.modelTopology, weightSpecs: specs, weightData: data.buffer }));
  }

  async function boot() {
    const [cat, emb, col] = await Promise.all([
      fetch("data/catalog.json").then((r) => r.json()),
      fetchBin("data/embeddings.bin"),
      fetchBin("data/colors.bin"),
    ]);
    D = cat; E = new Float32Array(emb); C = new Float32Array(col);
    // cotação: a da página (atualizada pelo servidor a cada 5 minutos) vale mais que a do catálogo
    if (window.BuscaFx) {
      const fx = BuscaFx.get();
      if (fx.BRL > 0 && fx.PYG > 0) D.rates = { ...D.rates, BRL: fx.BRL, PYG: fx.PYG };
      BuscaFx.onChange((n) => { D.rates = { ...D.rates, BRL: n.BRL, PYG: n.PYG }; refreshCardPrices(); refreshProductPrices(); });
    }
    storeById = Object.fromEntries(D.stores.map((s) => [s.id, s]));
    catById = Object.fromEntries(D.categories.map((c) => [c.id, c]));
    for (const p of D.products) {
      const avail = p.offers.filter((o) => o.in_stock);
      p.best = (avail[0] || p.offers[0]).price;
    }
    textIndex = BuscaText.buildIndex(D.products.map((p) => ({
      id: p.id,
      fields: [
        { text: p.name, weight: 1 }, { text: p.brand, weight: 1 }, { text: p.color, weight: 0.9 },
        { text: catById[p.category].name, weight: 1.5 },
        { text: p.offers.map((o) => storeById[o.store].name).join(" "), weight: 0.5 },
      ],
    })));
    const cities = [...new Set(D.stores.map((s) => s.city))];
    $("stProducts").textContent = fmtInt.format(D.products.length);
    $("stOffers").textContent = fmtInt.format(D.products.reduce((a, p) => a + p.offers.length, 0));
    $("stStores").textContent = fmtInt.format(D.stores.length);
    $("stCities").textContent = fmtInt.format(cities.length);
    $("footCities").innerHTML = cities.map((c) => `<li><button type="button" data-city="${esc(c)}">${esc(c)}</button></li>`).join("");
    $("footCats").innerHTML = D.categories.map((c) => `<li><button type="button" data-cat="${c.id}">${esc(c.name)}</button></li>`).join("");
    // busca ou categoria vinda de outra página (ex.: /cameras ou o menu lateral) pelo endereço /?q=... ou /?cat=...
    const params = new URLSearchParams(location.search);
    const q0 = params.get("q"), c0 = params.get("cat");
    if (c0 && catById[c0]) S.cat = c0;
    buildCatbar(); buildFilters(cities); wire();
    if (q0 && q0.trim()) { S.text = q0.trim().slice(0, 100); $("q").value = S.text; }
    if (window.BuscaMenu) BuscaMenu.setCurrent(S.cat);
    render();
    if (S.cat) { const b = $("catbar").querySelector('[aria-pressed="true"]'); if (b) centerCat(b); }
    if (S.text || S.cat) scrollToEl($("resultados"));
    const m = /^#p(\d+)$/.exec(location.hash);
    if (m && D.products[+m[1]]) openProduct(+m[1]);
  }

  /* ---------- Cabeçalho fixo ---------- */
  function trackHeader() {
    const h = document.querySelector(".header");
    const set = () => document.documentElement.style.setProperty("--header-h", h.offsetHeight + "px");
    set();
    if (window.ResizeObserver) new ResizeObserver(set).observe(h); else window.addEventListener("resize", set);
  }
  function scrollToEl(el) { el.scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth", block: "start" }); }

  /* ---------- Categorias ---------- */
  function buildCatbar() {
    const all = [{ id: null, name: "Todas as categorias" }, ...D.categories];
    $("catbar").innerHTML = all.map((c) => `<button type="button" data-cat="${c.id || ""}" aria-pressed="${S.cat === c.id}">${esc(c.name)}</button>`).join("");
    updateCatArrows();
  }
  function updateCatArrows() {
    const t = $("catbar");
    const left = t.scrollLeft > 4, right = t.scrollLeft + t.clientWidth < t.scrollWidth - 4;
    t.classList.toggle("fade-l", left); t.classList.toggle("fade-r", right);
    $("catPrev").hidden = !left; $("catNext").hidden = !right;
  }
  function setCat(id, keepGuess) {
    S.cat = id || null; S.shown = PAGE;
    if (!keepGuess) clearGuess();
    let active;
    $("catbar").querySelectorAll("button").forEach((x) => {
      const on = (x.dataset.cat || null) === S.cat;
      x.setAttribute("aria-pressed", String(on));
      if (on) active = x;
    });
    if (active) centerCat(active);
    if (window.BuscaMenu) BuscaMenu.setCurrent(S.cat);
    render();
  }
  // Rola só a barra de categorias (nunca a página) para deixar o botão no meio
  function centerCat(btn) {
    const t = $("catbar"), tr = t.getBoundingClientRect(), br = btn.getBoundingClientRect();
    t.scrollTo({ left: Math.max(0, t.scrollLeft + br.left - tr.left - (tr.width - br.width) / 2), behavior: reduceMotion() ? "auto" : "smooth" });
  }
  // Garante que o botão com foco não fique escondido sob o degradê das bordas
  function revealCat(btn) {
    const t = $("catbar"), tr = t.getBoundingClientRect(), br = btn.getBoundingClientRect(), pad = 64;
    if (br.left < tr.left + pad) t.scrollLeft -= tr.left + pad - br.left;
    else if (br.right > tr.right - pad) t.scrollLeft += br.right - (tr.right - pad);
  }
  function resetCatbar() {
    S.cat = null;
    $("catbar").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(!x.dataset.cat)));
    $("catbar").scrollLeft = 0; updateCatArrows();
    if (window.BuscaMenu) BuscaMenu.setCurrent(null);
  }
  function clearGuess() {
    S.guessCat = null;
    $("guessChips").querySelectorAll(".chip").forEach((x) => x.setAttribute("aria-pressed", "false"));
  }

  /* ---------- Filtros ---------- */
  function buildFilters(cities) {
    $("fCity").innerHTML = cities.map((c) => `<label class="check"><input type="checkbox" value="${esc(c)}"> ${esc(c)}</label>`).join("");
    const FEW = 6;
    $("fStore").innerHTML = D.stores.map((s, i) => `<label class="check${i >= FEW ? " extra" : ""}"><input type="checkbox" value="${s.id}"> ${esc(s.name)}</label>`).join("");
    const more = $("fStoreMore");
    more.hidden = D.stores.length <= FEW;
    const label = () => (more.textContent = more.getAttribute("aria-expanded") === "true" ? "Ver menos lojas" : `Ver todas as lojas (${D.stores.length})`);
    label();
    more.onclick = () => {
      const open = more.getAttribute("aria-expanded") !== "true";
      more.setAttribute("aria-expanded", String(open)); $("fStore").classList.toggle("all", open); label();
    };
    $("fCity").onchange = (e) => { toggle(S.cities, e.target.value, e.target.checked); render(); };
    $("fStore").onchange = (e) => { toggle(S.stores, e.target.value, e.target.checked); render(); };
  }
  function toggle(set, v, on) { on ? set.add(v) : set.delete(v); S.shown = PAGE; }
  function syncFilterInputs() {
    $("fCity").querySelectorAll("input").forEach((c) => (c.checked = S.cities.has(c.value)));
    $("fStore").querySelectorAll("input").forEach((c) => (c.checked = S.stores.has(c.value)));
    $("fStock").checked = S.stock;
    $("pmin").value = S.pmin == null ? "" : S.pmin;
    $("pmax").value = S.pmax == null ? "" : S.pmax;
  }
  function resetFilters() {
    S.cities.clear(); S.stores.clear(); S.pmin = S.pmax = null; S.stock = true; S.shown = PAGE;
    syncFilterInputs();
  }
  // "Limpar filtros" e "Limpar tudo": numa busca, a categoria também é um filtro
  function clearAllFilters() {
    resetFilters();
    if (S.text || S.imgScores) S.cat = null;
    setCat(S.cat);
  }

  // Ofertas de um produto que passam nos filtros de loja/cidade/estoque
  function offersFor(p) {
    return p.offers.filter((o) => {
      const st = storeById[o.store];
      if (S.stock && !o.in_stock) return false;
      if (S.stores.size && !S.stores.has(o.store)) return false;
      if (S.cities.size && !S.cities.has(st.city)) return false;
      return true;
    });
  }

  function renderActiveFilters() {
    const chips = [];
    if (S.cat && (S.text || S.imgScores)) chips.push(["cat", "", `Categoria: ${catById[S.cat].name}`]);
    for (const c of S.cities) chips.push(["city", c, `Cidade: ${c}`]);
    for (const s of S.stores) chips.push(["store", s, `Loja: ${storeById[s].name}`]);
    if (S.pmin != null || S.pmax != null) {
      const txt = S.pmin != null && S.pmax != null ? `US$ ${S.pmin} a ${S.pmax}` : S.pmin != null ? `a partir de US$ ${S.pmin}` : `até US$ ${S.pmax}`;
      chips.push(["price", "", `Preço: ${txt}`]);
    }
    if (!S.stock) chips.push(["stock", "", "Incluindo lojas sem estoque"]);
    const box = $("activeFilters");
    box.hidden = !chips.length;
    box.innerHTML = chips.map(([k, v, label]) => `<button type="button" class="fchip" data-k="${k}" data-v="${esc(v)}" aria-label="Remover filtro ${esc(label)}">${esc(label)}<span class="x">${X_ICON}</span></button>`).join("")
      + (chips.length > 1 ? '<button type="button" class="fchip-clear" data-k="all">Limpar tudo</button>' : "");
  }

  /* ---------- Resultados ---------- */
  function compute() {
    const textScores = S.text ? BuscaText.search(textIndex, S.text) : null;
    const rows = [];
    for (const p of D.products) {
      if (S.cat && p.category !== S.cat) continue;
      if (S.guessCat && p.category !== S.guessCat) continue;
      if (textScores && !textScores.has(p.id)) continue;
      let sim = null;
      if (S.imgScores) {
        sim = S.imgScores[p.id];
        if (simPct(sim) < S.minSim) continue;
      }
      const offers = offersFor(p);
      if (!offers.length) continue;
      const best = offers[0].price, worst = offers[offers.length - 1].price;
      if (S.pmin != null && best < S.pmin) continue;
      if (S.pmax != null && best > S.pmax) continue;
      const save = offers.length > 1 ? (worst - best) / worst : 0;
      rows.push({ p, offers, best, save, saveAmt: worst - best, sim, ts: textScores ? textScores.get(p.id) : 0 });
    }
    const by = {
      rel: S.imgScores ? (a, b) => b.sim - a.sim : S.text ? (a, b) => b.ts - a.ts || a.best - b.best : (a, b) => b.save - a.save,
      price: (a, b) => a.best - b.best,
      "price-desc": (a, b) => b.best - a.best,
      save: (a, b) => b.save - a.save,
      stores: (a, b) => b.offers.length - a.offers.length || a.best - b.best,
    }[S.sort];
    return rows.sort(by);
  }

  function cardHtml(r, small) {
    const p = r.p;
    let badge = "";
    if (r.sim != null) badge = `<span class="badge-sim">${Math.round(simPct(r.sim) * 100)}% parecido</span>`;
    const save = !small && r.save >= SAVE_MIN
      // no celular o cartão é estreito: o selo mostra só a porcentagem para caber numa linha
      ? `<span class="save" title="Diferença entre a loja mais cara e a mais barata"><span class="save-long">Economize ${usd(r.saveAmt)} (${Math.round(r.save * 100)}%)</span><span class="save-short">Economize ${Math.round(r.save * 100)}%</span></span>` : "";
    const simBtn = small ? "" : `<button type="button" class="sim-btn" data-sim="${p.id}" title="Buscar parecidos" aria-label="Buscar produtos parecidos com ${esc(p.name)}">${CAM_ICON}</button>`;
    const store = storeById[r.offers[0].store];
    return `<article class="card" data-id="${p.id}" data-best="${r.best}">
      <div class="thumb"><img loading="lazy" src="${p.image}" alt=""></div>
      ${badge}${simBtn}
      <div class="body">
        ${small ? "" : `<span class="cat">${esc(catById[p.category].name)}</span>`}
        <a class="card-link name" href="#p${p.id}" data-open="${p.id}">${esc(p.name)}</a>
        <span class="from">a partir de</span>
        <span class="usd">${usd(r.best)}</span>
        ${save}
        ${small ? "" : `<span class="conv">${brl(r.best)} · ${pyg(r.best)}</span>
        <span class="where"><span>em <b>${esc(store.name)}</b></span><span class="n">${plural(r.offers.length, "loja", "lojas")}</span></span>`}
      </div>
    </article>`;
  }

  function isHome() { return !S.text && !S.cat && !S.imgScores; }

  function render() {
    const rows = compute();
    const home = isHome();
    $("hero").hidden = !(home && $("imgPanel").hidden);
    $("how").hidden = !home;
    let title = "Ofertas em destaque", crumb = "";
    const where = S.cities.size === 1 ? ` em ${[...S.cities][0]}` : "";
    if (S.imgScores) { title = "Produtos parecidos com a sua foto"; crumb = "Busca por foto"; }
    else if (S.text) { title = `Resultados para “${S.text}”`; crumb = "Busca"; }
    else if (S.cat) { title = catById[S.cat].name + where; crumb = "Categorias"; }
    else if (where) { title = "Ofertas" + where; }
    $("resTitle").textContent = title;
    $("crumbs").innerHTML = crumb || where ? `<button type="button" data-home>Início</button><span aria-hidden="true">›</span>${esc(crumb || "Cidades")}` : "";
    const nOff = rows.reduce((a, r) => a + r.offers.length, 0);
    $("resSub").textContent = rows.length
      ? `${plural(rows.length, "produto", "produtos")} · ${plural(nOff, "oferta", "ofertas")}${home && S.sort === "rel" ? " · maior economia entre lojas primeiro" : ""}`
      : "";
    $("sort").options[0].textContent = S.imgScores ? "Semelhança" : "Relevância";
    renderActiveFilters();
    const grid = $("grid");
    if (!rows.length) {
      let tip = "Tente outra palavra (aceita português e espanhol) ou remova algum filtro.";
      let action = "";
      if (S.imgScores) tip = "Diminua a semelhança mínima ou o peso da cor, ou marque só o produto na foto.";
      if ((S.cat || S.guessCat) && (S.text || S.imgScores)) {
        tip = `Nada encontrado em ${catById[S.cat || S.guessCat].name}.`;
        action = '<button type="button" class="btn btn-primary" data-allcats>Buscar em todas as categorias</button>';
      }
      grid.innerHTML = `<div class="empty"><b>Nenhum produto encontrado</b><p>${esc(tip)}</p>${action}</div>`;
    } else {
      grid.innerHTML = rows.slice(0, S.shown).map((r) => cardHtml(r)).join("");
    }
    $("moreWrap").hidden = rows.length <= S.shown;
    const see = $("seeResults");
    see.hidden = !S.imgScores || !rows.length;
    see.textContent = `Ver ${plural(rows.length, "produto parecido", "produtos parecidos")}`;
  }

  function goHome() {
    closePanel(true);
    S.text = ""; $("q").value = "";
    resetFilters();
    S.sort = "rel"; $("sort").value = "rel";
    setCat(null);
    $("catbar").scrollLeft = 0; updateCatArrows();
    window.scrollTo({ top: 0 });
  }

  /* ---------- Detalhe do produto ---------- */
  function openProduct(id) {
    const p = D.products[id];
    $("pdImg").src = p.image;
    $("pdImg").alt = p.name;
    $("pdCat").textContent = catById[p.category].name;
    $("pdName").textContent = p.name;
    $("pdBrand").textContent = [p.brand, p.color].filter(Boolean).join(" · ");
    renderProductPrices(p);
    const sims = rankByVector(E.subarray(id * DIM, (id + 1) * DIM), C.subarray(id * BuscaVision.COLOR_DIM, (id + 1) * BuscaVision.COLOR_DIM), S.colorW);
    const top = [...D.products.keys()].filter((i) => i !== id).sort((a, b) => sims[b] - sims[a]).slice(0, 10);
    $("pdSim").innerHTML = top.map((i) => {
      const q = D.products[i];
      const offs = q.offers.filter((o) => o.in_stock);
      return cardHtml({ p: q, offers: offs.length ? offs : q.offers, best: q.best, save: 0, sim: sims[i] }, true);
    }).join("");
    $("pdSimilar").onclick = () => { $("pdlg").close(); searchSimilar(id); };
    const dlg = $("pdlg");
    const wasOpen = dlg.open;
    if (!wasOpen) dlg.showModal();
    dlg.scrollTop = 0;
    dlg.dataset.id = id;
    drawChart();
    if (wasOpen) $("pdName").focus({ preventScroll: true });
    try { history.replaceState(null, "", "#p" + id); } catch (e) { /* ignorado */ }
  }

  // Menor preço e tabela de lojas (refeitos também quando a cotação do dólar muda)
  function renderProductPrices(p) {
    const inStock = p.offers.filter((o) => o.in_stock);
    const best = inStock[0] || p.offers[0];
    const bst = storeById[best.store];
    $("pdBest").innerHTML = `<small>Menor preço em <b>${esc(bst.name)}</b> · ${esc(bst.city)}</small>
      <span class="usd">${usd(best.price)}</span><span class="conv">${brl(best.price)} · ${pyg(best.price)}</span>`;
    $("pdTable").innerHTML = `<thead><tr><th>Loja</th><th>Situação</th><th class="num">${cur("us", "US$")}</th><th class="num">${cur("br", "R$")}</th><th class="num">${cur("py", "₲")}</th></tr></thead><tbody>` +
      [...inStock, ...p.offers.filter((o) => !o.in_stock)].map((o) => {
        const st = storeById[o.store];
        const isBest = o === best;
        const upd = o.updated_days_ago === 0 ? "hoje" : `há ${plural(o.updated_days_ago, "dia", "dias")}`;
        const pill = o.in_stock ? (isBest ? '<span class="pill pill-best">Melhor preço</span>' : '<span class="pill pill-ok">Em estoque</span>') : '<span class="pill pill-out">Sem estoque</span>';
        return `<tr class="${isBest ? "best" : o.in_stock ? "" : "out"}">
          <td><div class="store-name">${esc(st.name)}</div><div class="store-meta">${esc(st.city)} · <span class="stars">★ ${st.rating.toFixed(1).replace(".", ",")}</span></div><div class="mob store-meta">atualizado ${upd}</div></td>
          <td>${pill}<div class="store-meta">atualizado ${upd}</div></td>
          <td class="num main">${fmtUsd.format(o.price)}<div class="mob store-meta">${brl(o.price)} · ${pyg(o.price)}</div><div class="mob">${pill}</div></td>
          <td class="num">${fmtBrl.format(o.price * D.rates.BRL).replace(/R\$\s?/, "")}</td><td class="num">${pygNum(o.price)}</td>
        </tr>`;
      }).join("") + "</tbody>";
  }
  // Cotação nova: troca só os valores em R$ e ₲ (sem redesenhar a vitrine, para não perder o foco do teclado)
  function refreshCardPrices() {
    document.querySelectorAll(".card[data-best] .conv").forEach((el) => {
      const v = +el.closest(".card").dataset.best;
      el.textContent = `${brl(v)} · ${pyg(v)}`;
    });
  }
  function refreshProductPrices() {
    const dlg = $("pdlg");
    if (!dlg.open) return;
    const p = D.products[+dlg.dataset.id];
    renderProductPrices(p);
    // os cards de parecidos mostram só US$; nada a refazer neles
  }

  function drawChart() {
    const dlg = $("pdlg");
    if (!dlg.open) return;
    const p = D.products[+dlg.dataset.id];
    const box = $("pdChart");
    box.innerHTML = sparkline(p.history, Math.max(260, box.clientWidth || 600));
  }

  // Desenhado na largura real do contêiner (1 unidade = 1 pixel), então o texto mantém o tamanho.
  function sparkline(h, W) {
    const narrow = W < 480;
    const H = narrow ? 150 : 180, L = 54, R = 12, T = 14, B = 28;
    const min = Math.min(...h), max = Math.max(...h);
    const pad = (max - min) * 0.15 || 1;
    const lo = min - pad, hi = max + pad;
    const x = (i) => L + (i / (h.length - 1)) * (W - L - R);
    const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
    const pts = h.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    const ticks = [max, (max + min) / 2, min];
    const last = h[h.length - 1];
    const iMin = h.indexOf(min);
    const todayIsMin = iMin === h.length - 1;
    const dots = todayIsMin
      ? `<circle class="c-min" cx="${x(iMin).toFixed(1)}" cy="${y(min).toFixed(1)}" r="5.5" stroke-width="2"/>`
      : `<circle class="c-today" cx="${x(h.length - 1).toFixed(1)}" cy="${y(last).toFixed(1)}" r="5" stroke-width="2"/>
         <circle class="c-min" cx="${x(iMin).toFixed(1)}" cy="${y(min).toFixed(1)}" r="5" stroke-width="2"/>`;
    const caption = todayIsMin
      ? `<span class="low-pill">Hoje é o menor preço das últimas 26 semanas</span>`
      : `<p class="hint">Ponto verde: menor preço do período (${usd(min)}). Ponto azul-escuro: preço de hoje.</p>`;
    return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Histórico do menor preço: de ${usd(h[0])} há 26 semanas para ${usd(last)} hoje; mínimo de ${usd(min)}">
      ${ticks.map((t) => `<line class="c-grid" x1="${L}" x2="${W - R}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}" stroke-width="1"/><text x="${L - 8}" y="${(y(t) + 4).toFixed(1)}" text-anchor="end">${fmtUsd.format(t)}</text>`).join("")}
      <polygon class="c-area" points="${x(0)},${H - B} ${pts} ${x(h.length - 1)},${H - B}"/>
      <polyline class="c-line" points="${pts}" fill="none" stroke-width="2.2" stroke-linejoin="round"/>
      ${dots}
      <text x="${L}" y="${H - 6}">${narrow ? "26 sem. atrás" : "26 semanas atrás"}</text>
      <text x="${W - R}" y="${H - 6}" text-anchor="end">hoje · ${usd(last)}</text>
    </svg>${caption}`;
  }

  /* ---------- Busca por imagem ---------- */
  function rankByVector(deep, color, w) {
    const n = D.products.length, cd = BuscaVision.COLOR_DIM;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let d = 0;
      const off = i * DIM;
      for (let k = 0; k < DIM; k++) d += deep[k] * E[off + k];
      const c = BuscaVision.histIntersection(color, C.subarray(i * cd, (i + 1) * cd));
      // a cor entra na mesma escala do cosseno (0,45 a 1) para o controle ser intuitivo
      out[i] = (1 - w) * d + w * (0.45 + 0.55 * c);
    }
    return out;
  }

  function setStatus(msg, busy) { const s = $("imgStatus"); s.textContent = msg; s.classList.toggle("busy", !!busy); }

  function loadModel() {
    if (model) return Promise.resolve(model);
    if (!modelLoading) {
      modelLoading = loadGraph("model").then((m) => {
        model = m;
        tf.tidy(() => m.execute(tf.zeros([1, 224, 224, 3]), BuscaVision.FEATURE_NODE)); // aquece
        return m;
      }).catch((e) => { modelLoading = null; throw e; });
    }
    return modelLoading;
  }

  const Q = { img: null, crop: null, drag: null, scale: 1 }; // recorte em pixels da imagem original

  function openPanel() {
    const panel = $("imgPanel"), wasHidden = panel.hidden;
    panel.hidden = false; $("camBtn").setAttribute("aria-pressed", "true");
    $("hero").hidden = true;
    const top = panel.getBoundingClientRect().top;
    if (wasHidden || top < headerH() - 4 || top > window.innerHeight * 0.5) scrollToEl(panel);
    $("imgTitle").focus({ preventScroll: true });
  }
  function closePanel(silent) {
    queryId++;
    $("imgPanel").hidden = true; $("camBtn").setAttribute("aria-pressed", "false");
    S.img = null; S.imgScores = null; clearGuess(); S.sort = "rel"; $("sort").value = "rel";
    Q.img = null; Q.crop = null; Q.drag = null;
    $("qCanvas").hidden = true; $("dropEmpty").hidden = false; $("drop").classList.remove("has-img"); $("guess").hidden = true;
    setStatus("");
    if (!silent) render();
  }

  function loadQueryImage(src) {
    return new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => { Q.img = im; Q.crop = null; drawQuery(); resolve(im); };
      im.onerror = () => reject(new Error("Não foi possível abrir essa imagem. Tente um arquivo JPG, PNG ou WEBP."));
      im.src = src;
    });
  }

  function drawQuery() {
    const cv = $("qCanvas"), im = Q.img;
    if (!im) return;
    const maxW = Math.min(($("drop").clientWidth || 600) - 4, 900);
    const maxH = window.innerWidth < 760 ? 200 : 340; // deixa a primeira fileira de resultados visível
    Q.scale = Math.min(maxW / im.naturalWidth, maxH / im.naturalHeight, 2);
    cv.width = Math.round(im.naturalWidth * Q.scale); cv.height = Math.round(im.naturalHeight * Q.scale);
    const g = cv.getContext("2d");
    g.drawImage(im, 0, 0, cv.width, cv.height);
    const c = Q.drag ? Q.drag : Q.crop;
    if (c) {
      const [x, y, w, h] = norm(c).map((v) => v * Q.scale);
      g.fillStyle = "rgba(7, 15, 28, .5)";
      g.fillRect(0, 0, cv.width, y); g.fillRect(0, y + h, cv.width, cv.height - y - h);
      g.fillRect(0, y, x, h); g.fillRect(x + w, y, cv.width - x - w, h);
      g.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--gold-600").trim() || "#a98a45"; g.lineWidth = 2.5; g.setLineDash([7, 4]); g.strokeRect(x + 1, y + 1, w - 2, h - 2);
    }
    cv.hidden = false; $("dropEmpty").hidden = true; $("drop").classList.add("has-img");
  }
  function norm(c) { return [Math.min(c.x0, c.x1), Math.min(c.y0, c.y1), Math.abs(c.x1 - c.x0), Math.abs(c.y1 - c.y0)]; }

  async function runImageQuery() {
    if (!Q.img) return;
    const my = ++queryId, cat0 = S.cat;
    const stale = () => my !== queryId || !Q.img || $("imgPanel").hidden;
    try {
      if (!model) setStatus("Preparando o reconhecimento de imagem (14 MB, só na primeira vez)…", true);
      await loadModel();
      if (stale()) return;
      setStatus("Analisando a imagem…", true);
      await new Promise((r) => setTimeout(r, 0));
      if (stale()) return;
      const cv = document.createElement("canvas");
      const [sx, sy, sw, sh] = Q.crop ? norm(Q.crop) : [0, 0, Q.img.naturalWidth, Q.img.naturalHeight];
      const k = Math.min(1, 512 / Math.max(sw, sh));
      cv.width = Math.max(1, Math.round(sw * k)); cv.height = Math.max(1, Math.round(sh * k));
      cv.getContext("2d").drawImage(Q.img, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
      const t = tf.browser.fromPixels(cv);
      const desc = await BuscaVision.describe(tf, model, t);
      t.dispose();
      if (stale()) return;
      applyImageQuery(desc, S.cat !== cat0);
      setStatus(Q.crop ? "Mostrando produtos parecidos com a área marcada." : "Mostrando produtos parecidos com a foto inteira.");
    } catch (e) {
      console.error(e);
      if (!stale()) setStatus("Não foi possível analisar a imagem. Verifique sua conexão e tente de novo.");
    }
  }

  function applyImageQuery(desc, keepCat) {
    S.img = desc; clearGuess();
    if (!keepCat) resetCatbar();
    rescore();
    S.sort = "rel"; $("sort").value = "rel"; S.shown = PAGE;
    // categoria provável: votos ponderados dos 12 vizinhos mais próximos
    const top = [...D.products.keys()].sort((a, b) => S.imgScores[b] - S.imgScores[a]).slice(0, 12);
    const votes = {};
    let tot = 0;
    for (const i of top) { const w = Math.pow(simPct(S.imgScores[i]), 2) + 1e-3; votes[D.products[i].category] = (votes[D.products[i].category] || 0) + w; tot += w; }
    const guesses = Object.entries(votes).sort((a, b) => b[1] - a[1]).slice(0, 3).filter(([, v]) => v / tot >= 0.1);
    $("guessChips").innerHTML = guesses.map(([c, v]) => `<button type="button" class="chip" data-cat="${c}" aria-pressed="false">${esc(catById[c].name)}<b>${Math.round(v / tot * 100)}%</b></button>`).join("");
    $("guess").hidden = !guesses.length;
    S.text = ""; $("q").value = "";
    render();
  }
  function rescore() { if (S.img) S.imgScores = rankByVector(S.img.deep, S.img.color, S.colorW); }

  async function searchSimilar(id) {
    queryId++;
    openPanel();
    try { await loadQueryImage(D.products[id].image); } catch (e) { setStatus(e.message); return; }
    // usa o vetor já indexado: resultado imediato, sem esperar o modelo
    applyImageQuery({
      deep: E.slice(id * DIM, (id + 1) * DIM),
      color: C.slice(id * BuscaVision.COLOR_DIM, (id + 1) * BuscaVision.COLOR_DIM),
    });
    setStatus("Parecidos com “" + D.products[id].name.slice(0, 60) + "”. Marque uma parte da foto para refinar.");
    loadModel().catch(() => {}); // já deixa o modelo pronto para um recorte
  }

  function handleFile(file) {
    openPanel();
    if (!file || !file.type.startsWith("image/")) { setStatus("Escolha um arquivo de imagem (JPG, PNG ou WEBP)."); return; }
    queryId++;
    const url = URL.createObjectURL(file);
    loadQueryImage(url).then(runImageQuery).catch((e) => setStatus(e.message));
  }

  function canvasPoint(e) {
    const cv = $("qCanvas"), r = cv.getBoundingClientRect();
    const sx = cv.width / r.width, sy = cv.height / r.height;
    const x = (e.clientX - r.left) * sx / Q.scale, y = (e.clientY - r.top) * sy / Q.scale;
    return [Math.max(0, Math.min(Q.img.naturalWidth, x)), Math.max(0, Math.min(Q.img.naturalHeight, y))];
  }

  /* ---------- Eventos ---------- */
  function wire() {
    trackHeader();
    const applyText = () => {
      const t = $("q").value.trim();
      if (t === S.text) return;
      S.text = t; S.shown = PAGE;
      if (S.text && !$("imgPanel").hidden) closePanel(true); // texto novo começa uma busca nova (e cancela a análise)
      render();
    };
    $("searchForm").onsubmit = (e) => { e.preventDefault(); applyText(); scrollToEl($("resultados")); };
    let deb;
    $("q").oninput = () => { clearTimeout(deb); deb = setTimeout(applyText, 200); };
    try {
      const small = window.matchMedia("(max-width: 520px)");
      const ph = () => ($("q").placeholder = small.matches ? "Buscar produto" : "Buscar produto, marca ou cor");
      ph(); small.addEventListener ? small.addEventListener("change", ph) : small.addListener(ph);
    } catch (e) { /* ignorado */ }
    $("camBtn").onclick = () => ($("imgPanel").hidden ? (openPanel(), Q.img || $("file").click()) : closePanel());
    document.querySelectorAll("[data-pick]").forEach((b) => (b.onclick = () => $("file").click()));
    $("closeImg").onclick = () => { closePanel(); $("camBtn").focus(); };
    $("seeResults").onclick = () => { scrollToEl($("resultados")); $("resTitle").focus({ preventScroll: true }); };
    $("logo").onclick = (e) => { e.preventDefault(); goHome(); };
    $("file").onchange = (e) => { handleFile(e.target.files[0]); e.target.value = ""; };
    $("catbar").onclick = (e) => {
      const b = e.target.closest("button"); if (!b) return;
      setCat(b.dataset.cat);
      if ($("resultados").getBoundingClientRect().top < headerH()) scrollToEl($("resultados"));
    };
    $("catbar").addEventListener("focusin", (e) => { const b = e.target.closest("button"); if (b) revealCat(b); });
    $("catbar").addEventListener("scroll", updateCatArrows, { passive: true });
    window.addEventListener("resize", updateCatArrows);
    $("catPrev").onclick = () => { const t = $("catbar"); t.scrollBy({ left: -t.clientWidth * 0.7 }); };
    $("catNext").onclick = () => { const t = $("catbar"); t.scrollBy({ left: t.clientWidth * 0.7 }); };
    $("crumbs").onclick = (e) => { if (e.target.closest("[data-home]")) goHome(); };
    // menu lateral (celular): faz o mesmo que a barra de categorias, sem recarregar a página
    $("menuCats").addEventListener("click", (e) => {
      const a = e.target.closest("a[data-cat]");
      if (!a || !window.BuscaMenu || e.button || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      setCat(a.dataset.cat);
      BuscaMenu.close(() => {
        if ($("resultados").getBoundingClientRect().top < headerH() + 8 || S.cat) scrollToEl($("resultados"));
      });
    });
    $("footCats").onclick = (e) => {
      const b = e.target.closest("[data-cat]"); if (!b) return;
      closePanel(true); S.text = ""; $("q").value = "";
      setCat(b.dataset.cat); scrollToEl($("resultados"));
    };
    $("footCities").onclick = (e) => {
      const b = e.target.closest("[data-city]"); if (!b) return;
      S.cities = new Set([b.dataset.city]); S.shown = PAGE; syncFilterInputs();
      render(); scrollToEl($("resultados"));
    };
    $("activeFilters").onclick = (e) => {
      const b = e.target.closest("[data-k]"); if (!b) return;
      const k = b.dataset.k, v = b.dataset.v;
      const idx = [...$("activeFilters").querySelectorAll(".fchip")].indexOf(b);
      if (k === "all") clearAllFilters();
      else if (k === "cat") setCat(null);
      else {
        if (k === "city") S.cities.delete(v);
        if (k === "store") S.stores.delete(v);
        if (k === "price") { S.pmin = S.pmax = null; }
        if (k === "stock") S.stock = true;
        S.shown = PAGE; syncFilterInputs(); render();
      }
      // o botão clicado sumiu: o foco vai para o próximo filtro ou para o título dos resultados
      const left = [...$("activeFilters").querySelectorAll(".fchip")];
      (left[Math.min(Math.max(idx, 0), left.length - 1)] || $("resTitle")).focus({ preventScroll: true });
    };
    $("grid").addEventListener("click", (e) => {
      if (!e.target.closest("[data-allcats]")) return;
      clearGuess(); setCat(null); $("resTitle").focus({ preventScroll: true });
    });

    const dropTargets = () => [$("drop"), $("heroDrop")];
    ["dragenter", "dragover"].forEach((ev) => document.addEventListener(ev, (e) => {
      if ([...(e.dataTransfer?.types || [])].includes("Files")) { e.preventDefault(); dropTargets().forEach((d) => d.classList.add("over")); }
    }));
    ["dragleave", "drop"].forEach((ev) => document.addEventListener(ev, (e) => {
      if (ev === "dragleave" && e.relatedTarget) return;
      dropTargets().forEach((d) => d.classList.remove("over"));
    }));
    document.addEventListener("drop", (e) => { const f = e.dataTransfer?.files?.[0]; if (f) { e.preventDefault(); handleFile(f); } });
    document.addEventListener("paste", (e) => {
      const it = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
      if (it) { e.preventDefault(); handleFile(it.getAsFile()); }
    });

    const cv = $("qCanvas");
    cv.addEventListener("pointerdown", (e) => {
      if (!Q.img) return;
      const [x, y] = canvasPoint(e);
      Q.drag = { x0: x, y0: y, x1: x, y1: y };
      cv.setPointerCapture(e.pointerId);
    });
    cv.addEventListener("pointermove", (e) => {
      if (!Q.drag) return;
      const [x, y] = canvasPoint(e); Q.drag.x1 = x; Q.drag.y1 = y; drawQuery();
    });
    const endDrag = () => {
      if (!Q.drag || !Q.img) { Q.drag = null; return; }
      const [, , w, h] = norm(Q.drag);
      const minSide = 0.06 * Math.max(Q.img.naturalWidth, Q.img.naturalHeight);
      const changed = w > minSide && h > minSide;
      if (changed) Q.crop = Q.drag;
      Q.drag = null; drawQuery();
      if (changed) runImageQuery();
    };
    cv.addEventListener("pointerup", endDrag);
    cv.addEventListener("pointercancel", endDrag);
    $("resetCrop").onclick = () => { if (!Q.img) return; Q.crop = null; drawQuery(); runImageQuery(); };
    let rz;
    window.addEventListener("resize", () => {
      clearTimeout(rz);
      rz = setTimeout(() => { if (Q.img && !$("imgPanel").hidden) drawQuery(); drawChart(); }, 120);
    });

    $("colorW").oninput = (e) => { S.colorW = +e.target.value / 100; $("colorWOut").textContent = e.target.value + "%"; rescore(); render(); };
    $("minSim").oninput = (e) => { S.minSim = +e.target.value / 100; $("minSimOut").textContent = e.target.value + "%"; render(); };
    $("guessChips").onclick = (e) => {
      const b = e.target.closest(".chip"); if (!b) return;
      const on = b.getAttribute("aria-pressed") !== "true";
      $("guessChips").querySelectorAll(".chip").forEach((x) => x.setAttribute("aria-pressed", "false"));
      b.setAttribute("aria-pressed", String(on));
      S.guessCat = on ? b.dataset.cat : null; S.shown = PAGE; render();
    };

    $("sort").onchange = (e) => { S.sort = e.target.value; render(); };
    const num = (v) => (v === "" || isNaN(+v) ? null : +v);
    $("pmin").oninput = (e) => { S.pmin = num(e.target.value); S.shown = PAGE; render(); };
    $("pmax").oninput = (e) => { S.pmax = num(e.target.value); S.shown = PAGE; render(); };
    $("fStock").onchange = (e) => { S.stock = e.target.checked; render(); };
    $("clearFilters").onclick = clearAllFilters;
    $("moreBtn").onclick = () => { S.shown += PAGE; render(); };

    const openFrom = (e) => {
      const simEl = e.target.closest("[data-sim]");
      if (simEl) { e.preventDefault(); searchSimilar(+simEl.dataset.sim); return; }
      const link = e.target.closest("[data-open]");
      if (link) { e.preventDefault(); openProduct(+link.dataset.open); }
    };
    $("grid").addEventListener("click", openFrom);
    $("pdSim").addEventListener("click", openFrom);
    $("pdClose").onclick = () => $("pdlg").close();
    $("pdlg").addEventListener("click", (e) => { if (e.target === $("pdlg")) $("pdlg").close(); });
    $("pdlg").addEventListener("close", () => { try { history.replaceState(null, "", location.pathname + location.search); } catch (e) { /* ignorado */ } });
    try { if (window.matchMedia("(max-width: 960px)").matches) $("filters").querySelector("details").open = false; } catch (e) { /* ignorado */ }
  }

  boot().catch((e) => {
    console.error(e);
    $("grid").innerHTML = `<div class="empty"><b>Não foi possível carregar o catálogo</b><p>Recarregue a página. Se o problema continuar, tente mais tarde.</p></div>`;
  });
})();
