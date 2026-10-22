/* Buscar PY — câmeras ao vivo, no modo mais leve possível:
 * - só existe um player aberto por vez (trocar de câmera fecha o anterior);
 * - o player é removido quando a aba fica escondida e volta quando ela reaparece;
 * - depois de 10 minutos assistindo, pausa e pergunta se a pessoa quer continuar;
 * - com "economia de dados" ligada ou conexão 2G, não abre sozinho: espera um toque;
 * - as setas do teclado só trocam a câmera escolhida; o player novo abre quando a pessoa para de apertar. */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var tabs = Array.prototype.slice.call(document.querySelectorAll(".cam-tab"));
  var stage = $("camStage"), cover = $("camCover"), coverTitle = $("camCoverTitle"), coverMsg = $("camCoverMsg");
  var playBtn = $("camPlay"), toggle = $("camToggle"), full = $("camFull"), openLink = $("camOpen"), live = $("camLive");
  var status = $("camStatus");
  var IDLE_MS = 10 * 60 * 1000, KEY_MS = 400;
  var current = 0, frame = null, idleTimer = null, keyTimer = null, resumeOnShow = false;

  // Avisos para leitores de tela (o elemento fica sempre na página, fora da capa que some e aparece).
  function say(text) { if (status) status.textContent = text; }

  if (!tabs.length) {
    coverMsg.textContent = "Nenhuma câmera cadastrada no momento.";
    say(coverMsg.textContent);
    return;
  }

  function connection() { return navigator.connection || navigator.mozConnection || navigator.webkitConnection || {}; }
  function lightMode() {
    var c = connection();
    return !!(c.saveData || /(^|-)2g$/.test(c.effectiveType || ""));
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

  // Fecha o player e cancela o que estava agendado, sem mexer no resto da tela.
  function close() {
    clearTimeout(idleTimer);
    clearTimeout(keyTimer);
    keyTimer = null;
    if (frame) {
      frame.src = "about:blank"; // corta o vídeo na hora, antes de remover o elemento
      frame.remove();
      frame = null;
    }
  }

  // Mostra a capa por cima do palco. Se o foco estava no "Pausar", que vai sumir, ele passa para o "Assistir".
  function showCover(msg, canPlay) {
    var refocus = document.activeElement === toggle;
    cover.hidden = false;
    coverMsg.textContent = msg;
    playBtn.hidden = !canPlay;
    toggle.hidden = true;
    live.hidden = true;
    if (refocus && canPlay) playBtn.focus();
  }

  function stop(msg) {
    close();
    msg = msg || "Câmera pausada.";
    showCover(msg, true);
    say(msg);
  }

  function play() {
    // o "Assistir ao vivo" fica dentro da capa, que vai sumir: o foco passa para o "Pausar"
    var refocus = cover.contains(document.activeElement);
    close();
    var t = tabs[current], name = t.textContent;
    frame = document.createElement("iframe");
    frame.className = "cam-frame";
    frame.title = "Câmera ao vivo: " + name;
    frame.allow = "autoplay; fullscreen; picture-in-picture";
    frame.setAttribute("allowfullscreen", "");
    frame.referrerPolicy = "strict-origin-when-cross-origin";
    frame.src = t.getAttribute("data-src");
    stage.appendChild(frame);
    cover.hidden = true;
    toggle.hidden = false;
    live.hidden = false;
    if (refocus) toggle.focus();
    say("Câmera ao vivo: " + name);
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
    // Setas, Home e End entre as abas, como em qualquer lista de abas. Elas só trocam a câmera escolhida:
    // se havia uma tocando, a nova abre quando a pessoa para de apertar, e não um player a cada tecla.
    t.addEventListener("keydown", function (e) {
      var k = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (e.key === "Home") k = -current;
      if (e.key === "End") k = tabs.length - 1 - current;
      if (k == null) return;
      e.preventDefault();
      var next = (current + k + tabs.length) % tabs.length;
      if (next === current) return;
      var wasPlaying = !!frame || keyTimer !== null;
      select(next, true);
      if (!wasPlaying) return; // pausada (ou economia de dados): o "Assistir ao vivo" abre a câmera escolhida
      close();
      showCover("Abrindo a câmera…", false);
      keyTimer = setTimeout(function () { keyTimer = null; play(); }, KEY_MS);
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
      if (frame || keyTimer !== null) { resumeOnShow = true; stop("Câmera pausada enquanto você estava em outra aba."); }
    } else if (resumeOnShow) {
      resumeOnShow = false;
      play();
    }
  });
  // Ao sair da página (inclusive pelo botão voltar com cache), garante que nada fica tocando.
  window.addEventListener("pagehide", function () { if (frame || keyTimer !== null) stop(); });

  var start = Math.max(0, Math.min(tabs.length - 1, (parseInt((location.hash.match(/^#cam(\d+)$/) || [])[1], 10) || 1) - 1));
  select(start);
  if (lightMode()) stop(connection().saveData ? "Economia de dados ativada: toque para assistir." : "Conexão lenta detectada: toque para assistir.");
  else play();
})();
