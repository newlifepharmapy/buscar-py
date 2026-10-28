/* Buscar PY — câmeras ao vivo, todas na mesma página (como no iClinic), no modo mais leve possível:
 * - o player de cada câmera só é criado quando ela aparece na tela, e é removido quando ela sai da tela;
 * - no máximo 3 players abertos ao mesmo tempo no computador, e 2 no celular;
 * - tudo fecha quando a aba fica escondida (ou a pessoa sai da página) e volta quando ela reaparece;
 * - depois de 10 minutos sem mexer na página, pausa tudo e pergunta se a pessoa quer continuar;
 * - com "economia de dados" ligada ou conexão 2G, nada abre sozinho: cada câmera espera um toque.
 * Na versão de demonstração (window.BUSCA_DEMO) não há player: a hospedagem da demonstração não deixa
 * abrir vídeos de outros sites, então cada câmera explica isso e oferece o vídeo em outra aba. */
(function () {
  "use strict";
  var IDLE_MS = 10 * 60 * 1000, LEAVE_MS = 1500;
  var OPEN_AT = 0.5, CLOSE_AT = 0.1; // abre com metade da câmera na tela; fecha quando quase nada dela aparece
  var narrow = window.matchMedia ? window.matchMedia("(max-width: 899px)") : { matches: false };
  function maxLive() { return narrow.matches ? 2 : 3; }
  var status = document.getElementById("camStatus");
  var cards = Array.prototype.slice.call(document.querySelectorAll(".cam-card")).map(function (el) {
    return {
      el: el,
      name: el.querySelector(".cam-name").textContent.trim(),
      src: el.getAttribute("data-src"),
      stage: el.querySelector(".cam-stage"),
      cover: el.querySelector(".cam-cover"),
      msg: el.querySelector(".cam-cover-msg"),
      play: el.querySelector(".cam-play"),
      playTxt: el.querySelector(".cam-play-txt"),
      full: el.querySelector(".cam-full"),
      frame: null,
      inView: false,
      want: true,        // deve tocar quando estiver na tela
      ratio: 0,          // quanto da câmera está na tela (0 a 1)
      asked: 0,          // quando a pessoa pediu esta câmera (ela tem prioridade na vaga)
      idled: false,      // estava tocando quando a página ficou 10 minutos sem uso
      leaveTimer: null,
    };
  });
  var hint = document.querySelector(".cams-hint");
  if (!cards.length || window.BUSCA_DEMO) { if (hint) hint.hidden = true; } // o aviso só vale onde há player
  if (!cards.length) return;

  // Avisos para leitores de tela: só para o que a pessoa fez (rolar a página abre e fecha players em silêncio).
  function say(text) { if (status) status.textContent = text; }

  if (window.BUSCA_DEMO) {
    cards.forEach(function (c) {
      c.msg.textContent = "Nesta demonstração o vídeo não abre aqui dentro: o claude.ai não permite vídeos de outros sites. " +
        "No site publicado, a câmera toca nesta mesma tela.";
      var a = document.createElement("a");
      a.className = "btn btn-sm btn-ghost";
      a.href = c.src;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = "Ver o vídeo em outra aba";
      var sr = document.createElement("span");
      sr.className = "sr-only";
      sr.textContent = ": " + c.name;
      a.appendChild(sr);
      c.cover.appendChild(a);
    });
    return;
  }

  function connection() { return navigator.connection || navigator.mozConnection || navigator.webkitConnection || {}; }
  var conn = connection();
  var light = !!(conn.saveData || /(^|-)2g$/.test(conn.effectiveType || ""));
  var leaving = false, idleTimer = null, lastReset = 0;
  var fullscreenOk = !!(document.fullscreenEnabled && cards[0].stage.requestFullscreen);

  function liveCount() { return cards.filter(function (c) { return c.frame; }).length; }

  function open(c) {
    // o "Assistir ao vivo" fica dentro da capa, que vai sumir: o foco passa para o "Tela cheia" (ou para o vídeo)
    var refocus = c.cover.contains(document.activeElement);
    var f = document.createElement("iframe");
    f.className = "cam-frame";
    f.title = "Câmera ao vivo: " + c.name;
    f.allow = "autoplay; fullscreen; picture-in-picture";
    f.setAttribute("allowfullscreen", "");
    f.referrerPolicy = "strict-origin-when-cross-origin";
    f.src = c.src;
    c.stage.appendChild(f);
    c.frame = f;
    c.cover.hidden = true;
    c.full.hidden = !fullscreenOk;
    c.el.classList.add("is-live");
    if (refocus) (fullscreenOk ? c.full : f).focus();
    armIdle();
  }

  // Fecha o player (o vídeo para de baixar na hora) e mostra a capa com o motivo.
  function close(c, msg, canPlay, playLabel) {
    var refocus = document.activeElement === c.full;
    if (c.frame) {
      if (document.fullscreenElement === c.stage) document.exitFullscreen().catch(function () {});
      c.frame.src = "about:blank";
      c.frame.remove();
      c.frame = null;
    }
    c.el.classList.remove("is-live");
    c.cover.hidden = false;
    c.msg.textContent = msg;
    c.playTxt.textContent = playLabel || "Assistir ao vivo";
    c.play.hidden = !canPlay;
    c.full.hidden = true;
    if (refocus && canPlay) c.play.focus();
  }

  // Mensagem da capa para uma câmera parada.
  function stopped(c) {
    if (c.idled) return close(c, "Pausamos depois de 10 minutos sem uso, para economizar seus dados.", true, "Continuar assistindo");
    if (!c.want) return close(c, conn.saveData ? "Economia de dados ativada: toque para assistir." : "Conexão lenta: toque para assistir.", true);
    close(c, "Abrindo a câmera…", false);
  }

  function capacityMsg() { return "Para não travar, até " + maxLive() + " câmeras tocam ao mesmo tempo. Toque para assistir esta."; }

  // A câmera em tela cheia (pelo botão do site ou pelo do próprio player), se houver.
  function fullCard() {
    var f = document.fullscreenElement;
    return f ? cards.filter(function (c) { return c.stage === f || c.stage.contains(f); })[0] || null : null;
  }

  // Confere cada câmera: abre as que devem tocar e estão na tela, até o limite, e fecha as outras.
  // A câmera em tela cheia fica sozinha (as outras estão escondidas atrás dela) e nunca é fechada pela rolagem.
  // Na disputa por vaga ganha a que a pessoa pediu por último, depois a que aparece mais na tela,
  // depois a que já está tocando (para não ficar trocando de player à toa).
  function sync() {
    var off = leaving || document.hidden;
    var full = off ? null : fullCard();
    var wanted = off ? [] : cards.filter(function (c) { return c.want && !c.idled && (c.inView || c === full); });
    wanted.sort(function (a, b) {
      return (b.asked - a.asked) || ((b.ratio >= OPEN_AT) - (a.ratio >= OPEN_AT)) ||
        ((b.frame ? 1 : 0) - (a.frame ? 1 : 0)) || (cards.indexOf(a) - cards.indexOf(b));
    });
    var keep = full && wanted.indexOf(full) >= 0 ? [full] : wanted.slice(0, maxLive());
    cards.forEach(function (c) {
      if (keep.indexOf(c) >= 0) return;
      // sem vaga agora: abre sozinha quando outra sair da tela, ou na hora com um toque
      if (wanted.indexOf(c) >= 0 && !full) close(c, capacityMsg(), true);
      else stopped(c);
    });
    keep.forEach(function (c) { if (!c.frame) open(c); });
    if (!liveCount()) clearTimeout(idleTimer);
  }

  // A pessoa pediu esta câmera: ela abre mesmo sem vaga (a que perder a vaga espera com um aviso).
  var asks = 0;
  function play(c) {
    // "Continuar assistindo" depois da pausa por falta de uso volta com todas as que estavam tocando
    if (c.idled) cards.forEach(function (x) { x.idled = false; });
    c.want = true;
    c.inView = true;
    c.asked = ++asks;
    sync();
    say("Câmera ao vivo: " + c.name);
  }

  // 10 minutos sem mexer na página (clique, toque, tecla ou rolagem) com alguma câmera aberta: pausa tudo.
  function armIdle() {
    clearTimeout(idleTimer);
    lastReset = Date.now();
    idleTimer = setTimeout(function () {
      if (!liveCount()) return;
      cards.forEach(function (c) { if (c.frame) c.idled = true; });
      sync();
      say("Pausamos as câmeras depois de 10 minutos sem uso.");
    }, IDLE_MS);
  }
  function activity() { if (liveCount() && Date.now() - lastReset > 15000) armIdle(); }
  ["pointerdown", "keydown", "wheel", "touchstart", "scroll"].forEach(function (ev) {
    window.addEventListener(ev, activity, { passive: true });
  });

  cards.forEach(function (c) {
    c.play.addEventListener("click", function () { play(c); });
    c.full.addEventListener("click", function () {
      if (document.fullscreenElement) document.exitFullscreen().catch(function () {});
      else c.stage.requestFullscreen().catch(function () { /* recusado pelo navegador */ });
    });
    if (light) c.want = false;
  });

  // Quanto de cada câmera está na tela. Abre com metade dela visível; ao sair, espera um pouco antes de
  // fechar (quem rola rápido não fica abrindo e fechando player).
  if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        var c = cards.filter(function (x) { return x.stage === e.target; })[0];
        if (!c) return;
        c.ratio = e.isIntersecting ? e.intersectionRatio : 0;
        clearTimeout(c.leaveTimer);
        if (c.ratio >= OPEN_AT) c.inView = true;
        else if (c.ratio < CLOSE_AT && c.inView) {
          c.leaveTimer = setTimeout(function () { c.inView = false; c.asked = 0; sync(); }, LEAVE_MS);
        }
      });
      sync();
    }, { threshold: [0, CLOSE_AT, OPEN_AT] });
    cards.forEach(function (c) { io.observe(c.stage); });
  } else {
    cards.forEach(function (c) { c.inView = true; c.ratio = 1; });
  }
  // Girar o celular ou redimensionar a janela muda o limite de câmeras abertas.
  if (narrow.addEventListener) narrow.addEventListener("change", function () { sync(); });

  // Saindo da tela cheia, as outras câmeras na tela voltam a abrir.
  document.addEventListener("fullscreenchange", sync);

  // Aba escondida: fecha os players (o vídeo para de baixar). Ao voltar, reabre os que estavam na tela.
  document.addEventListener("visibilitychange", sync);
  // Ao sair da página nada fica tocando; voltando pelo botão "voltar" (cache do navegador), reabre.
  window.addEventListener("pagehide", function () { leaving = true; sync(); });
  window.addEventListener("pageshow", function (e) { if (e.persisted) { leaving = false; sync(); } });

  sync();
})();
