/* Buscar PY — cotação do dólar na barra superior.
 * O servidor já entrega a página com a cotação atual; aqui ela é conferida de novo a cada minuto
 * (só com a aba visível) em /api/rates, que responde da memória do servidor sem consultar a casa de câmbio.
 * Quem precisa reagir a uma cotação nova (os preços em R$ e ₲ da vitrine) usa BuscaFx.onChange. */
(function () {
  "use strict";
  var el = document.getElementById("fx");
  var POLL_MS = 60 * 1000;
  var listeners = [];
  var cur = {
    BRL: el ? parseFloat(el.getAttribute("data-brl")) : NaN,
    PYG: el ? parseFloat(el.getAttribute("data-pyg")) : NaN,
    at: el ? el.getAttribute("data-at") : "",
    source: el ? el.getAttribute("data-source") : "",
  };
  var lastPoll = Date.now();

  // Nome das fontes para o visitante, igual ao do servidor: "google+awesomeapi" -> "Google e AwesomeAPI".
  var SOURCE_LABELS = { bonanza: "Bonanza Cambios", google: "Google", awesomeapi: "AwesomeAPI", "er-api": "ExchangeRate-API" };
  function sourceLabel(source) {
    return String(source || "").split("+").filter(Boolean).map(function (id) {
      return Object.prototype.hasOwnProperty.call(SOURCE_LABELS, id) ? SOURCE_LABELS[id] : id;
    }).join(" e ");
  }

  function brl(v) { return "R$ " + v.toFixed(2).replace(".", ","); }
  function pyg(v) { return "₲ " + String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, "."); }

  function paint() {
    if (!el) return;
    document.getElementById("fxBrl").textContent = brl(cur.BRL);
    document.getElementById("fxPyg").textContent = pyg(cur.PYG);
    var when = "";
    if (cur.at) {
      var d = new Date(cur.at);
      if (!isNaN(d)) when = ". Última leitura às " + d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    }
    var label = sourceLabel(cur.source);
    el.title = (cur.source === "manual"
      ? "Cotação de referência definida pela equipe do site"
      : String(cur.source).split("+").indexOf("bonanza") >= 0
      ? "Cotação de venda do dólar na Bonanza Cambios (Ciudad del Este), conferida a cada 5 minutos"
      : "Cotação comercial do dólar" + (label ? " (fonte: " + label + ")" : "") + ", conferida a cada 5 minutos") + when;
  }

  function valid(j) {
    return j && typeof j.BRL === "number" && typeof j.PYG === "number" && j.BRL > 1 && j.BRL < 20 && j.PYG > 1000 && j.PYG < 20000;
  }

  function poll() {
    // a versão de demonstração (window.BUSCA_B64) não tem servidor: fica com a cotação da página
    if (document.hidden || !window.fetch || window.BUSCA_B64) return;
    lastPoll = Date.now();
    fetch("/api/rates", { cache: "no-store", headers: { Accept: "application/json" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!valid(j)) return;
        var changed = j.BRL !== cur.BRL || j.PYG !== cur.PYG;
        cur = { BRL: j.BRL, PYG: j.PYG, at: j.at || "", source: j.source || "" };
        paint();
        if (changed) listeners.forEach(function (fn) { try { fn(cur); } catch (e) { console.error(e); } });
      })
      .catch(function () { /* sem servidor (versão de demonstração) ou sem internet: mantém a cotação da página */ });
  }

  if (el && isFinite(cur.BRL) && isFinite(cur.PYG)) {
    paint();
    setInterval(poll, POLL_MS);
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden && Date.now() - lastPoll > POLL_MS) poll();
    });
  }

  window.BuscaFx = {
    get: function () { return cur; },
    onChange: function (fn) { listeners.push(fn); },
  };
})();
