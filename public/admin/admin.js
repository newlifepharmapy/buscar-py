/* Buscar PY — painel admin. Lê e grava /api/admin/settings; o servidor valida tudo de novo. */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var form = $("editor");
  var state = null;     // última resposta do servidor
  var orig = "";        // configurações salvas (JSON) para saber se há alterações
  var logoData = "";    // logo em edição (data URL) ou "" para o ícone padrão
  var MAX_LINKS = 6, MAX_CAMS = 8;

  var clone = function (o) { return JSON.parse(JSON.stringify(o)); };
  function getPath(o, p) { return p.split(".").reduce(function (a, k) { return a == null ? undefined : a[k]; }, o); }
  function setPath(o, p, v) {
    var ks = p.split("."), last = ks.pop();
    var t = ks.reduce(function (a, k) { return a[k]; }, o);
    t[last] = v;
  }

  /* ---------- Servidor ---------- */
  function api(method, url, body) {
    var opts = { method: method, credentials: "same-origin", headers: { Accept: "application/json" } };
    if (body !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
    return fetch(url, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) { return { status: r.status, data: data }; });
    });
  }

  function show(view) {
    ["vLoading", "vDisabled", "vLogin", "vEditor"].forEach(function (v) { $(v).hidden = v !== view; });
    $("logout").hidden = view !== "vEditor";
  }

  function boot() {
    api("GET", "/api/admin/session").then(function (r) {
      if (!r.data.enabled) return show("vDisabled");
      if (!r.data.loggedIn) return showLogin();
      return loadSettings();
    }).catch(function () { toast("Sem conexão com o servidor."); });
  }

  function showLogin(msg) {
    show("vLogin");
    $("loginError").hidden = !msg;
    $("loginError").textContent = msg || "";
    $("password").value = "";
    $("password").focus();
  }

  function loadSettings() {
    return api("GET", "/api/admin/settings").then(function (r) {
      if (r.status === 401) return showLogin("Sua sessão expirou. Entre de novo.");
      if (r.status !== 200) return toast(r.data.error || "Não foi possível carregar as configurações.");
      apply(r.data);
      show("vEditor");
    });
  }

  function apply(data) {
    state = data;
    orig = JSON.stringify(data.settings);
    fill(clone(data.settings));
    renderRates();
    var w = $("storageWarn");
    if (!data.storage.writable) {
      w.hidden = false;
      w.textContent = "Atenção: o servidor não consegue gravar no disco. As alterações valem só até o próximo reinício. Configure um volume no Railway.";
    } else if (!data.storage.persistent) {
      w.hidden = false;
      w.textContent = "Atenção: as alterações estão sendo gravadas num disco temporário e somem no próximo deploy. Adicione um volume ao serviço no Railway para guardá-las de vez.";
    } else w.hidden = true;
    updateDirty();
  }

  /* ---------- Formulário ---------- */
  function fill(s) {
    form.querySelectorAll("[data-path]").forEach(function (el) {
      var v = getPath(s, el.getAttribute("data-path"));
      if (el.type === "checkbox") el.checked = !!v;
      else if (el.hasAttribute("data-lines")) el.value = (v || []).join("\n");
      else el.value = v == null ? "" : String(v);
    });
    form.querySelectorAll("[data-color-for]").forEach(function (el) { el.value = getPath(s, el.getAttribute("data-color-for")); });
    logoData = s.brand.logo || "";
    renderRows($("linksList"), "tplLink", s.topbar.links, MAX_LINKS, $("addLink"));
    renderRows($("camsList"), "tplCam", s.cameras.list, MAX_CAMS, $("addCam"));
    syncManualRates();
    renderBrand();
  }

  function collect() {
    var s = clone(state.settings);
    form.querySelectorAll("[data-path]").forEach(function (el) {
      var p = el.getAttribute("data-path"), v;
      if (el.type === "checkbox") v = el.checked;
      else if (el.hasAttribute("data-lines")) v = el.value.split("\n").map(function (x) { return x.trim(); }).filter(Boolean);
      else if (el.hasAttribute("data-num")) v = el.value === "" ? null : Number(el.value);
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

  function updateDirty() {
    if (!state) return;
    var dirty = JSON.stringify(collect()) !== orig;
    $("savebar").classList.toggle("dirty", dirty);
    $("save").disabled = !dirty;
    $("discard").disabled = !dirty;
    $("saveMsg").textContent = dirty ? "Você tem alterações que ainda não estão no site." : "Tudo salvo. O site está igual ao que você vê aqui.";
  }

  /* ---------- Listas (links e câmeras) ---------- */
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
    return row;
  }
  function readRows(box, map) {
    return Array.prototype.map.call(box.querySelectorAll(".row"), function (row) {
      var r = {};
      row.querySelectorAll("[data-k]").forEach(function (el) { r[el.getAttribute("data-k")] = el; });
      return map(r);
    });
  }
  function refreshRows(box, max, addBtn) {
    var rows = box.querySelectorAll(".row");
    rows.forEach(function (row, i) {
      row.querySelector('[data-move="-1"]').disabled = i === 0;
      row.querySelector('[data-move="1"]').disabled = i === rows.length - 1;
      var test = row.querySelector("[data-test]");
      if (test) {
        var u = row.querySelector('[data-k="url"]').value.trim();
        if (/^https:\/\//i.test(u)) { test.href = u.replace(/&amp;/g, "&"); test.removeAttribute("aria-disabled"); }
        else { test.removeAttribute("href"); test.setAttribute("aria-disabled", "true"); }
      }
      // marca endereços que o servidor vai recusar
      var url = row.querySelector('[data-k="url"]');
      var v = url.value.trim();
      var ok = !v || (box.id === "camsList" ? /^https:\/\/[^\s]+$/i.test(v) : /^(\/(?![\/\\])\S*|https?:\/\/\S+)$/i.test(v));
      url.classList.toggle("bad", !ok);
      url.title = ok ? "" : (box.id === "camsList" ? "O endereço precisa começar com https://" : "Use /caminho ou um endereço https://");
    });
    addBtn.disabled = rows.length >= max;
  }
  function wireList(box, tplId, max, addBtn, blank) {
    addBtn.addEventListener("click", function () {
      if (box.querySelectorAll(".row").length >= max) return;
      var row = makeRow(tplId, blank);
      box.appendChild(row);
      refreshRows(box, max, addBtn);
      row.querySelector("input").focus();
      updateDirty();
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
        updateDirty();
      }
      if (e.target.closest("[data-remove]")) {
        var next = row.nextElementSibling || row.previousElementSibling;
        row.remove();
        refreshRows(box, max, addBtn);
        (next ? next.querySelector("input") : addBtn).focus();
        updateDirty();
      }
      if (e.target.closest("[data-test]") && !e.target.closest("[data-test]").href) e.preventDefault();
    });
    box.addEventListener("input", function () { refreshRows(box, max, addBtn); });
  }

  /* ---------- Cores, logo e prévia ---------- */
  function luminance(hex) {
    var c = hex.match(/[0-9a-f]{2}/gi).map(function (x) {
      var v = parseInt(x, 16) / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  var isHex = function (v) { return /^#[0-9a-f]{6}$/i.test(v); };
  function mix(hex, to, t) {
    var a = hex.match(/[0-9a-f]{2}/gi).map(function (x) { return parseInt(x, 16); });
    var b = to.match(/[0-9a-f]{2}/gi).map(function (x) { return parseInt(x, 16); });
    return "#" + a.map(function (v, i) { return Math.round(v + (b[i] - v) * t).toString(16).padStart(2, "0"); }).join("");
  }
  function contrastNote(id, hex, what) {
    var el = $(id);
    if (!isHex(hex)) { el.hidden = false; el.textContent = "Use o formato #RRGGBB (ex.: #0038a8)."; return; }
    var ratio = 1.05 / (luminance(hex) + 0.05);
    el.hidden = ratio >= 4.5;
    el.textContent = "Texto branco sobre esta cor fica difícil de ler (contraste " + ratio.toFixed(1).replace(".", ",") +
      ":1; o recomendado é pelo menos 4,5:1). Escolha um tom mais escuro para " + what + ".";
  }
  function renderBrand() {
    var s = collect();
    var blue = isHex(s.brand.blue) ? s.brand.blue : state.settings.brand.blue;
    var red = isHex(s.brand.red) ? s.brand.red : state.settings.brand.red;
    var pv = $("brandPreview");
    pv.style.setProperty("--pv-blue", blue);
    pv.style.setProperty("--pv-red", red);
    pv.style.setProperty("--pv-red-50", mix(red, "#ffffff", 0.92));
    pv.querySelector(".pv-n1").textContent = s.brand.name1;
    pv.querySelector(".pv-n2").textContent = s.brand.name2;
    [pv.querySelector(".pv-logo"), $("logoPrev")].forEach(function (box) {
      var img = document.createElement("img");
      img.alt = "";
      img.src = logoData || "/favicon.svg";
      box.replaceChildren(img);
    });
    $("logoRemove").disabled = !logoData;
    contrastNote("contrastBlue", s.brand.blue, "botões e a barra superior");
    contrastNote("contrastRed", s.brand.red, "os destaques");
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
      renderBrand(); updateDirty();
    };
    img.onerror = function () { URL.revokeObjectURL(url); toast("Não foi possível abrir essa imagem."); };
    img.src = url;
  }

  /* ---------- Cotação ---------- */
  var brl = function (v) { return "R$ " + Number(v).toFixed(2).replace(".", ","); };
  var pyg = function (v) { return "₲ " + String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, "."); };
  var hhmm = function (iso) { var d = new Date(iso); return isNaN(d) ? "" : d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }); };
  var SRC = { google: "Google", awesomeapi: "AwesomeAPI", "er-api": "ExchangeRate-API", manual: "valor manual" };
  function srcName(s) { return String(s || "").split("+").map(function (x) { return SRC[x] || x; }).join(" e "); }

  function renderRates() {
    var r = state.rates, e = r.effective;
    $("fxNow").textContent = "US$ 1 = " + brl(e.BRL) + " · " + pyg(e.PYG);
    var info;
    if (!e.auto) info = "Valor manual (a atualização automática está desligada).";
    else if (e.source === "manual") info = "Ainda sem leitura automática: usando o valor manual. Próxima tentativa às " + hhmm(r.nextRun) + ".";
    else info = "Fonte: " + srcName(e.source) + " · lida às " + hhmm(e.at) + (r.nextRun ? " · próxima às " + hhmm(r.nextRun) : "");
    $("fxNowInfo").textContent = info;
    var errs = Object.keys(r.errors || {});
    var ul = $("fxErrors");
    ul.hidden = !e.auto || !errs.length;
    ul.innerHTML = "";
    errs.forEach(function (k) {
      var parts = k.split(":");
      var li = document.createElement("li");
      li.textContent = (parts[1] === "salto" ? parts[0] + ": " : parts[0] + " · " + (SRC[parts[1]] || parts[1]) + " não respondeu: ") + r.errors[k];
      ul.appendChild(li);
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
    btn.disabled = true;
    api("POST", "/api/admin/login", { password: $("password").value }).then(function (r) {
      btn.disabled = false;
      if (r.status === 200) return loadSettings();
      showLogin(r.data.error || "Não foi possível entrar.");
    }).catch(function () { btn.disabled = false; showLogin("Sem conexão com o servidor."); });
  });

  $("logout").addEventListener("click", function () {
    if (state && JSON.stringify(collect()) !== orig && !confirm("Sair sem salvar as alterações?")) return;
    api("POST", "/api/admin/logout", {}).then(function () { state = null; showLogin(); });
  });

  form.addEventListener("input", function (e) {
    var cf = e.target.getAttribute("data-color-for");
    if (cf) form.querySelector('[data-path="' + cf + '"]').value = e.target.value;
    if (e.target.matches('[data-path="brand.blue"], [data-path="brand.red"]') && isHex(e.target.value.trim())) {
      form.querySelector('[data-color-for="' + e.target.getAttribute("data-path") + '"]').value = e.target.value.trim().toLowerCase();
    }
    if (e.target.closest("#visual")) renderBrand();
    updateDirty();
  });
  form.addEventListener("change", function (e) {
    if (e.target.matches('[data-path="rates.auto"]')) syncManualRates();
    updateDirty();
  });

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var sent = collect();
    $("save").disabled = true;
    $("saveMsg").textContent = "Salvando…";
    api("PUT", "/api/admin/settings", { settings: sent, version: state.version }).then(function (r) {
      if (r.status === 401) return showLogin("Sua sessão expirou. Entre de novo para salvar (suas alterações nesta aba serão perdidas).");
      if (r.status === 409) {
        $("saveMsg").textContent = r.data.error;
        if (confirm(r.data.error + "\n\nCarregar a versão atual agora? (as suas alterações desta aba serão descartadas)")) apply(r.data);
        else $("save").disabled = false;
        return;
      }
      if (r.status !== 200) { $("saveMsg").textContent = r.data.error || "Não foi possível salvar."; $("save").disabled = false; return; }
      apply(r.data);
      var adjusted = JSON.stringify(sent) !== JSON.stringify(r.data.settings);
      toast(adjusted ? "Salvo. Alguns campos inválidos ou vazios voltaram ao valor anterior ou padrão." : "Salvo e publicado no site.");
    }).catch(function () { $("saveMsg").textContent = "Sem conexão com o servidor. Tente de novo."; $("save").disabled = false; });
  });

  $("discard").addEventListener("click", function () {
    fill(clone(state.settings));
    updateDirty();
    toast("Alterações descartadas.");
  });

  form.querySelectorAll("[data-reset]").forEach(function (b) {
    b.addEventListener("click", function () {
      var sec = b.getAttribute("data-reset");
      var s = collect();
      s[sec] = clone(state.defaults[sec]);
      fill(s);
      updateDirty();
      toast("Valores padrão aplicados. Clique em “Salvar e publicar” para valer no site.");
    });
  });

  $("fxRefresh").addEventListener("click", function () {
    var b = $("fxRefresh");
    b.disabled = true; b.textContent = "Atualizando…";
    api("POST", "/api/admin/rates/refresh", {}).then(function (r) {
      b.disabled = false; b.textContent = "Atualizar agora";
      if (r.status === 401) return showLogin("Sua sessão expirou. Entre de novo.");
      if (r.status === 200) { state.rates = r.data.rates; renderRates(); toast("Cotação conferida."); }
    }).catch(function () { b.disabled = false; b.textContent = "Atualizar agora"; });
  });

  $("logoPick").addEventListener("click", function () { $("logoFile").click(); });
  $("logoFile").addEventListener("change", function (e) { readLogo(e.target.files[0]); e.target.value = ""; });
  $("logoRemove").addEventListener("click", function () { logoData = ""; renderBrand(); updateDirty(); });

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
    if (state && !$("vEditor").hidden && JSON.stringify(collect()) !== orig) { e.preventDefault(); e.returnValue = ""; }
  });

  boot();
})();
