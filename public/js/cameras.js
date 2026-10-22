/* Buscar PY — câmeras ao vivo, no modo mais leve possível:
 * - só existe um player aberto por vez (trocar de câmera fecha o anterior);
 * - o player é removido quando a aba fica escondida e volta quando ela reaparece;
 * - depois de 10 minutos assistindo, pausa e pergunta se a pessoa quer continuar;
 * - com "economia de dados" ligada ou conexão 2G, não abre sozinho: espera um toque. */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var tabs = Array.prototype.slice.call(document.querySelectorAll(".cam-tab"));
  var stage = $("camStage"), cover = $("camCover"), coverTitle = $("camCoverTitle"), coverMsg = $("camCoverMsg");
  var playBtn = $("camPlay"), toggle = $("camToggle"), full = $("camFull"), openLink = $("camOpen"), live = $("camLive");
  var IDLE_MS = 10 * 60 * 1000;
  var current = 0, frame = null, idleTimer = null, resumeOnShow = false;

  if (!tabs.length) {
    coverMsg.textContent = "Nenhuma câmera cadastrada no momento.";
    return;
  }

  function lightMode() {
    var c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    return !!(c && (c.saveData || /(^|-)2g$/.test(c.effectiveType || "")));
  }

  function select(i, focus) {
    current = i;
    tabs.forEach(function (t, k) {
      t.setAttribute("aria-selected", String(k === i));
      t.tabIndex = k === i ? 0 : -1;
    });
    stage.setAttribute("aria-labelledby", tabs[i].id);
    openLink.href = tabs[i].getAttribute("data-src");
    openLink.hidden = false;
    coverTitle.textContent = tabs[i].textContent;
    if (focus) tabs[i].focus();
  }

  function stop(msg) {
    clearTimeout(idleTimer);
    if (frame) {
      frame.src = "about:blank"; // corta o vídeo na hora, antes de remover o elemento
      frame.remove();
      frame = null;
    }
    cover.hidden = false;
    coverMsg.textContent = msg || "Câmera pausada.";
    playBtn.hidden = false;
    playBtn.textContent = "Assistir ao vivo";
    toggle.hidden = true;
    live.hidden = true;
  }

  function play() {
    stop();
    var t = tabs[current];
    frame = document.createElement("iframe");
    frame.className = "cam-frame";
    frame.title = "Câmera ao vivo: " + t.textContent;
    frame.allow = "autoplay; fullscreen; picture-in-picture";
    frame.setAttribute("allowfullscreen", "");
    frame.referrerPolicy = "strict-origin-when-cross-origin";
    frame.src = t.getAttribute("data-src");
    stage.appendChild(frame);
    cover.hidden = true;
    toggle.hidden = false;
    toggle.textContent = "Pausar";
    live.hidden = false;
    idleTimer = setTimeout(function () {
      stop("Pausamos depois de 10 minutos para economizar seus dados. Toque para continuar assistindo.");
    }, IDLE_MS);
  }

  tabs.forEach(function (t, i) {
    t.addEventListener("click", function () {
      if (i === current && frame) return;
      select(i);
      play();
    });
    // setas do teclado entre as abas, como em qualquer lista de abas
    t.addEventListener("keydown", function (e) {
      var k = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (e.key === "Home") k = -current;
      if (e.key === "End") k = tabs.length - 1 - current;
      if (k == null) return;
      e.preventDefault();
      select((current + k + tabs.length) % tabs.length, true);
      play();
    });
  });

  playBtn.addEventListener("click", play);
  toggle.addEventListener("click", function () { if (frame) stop("Câmera pausada."); else play(); });

  if (stage.requestFullscreen && document.fullscreenEnabled) {
    full.hidden = false;
    full.addEventListener("click", function () {
      if (document.fullscreenElement) document.exitFullscreen();
      else stage.requestFullscreen().catch(function () { /* recusado pelo navegador */ });
    });
  }

  // Aba escondida: fecha o player (o vídeo para de baixar). Ao voltar, reabre a mesma câmera.
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      if (frame) { resumeOnShow = true; stop("Câmera pausada enquanto você estava em outra aba."); }
    } else if (resumeOnShow) {
      resumeOnShow = false;
      play();
    }
  });
  // Ao sair da página (inclusive pelo botão voltar com cache), garante que nada fica tocando.
  window.addEventListener("pagehide", function () { if (frame) stop(); });

  var start = Math.max(0, Math.min(tabs.length - 1, (parseInt((location.hash.match(/^#cam(\d+)$/) || [])[1], 10) || 1) - 1));
  select(start);
  if (lightMode()) stop("Economia de dados ativada: toque para assistir.");
  else play();
})();
