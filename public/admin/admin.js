/* Buscar PY — painel admin. Lê e grava /api/admin/settings; o servidor valida tudo de novo. */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var form = $("editor");
  var state = null;     // última resposta do servidor
  var orig = "";        // configurações salvas (JSON) para saber se há alterações
  var logoData = "";    // logo em edição (data URL) ou "" para o ícone padrão
  var pending = null;   // alterações guardadas quando a sessão expira: { settings, base, version }
  var saving = false;   // um envio em andamento
  var tried = false;    // tentou salvar com campos errados: a barra pede a correção
  var note = null;      // aviso da barra de salvar que fica até a próxima edição: { msg, alert }
  var MAX_LINKS = 6, MAX_CAMS = 8;
  var PENDING_KEY = "buscarpy-painel-pendente";

  var clone = function (o) { return JSON.parse(JSON.stringify(o)); };
  function getPath(o, p) { return p.split(".").reduce(function (a, k) { return a == null ? undefined : a[k]; }, o); }
  function setPath(o, p, v) {
    var ks = p.split("."), last = ks.pop();
    var t = ks.reduce(function (a, k) { return a[k]; }, o);
    t[last] = v;
  }
  var same = function (a, b) { return JSON.stringify(a) === JSON.stringify(b); };

  // Junta as suas alterações (mine, feitas sobre oldBase) com uma versão nova do servidor (newBase):
  // o campo que você mudou fica com o seu valor; o resto vem da versão nova. Listas contam como um campo só.
  function merge(mine, oldBase, newBase) {
    if (mine === undefined) return clone(newBase);
    if (newBase === undefined || mine === null || typeof mine !== "object" || Array.isArray(mine) ||
        newBase === null || typeof newBase !== "object" || Array.isArray(newBase)) {
      return same(mine, oldBase) ? clone(newBase) : clone(mine);
    }
    var out = {};
    Object.keys(newBase).forEach(function (k) { out[k] = merge(mine[k], oldBase && oldBase[k], newBase[k]); });
    return out;
  }

  /* ---------- Servidor ---------- */
  function api(method, url, body) {
    var opts = { method: method, credentials: "same-origin", headers: { Accept: "application/json" } };
    if (body !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
    return fetch(url, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) { return { status: r.status, data: data || {} }; });
    });
  }

  function show(view) {
    ["vLoading", "vDisabled", "vLogin", "vEditor"].forEach(function (v) { $(v).hidden = v !== view; });
    $("logout").hidden = view !== "vEditor";
  }

  function boot() {
    try { pending = JSON.parse(sessionStorage.getItem(PENDING_KEY) || "null"); } catch (e) { pending = null; }
    api("GET", "/api/admin/session").then(function (r) {
      if (!r.data.enabled) return show("vDisabled");
      if (!r.data.loggedIn) return showLogin(pending ? "Entre de novo para continuar: suas alterações que ainda não foram salvas serão mantidas." : "");
      return loadSettings();
    }).catch(function () {
      $("vLoading").querySelector("p").textContent = "Sem conexão com o servidor. Recarregue a página para tentar de novo.";
    });
  }

  function showLogin(msg) {
    show("vLogin");
    $("loginError").hidden = !msg;
    $("loginError").textContent = msg || "";
    $("password").value = "";
    $("password").focus();
  }

  // Sessão expirou: guarda o que está no formulário (na memória e nesta aba do navegador) antes de pedir a senha.
  function keepPending() {
    if (state && !$("vEditor").hidden) {
      var mine = collect();
      pending = same(mine, JSON.parse(orig)) ? null : { settings: mine, base: JSON.parse(orig), version: state.version };
    }
    try {
      if (pending) sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
      else sessionStorage.removeItem(PENDING_KEY);
    } catch (e) { /* sem espaço ou bloqueado: fica só na memória */ }
  }
  function dropPending() {
    pending = null;
    try { sessionStorage.removeItem(PENDING_KEY); } catch (e) { /* nada a fazer */ }
  }
  function sessionExpired() {
    keepPending();
    showLogin(pending ? "Sua sessão expirou. Entre de novo — suas alterações serão mantidas." : "Sua sessão expirou. Entre de novo.");
  }
  // Depois do login, devolve ao formulário o que estava sendo editado.
  function restorePending() {
    var p = pending;
    dropPending();
    if (!p || !p.settings) return;
    try {
      fill(merge(p.settings, p.base || state.settings, state.settings));
    } catch (e) {
      fill(clone(state.settings));
      return updateDirty();
    }
    if (JSON.stringify(collect()) === orig) return updateDirty();
    updateDirty(p.version === state.version
      ? "Suas alterações foram mantidas. Clique em “Salvar e publicar” para gravá-las no site."
      : "Suas alterações foram mantidas. O painel também foi salvo em outra aba ou aparelho: confira e clique em “Salvar e publicar”.");
  }

  function loadSettings() {
    return api("GET", "/api/admin/settings").then(function (r) {
      if (r.status === 401) return sessionExpired();
      if (r.status !== 200) return toast(r.data.error || "Não foi possível carregar as configurações.");
      apply(r.data);
      show("vEditor");
      if (pending) restorePending();
    }).catch(function () { toast("Sem conexão com o servidor."); });
  }

  function apply(data) {
    state = data;
    orig = JSON.stringify(data.settings);
    tried = false;
    note = null;
    fill(clone(data.settings));
    renderRates();
    var w = $("storageWarn"), st = data.storage || {}, msg = "";
    if (!st.writable && st.volume) {
      msg = "O volume do Railway está montado, mas o servidor não consegue gravar nele. No Railway, crie a variável RAILWAY_RUN_UID=0 no serviço e faça um novo deploy. " +
        "Até lá, o que você salvar aqui vale só até o próximo reinício.";
    } else if (!st.writable) {
      msg = "Atenção: o servidor não consegue gravar no disco. As alterações valem só até o próximo reinício. Configure um volume no Railway.";
    } else if (!st.persistent) {
      msg = "Atenção: as alterações estão sendo gravadas num disco temporário e somem no próximo deploy. Adicione um volume ao serviço no Railway para guardá-las de vez.";
    }
    w.hidden = !msg;
    w.textContent = msg;
    updateDirty();
  }

  /* ---------- Números no jeito brasileiro ---------- */
  // "5,35" para o real e "5.800" para o guarani; o servidor recebe sempre número.
  function ptNum(v, group) {
    var p = String(v).split(".");
    if (group) p[0] = p[0].replace(/\B(?=(\d{3})+(?!\d))/g, ".");
    else p[1] = (p[1] || "").padEnd(2, "0"); // centavos: 5,60 e não 5,6
    return p.join(",");
  }
  function parseBRL(v) {
    var s = String(v).replace(/\s|R\$/gi, "");
    if (/^\d+([.,]\d+)?$/.test(s)) return Number(s.replace(",", "."));
    return NaN;
  }
  function parsePYG(v) {
    var s = String(v).replace(/\s|₲|gs/gi, "");
    if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, ""); // 7.950 = sete mil novecentos e cinquenta
    if (/^\d+(,\d+)?$/.test(s)) return Number(s.replace(",", "."));
    return NaN;
  }
  var NUM = {
    brl: { parse: parseBRL, min: 1, max: 20, show: function (v) { return ptNum(v, false); },
      msg: "Digite quantos reais vale US$ 1, um valor entre 1 e 20 (ex.: 5,35)." },
    pyg: { parse: parsePYG, min: 1000, max: 20000, show: function (v) { return ptNum(v, true); },
      msg: "Digite quantos guaranis vale US$ 1, um valor entre 1.000 e 20.000 (ex.: 5.800)." },
  };
  function numValue(kind, text) {
    var n = NUM[kind].parse(text);
    return Number.isFinite(n) && n >= NUM[kind].min && n <= NUM[kind].max ? n : null;
  }

  /* ---------- Formulário ---------- */
  function fill(s) {
    form.querySelectorAll("[data-path]").forEach(function (el) {
      var v = getPath(s, el.getAttribute("data-path"));
      var kind = el.getAttribute("data-check");
      if (el.type === "checkbox") el.checked = !!v;
      else if (el.hasAttribute("data-lines")) el.value = (v || []).join("\n");
      else if (NUM[kind] && typeof v === "number") el.value = NUM[kind].show(v);
      else el.value = v == null ? "" : String(v);
      el.removeAttribute("data-seen");
    });
    form.querySelectorAll("[data-color-for]").forEach(function (el) {
      var v = getPath(s, el.getAttribute("data-color-for"));
      if (isHex(v)) el.value = v.toLowerCase();
    });
    logoData = s.brand.logo || "";
    renderRows($("linksList"), "tplLink", s.topbar.links, MAX_LINKS, $("addLink"));
    renderRows($("camsList"), "tplCam", s.cameras.list, MAX_CAMS, $("addCam"));
    syncManualRates();
    renderBrand();
    validate(true); // o que já chega errado (ex.: alterações guardadas) aparece marcado
  }

  function collect() {
    var s = clone(state.settings);
    form.querySelectorAll("[data-path]").forEach(function (el) {
      var p = el.getAttribute("data-path"), kind = el.getAttribute("data-check"), v;
      if (el.type === "checkbox") v = el.checked;
      else if (el.hasAttribute("data-lines")) v = el.value.split("\n").map(function (x) { return x.trim(); }).filter(Boolean);
      else if (NUM[kind]) { v = numValue(kind, el.value); if (v == null) v = el.value.trim(); } // texto errado fica como está
      else if (kind === "hex") { v = el.value.trim(); if (isHex(v)) v = v.toLowerCase(); }
      else v = el.value.trim();
      setPath(s, p, v);
    });
    s.brand.logo = logoData;
    s.topbar.links = readRows($("linksList"), function (r) {
      return { label: r.label.value.trim(), url: r.url.value.trim(), live: r.live.checked, newTab: r.newTab.checked };
    }).filter(function (l) { return l.label || l.url; });
    s.cameras.list = readRows($("camsList"), function (r) {
      return { name: r.name.value.trim(), url: r.url.value.trim() };
    }).filter(function (c) { return c.name || c.url; });
    return s;
  }

  // Atualiza a barra de salvar. msg: aviso que fica até a próxima edição (null apaga o anterior);
  // alert: mostra o aviso em vermelho.
  function updateDirty(msg, alert) {
    if (msg !== undefined) note = msg ? { msg: msg, alert: !!alert } : null;
    if (!state) return;
    var bad = validate();
    if (!bad) tried = false;
    var dirty = JSON.stringify(collect()) !== orig;
    var bar = $("savebar");
    bar.classList.toggle("dirty", dirty);
    bar.classList.toggle("alert", note ? note.alert : tried);
    $("save").disabled = !dirty || saving;
    $("discard").disabled = !dirty || saving;
    $("saveMsg").textContent = note ? note.msg : tried ? "Corrija os itens marcados em vermelho."
      : dirty ? "Você tem alterações que ainda não estão no site." : "Tudo salvo. O site está igual ao que você vê aqui.";
  }
  var edited = function () { updateDirty(null); }; // toda edição apaga o aviso anterior da barra

  /* ---------- Conferência dos campos ---------- */
  var isHex = function (v) { return typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v.trim()); };
  var LOOKS_LIKE_SITE = /^[\w-]+(\.[\w-]+)+([\/?#]\S*)?$/; // ex.: www.loja.com.br/ofertas
  var BROKEN = "Esse endereço não é válido. Copie o link de novo, inteiro e sem espaços.";
  var noScheme = function (v) { return "Falta o https:// no começo do endereço (ex.: https://" + (v.length > 40 ? v.slice(0, 40) + "…" : v) + ")."; };
  function linkProblem(v) {
    if (/^\/(?![\/\\])\S*$/.test(v)) return "";
    try {
      var u = new URL(v);
      // espaço no nome do site: o Chrome aceita, mas o servidor (Node) recusa
      if ((u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password && !/^\w+:\/*[^\/?#]*\s/.test(v)) return "";
    } catch (e) { /* inválido */ }
    if (LOOKS_LIKE_SITE.test(v)) return noScheme(v);
    if (/^https?:\/\//i.test(v)) return BROKEN;
    return "Use um caminho do site (ex.: /cameras) ou um endereço completo começando com https://.";
  }
  // Players de câmera: só https e com um nome de site comum (letras, números, pontos e hífens),
  // a mesma regra do servidor (lib/settings.js).
  var PLAIN_HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i;
  function camUrl(v) {
    try {
      var u = new URL(v.replace(/&amp;/g, "&"));
      if (u.protocol === "https:" && !u.username && !u.password && PLAIN_HOST.test(u.hostname)) return u.href;
    } catch (e) { /* inválido */ }
    return "";
  }
  function camProblem(v) {
    if (camUrl(v)) return "";
    if (/^http:\/\//i.test(v)) return "Use o endereço com https:// (com “s”); o navegador bloqueia players http:// dentro do site.";
    if (LOOKS_LIKE_SITE.test(v)) return noScheme(v);
    if (/^https:\/\//i.test(v)) return BROKEN;
    return "O endereço do player precisa começar com https:// (ex.: https://www.youtube.com/watch?v=…).";
  }
  function luminance(hex) {
    var c = hex.match(/[0-9a-f]{2}/gi).map(function (x) {
      var v = parseInt(x, 16) / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  function contrast(a, b) {
    var x = luminance(a), y = luminance(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }
  // arredonda para baixo: 4,49 aparece como "4,4:1", nunca como o mínimo recomendado
  function ratioText(r) { return (Math.floor(r * 10) / 10).toFixed(1).replace(".", ",") + ":1"; }
  // Devolve [erro, observação] de um campo simples.
  function fieldProblem(el) {
    var kind = el.getAttribute("data-check"), v = el.value.trim();
    if (NUM[kind]) return [numValue(kind, v) == null ? NUM[kind].msg : "", ""];
    // vazio, o servidor manteria o texto anterior sem avisar
    if (kind === "req") return [v ? "" : "Este campo não pode ficar vazio.", ""];
    if (!isHex(v)) return ["Cor inválida: use o formato #RRGGBB (ex.: #0c1a2e) ou escolha a cor no quadrado ao lado.", ""];
    // A cor principal leva texto branco (botões, barra da cotação, rodapé) e é a cor dos títulos sobre o
    // fundo névoa (#f6f5f1). Conferir contra a névoa cobre os dois casos: o branco contrasta ainda mais.
    // A de destaque leva texto na cor principal (selos e botões sobre o fundo escuro) e aparece sobre ela
    // no "PY" e na seta do símbolo.
    if (el.getAttribute("data-path") === "brand.primary") {
      var light = contrast(v, "#f6f5f1");
      return ["", light >= 4.5 ? "" : "Esta cor fica difícil de ler nos botões, na barra superior, no rodapé e nos títulos (contraste " +
        ratioText(light) + " com o fundo claro do site; o recomendado é pelo menos 4,5:1). Escolha um tom mais escuro."];
    }
    var main = form.querySelector('[data-path="brand.primary"]').value.trim();
    if (!isHex(main)) main = state.settings.brand.primary;
    var pair = contrast(v, main);
    return ["", pair >= 4.5 ? "" : "Esta cor fica pouco visível junto da cor principal (contraste " + ratioText(pair) +
      "; o recomendado é pelo menos 4,5:1). Escolha um tom mais claro para os destaques."];
  }
  // O erro aparece quando a pessoa sai do campo (data-seen) ou tenta salvar; some assim que o valor fica certo.
  function paint(inputs, box, problems) {
    var seen = inputs.some(function (el) { return el.hasAttribute("data-seen"); });
    var errText = seen ? problems.filter(function (p) { return p.err; }).map(function (p) { return p.err; }).join(" ") : "";
    var text = errText || problems.map(function (p) { return p.note || ""; }).join(" ").trim();
    box.textContent = text;
    box.hidden = !text;
    box.classList.toggle("adm-error", !!errText);
    box.classList.toggle("adm-note", !errText);
    inputs.forEach(function (el) {
      var bad = problems.some(function (p) { return p.el === el && p.err; });
      el.toggleAttribute("data-invalid", bad);
      if (bad && errText) el.setAttribute("aria-invalid", "true"); else el.removeAttribute("aria-invalid");
      if (text && (bad || !errText)) el.setAttribute("aria-describedby", box.id); else el.removeAttribute("aria-describedby");
    });
  }
  function rowProblems(row) {
    var cam = row.classList.contains("row-cam");
    var nameEl = row.querySelector(cam ? '[data-k="name"]' : '[data-k="label"]'), urlEl = row.querySelector('[data-k="url"]');
    var name = nameEl.value.trim(), url = urlEl.value.trim(), out = [];
    if (name || url) {
      if (!name) out.push({ el: nameEl, err: cam ? "Falta o nome da câmera." : "Falta o texto do link." });
      if (!url) out.push({ el: urlEl, err: cam ? "Falta o endereço do player." : "Falta o endereço do link." });
      else {
        var p = cam ? camProblem(url) : linkProblem(url);
        if (p) out.push({ el: urlEl, err: p });
      }
    }
    return { inputs: [nameEl, urlEl], problems: out };
  }
  // Confere tudo e devolve o primeiro campo errado (ou null). markSeen: mostra já os erros que existirem.
  function validate(markSeen) {
    form.querySelectorAll("[data-check]").forEach(function (el) {
      var r = fieldProblem(el);
      if (markSeen && r[0]) el.setAttribute("data-seen", "");
      paint([el], $(el.getAttribute("data-err")), [{ el: el, err: r[0], note: r[1] }]);
    });
    form.querySelectorAll(".row").forEach(function (row) {
      var r = rowProblems(row);
      if (markSeen && r.problems.length) r.inputs.forEach(function (el) { el.setAttribute("data-seen", ""); });
      paint(r.inputs, row.querySelector(".row-err"), r.problems);
    });
    return form.querySelector("[data-invalid]");
  }

  /* ---------- Listas (links e câmeras) ---------- */
  var rowUid = 0;
  var LIST = {
    linksList: { one: "link", many: "links", moved: "Link movido", removed: "Link removido", max: MAX_LINKS,
      full: "é o máximo. Remova um para adicionar outro." },
    camsList: { one: "câmera", many: "câmeras", moved: "Câmera movida", removed: "Câmera removida", max: MAX_CAMS,
      full: "é o máximo. Remova uma para adicionar outra." },
  };
  function renderRows(box, tplId, items, max, addBtn) {
    box.innerHTML = "";
    items.forEach(function (it) { box.appendChild(makeRow(tplId, it)); });
    refreshRows(box, max, addBtn);
  }
  function makeRow(tplId, it) {
    var row = $(tplId).content.firstElementChild.cloneNode(true);
    row.querySelectorAll("[data-k]").forEach(function (el) {
      var v = it[el.getAttribute("data-k")];
      if (el.type === "checkbox") el.checked = !!v; else el.value = v || "";
    });
    row.querySelector(".row-err").id = "rowErr" + (++rowUid);
    return row;
  }
  function readRows(box, map) {
    return Array.prototype.map.call(box.querySelectorAll(".row"), function (row) {
      var r = {};
      row.querySelectorAll("[data-k]").forEach(function (el) { r[el.getAttribute("data-k")] = el; });
      return map(r);
    });
  }
  // Botões, nomes para leitores de tela e o contador "N de 6".
  function refreshRows(box, max, addBtn) {
    var rows = box.querySelectorAll(".row"), L = LIST[box.id];
    var label = function (row, sel, text) { var el = row.querySelector(sel); if (el) el.setAttribute("aria-label", text); };
    rows.forEach(function (row, i) {
      var n = L.one + " " + (i + 1);
      var name = row.querySelector('[data-k="label"], [data-k="name"]').value.trim();
      var named = n + (name ? " (" + name + ")" : "");
      row.querySelector('[data-move="-1"]').disabled = i === 0;
      row.querySelector('[data-move="1"]').disabled = i === rows.length - 1;
      label(row, '[data-k="label"]', "Texto do link " + (i + 1));
      label(row, '[data-k="name"]', "Nome da câmera " + (i + 1));
      label(row, '[data-k="url"]', box.id === "camsList" ? "Endereço do player da câmera " + (i + 1) : "Endereço do link " + (i + 1));
      label(row, '[data-k="live"]', "ao vivo (" + n + ")");
      label(row, '[data-k="newTab"]', "nova aba (" + n + ")");
      label(row, '[data-move="-1"]', "Mover " + named + " para cima");
      label(row, '[data-move="1"]', "Mover " + named + " para baixo");
      label(row, "[data-remove]", "Remover " + named);
      var test = row.querySelector("[data-test]");
      if (test) {
        var u = camUrl(row.querySelector('[data-k="url"]').value.trim());
        test.setAttribute("aria-label", "Abrir a " + named + " em outra aba");
        if (u) { test.href = u; test.removeAttribute("aria-disabled"); }
        else { test.removeAttribute("href"); test.setAttribute("aria-disabled", "true"); }
      }
    });
    addBtn.disabled = rows.length >= max;
    var count = $(box.id === "camsList" ? "camsCount" : "linksCount");
    count.textContent = rows.length >= max
      ? rows.length + " de " + max + " " + L.many + ": " + L.full
      : rows.length + " de " + max + " " + L.many;
  }
  var liveTimer;
  function announce(msg) {
    var el = $("listStatus");
    el.textContent = "";
    clearTimeout(liveTimer);
    liveTimer = setTimeout(function () { el.textContent = msg; }, 60);
  }
  function wireList(box, tplId, max, addBtn, blank) {
    var L = LIST[box.id];
    addBtn.addEventListener("click", function () {
      if (box.querySelectorAll(".row").length >= max) return;
      var row = makeRow(tplId, blank);
      box.appendChild(row);
      refreshRows(box, max, addBtn);
      row.querySelector("input").focus();
      edited();
    });
    box.addEventListener("click", function (e) {
      var row = e.target.closest(".row"); if (!row) return;
      var mv = e.target.closest("[data-move]");
      if (mv && !mv.disabled) {
        var d = +mv.getAttribute("data-move");
        if (d < 0 && row.previousElementSibling) box.insertBefore(row, row.previousElementSibling);
        if (d > 0 && row.nextElementSibling) box.insertBefore(row.nextElementSibling, row);
        refreshRows(box, max, addBtn);
        var again = row.querySelector('[data-move="' + d + '"]');
        (again && !again.disabled ? again : mv.parentNode.querySelector("[data-move]:not(:disabled)") || row.querySelector("input")).focus();
        var all = Array.prototype.indexOf.call(box.children, row);
        announce(L.moved + " para a posição " + (all + 1) + " de " + box.children.length + ".");
        edited();
      }
      if (e.target.closest("[data-remove]")) {
        var next = row.nextElementSibling || row.previousElementSibling;
        var name = row.querySelector('[data-k="label"], [data-k="name"]').value.trim();
        row.remove();
        refreshRows(box, max, addBtn);
        (next ? next.querySelector("input") : addBtn).focus();
        var left = box.children.length;
        announce(L.removed + (name ? " (" + name + ")" : "") + ". " + (left === 1 ? "Resta 1." : "Restam " + left + "."));
        edited();
      }
      if (e.target.closest("[data-test]") && !e.target.closest("[data-test]").href) e.preventDefault();
    });
    box.addEventListener("input", function () { refreshRows(box, max, addBtn); });
  }

  /* ---------- Cores, logo e prévia ---------- */
  // O mesmo símbolo "b" do site, pintado com as cores escolhidas (variáveis --pv-primary e --pv-accent).
  var LOGO_SVG = '<svg class="logo-mark" viewBox="48 24 116 154" aria-hidden="true">' +
    '<path class="lm-ink" d="M48,30a6,6 0 0 1 6,-6h20a6,6 0 0 1 6,6v148H48Z"/><circle class="lm-ink" cx="108" cy="122" r="56"/>' +
    '<path class="lm-arrow" d="M91,116L112,134L133,116" fill="none" stroke-width="13.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  function renderBrand() {
    var s = collect();
    var primary = isHex(s.brand.primary) ? s.brand.primary : state.settings.brand.primary;
    var accent = isHex(s.brand.accent) ? s.brand.accent : state.settings.brand.accent;
    var sec = $("visual"), pv = $("brandPreview");
    sec.style.setProperty("--pv-primary", primary);
    sec.style.setProperty("--pv-accent", accent);
    pv.querySelector(".pv-n1").textContent = s.brand.name1;
    pv.querySelector(".pv-n2").textContent = s.brand.name2;
    [pv.querySelector(".pv-logo"), $("logoPrev")].forEach(function (box) {
      if (!logoData) { box.innerHTML = LOGO_SVG; return; }
      var img = document.createElement("img");
      img.alt = "";
      img.src = logoData;
      box.replaceChildren(img);
    });
    $("logoRemove").disabled = !logoData;
  }

  // Qualquer imagem vira PNG de no máximo 256 px: arquivo pequeno e sem metadados.
  function readLogo(file) {
    if (!file || !/^image\//.test(file.type)) { toast("Escolha um arquivo de imagem."); return; }
    if (file.size > 8 * 1024 * 1024) { toast("Imagem grande demais (máximo de 8 MB)."); return; }
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      var w = img.naturalWidth || 256, h = img.naturalHeight || 256;
      var k = Math.min(1, 256 / Math.max(w, h));
      var cv = document.createElement("canvas");
      cv.width = Math.max(1, Math.round(w * k)); cv.height = Math.max(1, Math.round(h * k));
      cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
      URL.revokeObjectURL(url);
      var data = cv.toDataURL("image/png");
      if (data.length > 500 * 1024) data = cv.toDataURL("image/webp", 0.9);
      logoData = data;
      renderBrand(); edited();
    };
    img.onerror = function () { URL.revokeObjectURL(url); toast("Não foi possível abrir essa imagem."); };
    img.src = url;
  }

  /* ---------- Cotação ---------- */
  var brl = function (v) { return "R$ " + Number(v).toFixed(2).replace(".", ","); };
  var pyg = function (v) { return "₲ " + String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, "."); };
  var hhmm = function (iso) { var d = new Date(iso); return iso && !isNaN(d) ? d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : ""; };
  var SRC = { google: "Google", awesomeapi: "AwesomeAPI", "er-api": "ExchangeRate-API", manual: "valor manual" };
  function srcName(s) { return String(s || "").split("+").map(function (x) { return SRC[x] || x; }).join(" e "); }
  var CUR = { BRL: { name: "Real" }, PYG: { name: "Guarani" } };
  // Valor com a bandeira da moeda na frente (a bandeira é enfeite: o símbolo já diz a moeda).
  function curNode(flag, text) {
    var box = document.createElement("span"), f = document.createElement("span");
    box.className = "cur";
    f.className = "flag flag-" + flag;
    f.setAttribute("aria-hidden", "true");
    box.append(f, text);
    return box;
  }

  function renderRates() {
    var r = state.rates, e = r.effective, st = r.state || {}, errs = r.errors || {};
    var curs = Object.keys(CUR), missing = curs.filter(function (c) { return !st[c]; });
    var next = r.nextRun ? " · próxima às " + hhmm(r.nextRun) : "";
    $("fxNow").replaceChildren(curNode("us", "US$ 1 ="), " ", curNode("br", brl(e.BRL)), " ", curNode("py", pyg(e.PYG)));
    var info;
    if (!e.auto) info = "Valor manual (a atualização automática está desligada).";
    else if (missing.length === curs.length || e.source === "manual") info = "Ainda sem leitura automática: usando o valor manual." + (r.nextRun ? " Próxima tentativa às " + hhmm(r.nextRun) + "." : "");
    else {
      info = "Fonte: " + srcName(e.source) + " · lida às " + hhmm(e.at) + next;
      if (missing.length) info += " · " + missing.map(function (c) { return CUR[c].name.toLowerCase(); }).join(" e ") + " no valor manual";
    }
    $("fxNowInfo").textContent = info;

    // Vermelho só quando a moeda ficou sem leitura automática; reserva em uso é só uma observação.
    // O aviso de "salto" (valor ignorado ou fontes que não concordam) já vem do servidor em frase pronta.
    var red = [], notes = [];
    if (e.auto) curs.forEach(function (c) {
      var jump = errs[c + ":salto"];
      var fails = Object.keys(errs).filter(function (k) { return k.indexOf(c + ":") === 0 && k !== c + ":salto"; })
        .map(function (k) { return srcName(k.slice(c.length + 1)) + " falhou: " + String(errs[k]).replace(/(\d)\.(\d)/g, "$1,$2"); });
      var failText = fails.length ? " " + fails.join("; ") + "." : "";
      if (!st[c]) red.push(CUR[c].name + ": " + (jump || (fails.length ? "nenhuma fonte respondeu" : "ainda sem leitura") + ", então o site usa o valor manual.") + failText);
      else {
        if (fails.length) notes.push(CUR[c].name + ": " + fails.join("; ") + ". Usando " + srcName(st[c].source) + ".");
        if (jump) notes.push(CUR[c].name + ": " + jump);
      }
    });
    [["fxErrors", red], ["fxNotes", notes]].forEach(function (x) {
      var ul = $(x[0]);
      ul.replaceChildren.apply(ul, x[1].map(function (t) { var li = document.createElement("li"); li.textContent = t; return li; }));
      ul.hidden = !x[1].length;
    });
  }
  function syncManualRates() {
    var auto = form.querySelector('[data-path="rates.auto"]').checked;
    form.querySelectorAll('[data-path="rates.BRL"], [data-path="rates.PYG"]').forEach(function (el) {
      el.closest(".fld").classList.toggle("muted", auto);
    });
  }

  /* ---------- Avisos ---------- */
  var toastTimer;
  function toast(msg) {
    var t = $("toast");
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 4000);
  }

  /* ---------- Eventos ---------- */
  $("loginForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var btn = e.target.querySelector("button[type=submit]");
    btn.disabled = true; btn.textContent = "Entrando…";
    var done = function () { btn.disabled = false; btn.textContent = "Entrar"; };
    api("POST", "/api/admin/login", { password: $("password").value }).then(function (r) {
      done();
      if (r.status === 200) return loadSettings();
      showLogin(r.data.error || (r.status === 429 ? "Muitas senhas erradas. Espere 15 minutos e tente de novo." : "Não foi possível entrar."));
    }).catch(function () { done(); showLogin("Sem conexão com o servidor."); });
  });

  $("logout").addEventListener("click", function () {
    if (state && JSON.stringify(collect()) !== orig && !confirm("Sair sem salvar as alterações?")) return;
    api("POST", "/api/admin/logout", {}).then(function () { state = null; dropPending(); showLogin(); })
      .catch(function () { toast("Sem conexão com o servidor."); });
  });

  form.addEventListener("input", function (e) {
    var cf = e.target.getAttribute("data-color-for");
    if (cf) form.querySelector('[data-path="' + cf + '"]').value = e.target.value;
    if (e.target.matches('[data-path="brand.primary"], [data-path="brand.accent"]') && isHex(e.target.value)) {
      form.querySelector('[data-color-for="' + e.target.getAttribute("data-path") + '"]').value = e.target.value.trim().toLowerCase();
    }
    if (e.target.closest("#visual")) renderBrand();
    edited();
  });
  form.addEventListener("change", function (e) {
    if (e.target.matches('[data-path="rates.auto"]')) syncManualRates();
    edited();
  });
  // Ao sair de um campo (ou de uma linha da lista), os erros dele passam a aparecer.
  // Se o foco saiu por um clique ou toque, o aviso espera o clique terminar: aparecendo já no
  // mousedown, ele empurraria o botão clicado para baixo e o clique se perderia.
  var pressing = false, upAt = 0, waitClick = false, paintTimer;
  document.addEventListener("pointerdown", function () { pressing = true; }, true);
  ["pointerup", "pointercancel"].forEach(function (t) {
    document.addEventListener(t, function () { pressing = false; upAt = Date.now(); }, true);
  });
  document.addEventListener("click", function () { if (waitClick) setTimeout(paintNow, 0); });
  function paintNow() { waitClick = false; clearTimeout(paintTimer); if (state) updateDirty(); }
  function paintLater() { if (pressing) paintTimer = setTimeout(paintLater, 200); else paintNow(); }
  form.addEventListener("focusout", function (e) {
    var t = e.target, row = t.closest && t.closest(".row");
    if (t.hasAttribute && t.hasAttribute("data-check")) t.setAttribute("data-seen", "");
    if (row && !(e.relatedTarget && row.contains(e.relatedTarget))) {
      row.querySelectorAll('[data-k="label"], [data-k="name"], [data-k="url"]').forEach(function (el) { el.setAttribute("data-seen", ""); });
    }
    // no toque, o foco muda logo depois de o dedo sair da tela (antes do clique)
    if (!pressing && Date.now() - upAt > 500) return paintNow();
    waitClick = true;
    clearTimeout(paintTimer);
    paintTimer = setTimeout(paintLater, 700);
  });

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    if (saving || !state) return;
    // Nada sai com campo errado: o servidor descartaria a linha ou manteria o valor antigo sem avisar.
    var bad = validate(true);
    if (bad) {
      tried = true;
      bad.focus();
      updateDirty(null);
      return;
    }
    var sent = collect();
    saving = true;
    updateDirty("Salvando…");
    api("PUT", "/api/admin/settings", { settings: sent, version: state.version }).then(function (r) {
      saving = false;
      if (r.status === 401) return sessionExpired();
      if (r.status === 409 && r.data.settings) {
        // Salvo em outra aba ou aparelho: a versão nova vira a base e as suas alterações continuam por cima.
        var base = JSON.parse(orig);
        apply(r.data);
        fill(merge(sent, base, state.settings));
        var dirty = JSON.stringify(collect()) !== orig;
        updateDirty((r.data.error || "O painel foi salvo em outra aba ou aparelho enquanto você editava.") +
          (dirty ? " Suas alterações continuam aqui, por cima da versão nova: confira e clique em “Salvar e publicar” de novo."
            : " O painel já mostra a versão atual."), true);
        toast(dirty ? "Confira as alterações e salve de novo." : "O painel foi atualizado.");
        return;
      }
      if (r.status !== 200) return updateDirty(r.data.error || "Não foi possível salvar. Tente de novo.", true);
      dropPending();
      apply(r.data);
      toast("Salvo e publicado no site.");
    }).catch(function () { saving = false; updateDirty("Sem conexão com o servidor. Tente de novo.", true); });
  });

  $("discard").addEventListener("click", function () {
    if (!confirm("Descartar todas as alterações que ainda não foram salvas?")) return;
    tried = false;
    dropPending();
    fill(clone(state.settings));
    edited();
    toast("Alterações descartadas.");
  });

  form.querySelectorAll("[data-reset]").forEach(function (b) {
    b.addEventListener("click", function () {
      var sec = b.getAttribute("data-reset");
      var s = collect();
      s[sec] = clone(state.defaults[sec]);
      fill(s);
      edited();
      toast("Valores padrão aplicados. Clique em “Salvar e publicar” para valer no site.");
    });
  });

  $("fxRefresh").addEventListener("click", function () {
    var b = $("fxRefresh");
    var done = function () { b.disabled = false; b.textContent = "Atualizar agora"; };
    b.disabled = true; b.textContent = "Atualizando…";
    api("POST", "/api/admin/rates/refresh", {}).then(function (r) {
      done();
      if (r.status === 401) return sessionExpired();
      if (r.status !== 200 || !r.data.rates) return toast(r.data.error || "Não foi possível conferir a cotação agora.");
      state.rates = r.data.rates;
      renderRates();
      var e = r.data.rates.effective, st = r.data.rates.state || {}, errs = r.data.rates.errors || {};
      var read = Object.keys(CUR).filter(function (c) { return st[c]; }).length;
      var jumped = Object.keys(errs).some(function (k) { return /:salto$/.test(k); });
      toast(!e.auto ? "Conferido. A atualização automática está desligada, então o site continua com o valor manual."
        : !read ? "Não foi possível ler a cotação agora; o site continua com o valor manual."
        : read < Object.keys(CUR).length ? "Só parte da cotação foi lida; veja o aviso no quadro."
        : jumped ? "Cotação conferida, mas uma leitura foi ignorada; veja o aviso no quadro."
        : "Cotação atualizada.");
    }).catch(function () { done(); toast("Sem conexão com o servidor."); });
  });

  $("logoPick").addEventListener("click", function () { $("logoFile").click(); });
  $("logoFile").addEventListener("change", function (e) { readLogo(e.target.files[0]); e.target.value = ""; });
  $("logoRemove").addEventListener("click", function () {
    logoData = ""; renderBrand(); edited();
    $("logoPick").focus(); // o botão fica desativado: o foco não pode se perder
    toast("Ícone padrão escolhido. Salve para valer no site.");
  });

  wireList($("linksList"), "tplLink", MAX_LINKS, $("addLink"), { label: "", url: "", live: false, newTab: false });
  wireList($("camsList"), "tplCam", MAX_CAMS, $("addCam"), { name: "", url: "" });

  // menu lateral acompanha a rolagem
  if (window.IntersectionObserver) {
    var links = Array.prototype.slice.call(document.querySelectorAll(".adm-nav a"));
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        links.forEach(function (a) { a.classList.toggle("on", a.getAttribute("href") === "#" + en.target.id); });
      });
    }, { rootMargin: "-80px 0px -60% 0px" });
    document.querySelectorAll(".adm-forms > section").forEach(function (s) { io.observe(s); });
  }

  window.addEventListener("beforeunload", function (e) {
    var open = state && !$("vEditor").hidden && JSON.stringify(collect()) !== orig;
    if (open || ($("vEditor").hidden && pending)) { e.preventDefault(); e.returnValue = ""; }
  });

  boot();
})();
