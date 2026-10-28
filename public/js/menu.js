/* Buscar PY — menu lateral de categorias (celular). Abre pela esquerda no botão ☰ do cabeçalho e fecha
   no X, no Esc, tocando fora dele ou ao escolher uma categoria ou um atalho. No computador ele não aparece:
   as categorias ficam na barra embaixo da busca. */
(function () {
  "use strict";
  const dlg = document.getElementById("menu"), btn = document.getElementById("menuBtn");
  if (!dlg || !btn) return;
  // navegador sem <dialog>: a barra de categorias volta a aparecer no lugar do botão
  if (typeof dlg.showModal !== "function") { document.documentElement.classList.add("no-drawer"); return; }

  const root = document.documentElement;
  const reduceMotion = () => { try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { return false; } };
  let closing = null, closeTimer = 0; // fechamento em andamento: o que roda quando ele terminar

  // só a animação do próprio painel conta (não a do fundo nem a do ponto "ao vivo" dos links)
  const onEnd = (e) => { if (closing && e.target === dlg && !e.pseudoElement) finish(); };
  // fecha de vez (se ainda estiver aberto) e roda o que estava esperando
  function finish() {
    clearTimeout(closeTimer);
    dlg.removeEventListener("animationend", onEnd);
    dlg.classList.remove("is-closing");
    const list = closing || []; closing = null;
    if (dlg.open) dlg.close();
    list.forEach((f) => f());
  }

  function open() {
    if (dlg.open) return;
    if (closing) finish(); // o painel fechou sem esperar a animação: encerra aquele fechamento
    dlg.showModal();
    root.classList.add("menu-open");
    btn.setAttribute("aria-expanded", "true");
    // a categoria escolhida fica à vista, mesmo no fim da lista
    const cur = dlg.querySelector('#menuCats [aria-current="true"]');
    if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: "nearest" });
  }
  // fecha deslizando para a esquerda; depois chama "then" (ex.: rolar até os resultados)
  function close(then) {
    const done = typeof then === "function" ? then : null;
    if (!dlg.open) { if (done) done(); return; }
    if (closing) { if (done) closing.push(done); return; }
    closing = done ? [done] : [];
    if (reduceMotion()) return finish();
    dlg.classList.add("is-closing");
    dlg.addEventListener("animationend", onEnd);
    closeTimer = setTimeout(finish, 300); // garantia, caso a animação não rode
  }
  function setCurrent(id) {
    dlg.querySelectorAll("#menuCats [data-cat]").forEach((a) => {
      if ((a.dataset.cat || null) === (id || null)) a.setAttribute("aria-current", "true");
      else a.removeAttribute("aria-current");
    });
  }

  btn.addEventListener("click", open);
  document.getElementById("menuClose").addEventListener("click", () => close());
  dlg.addEventListener("click", (e) => {
    // toque fora do painel (no fundo escurecido)
    if (e.target === dlg) return close();
    // um atalho (ex.: /#how, que só rola a página) também fecha o menu; as categorias o app.js já fecha
    const a = e.target.closest("a[href]");
    if (a && !a.target && !e.defaultPrevented && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) close();
  });
  // Esc: fecha com a mesma animação. Um segundo Esc seguido o navegador não deixa segurar: fecha na hora.
  dlg.addEventListener("cancel", (e) => { if (!e.cancelable) return; e.preventDefault(); close(); });
  dlg.addEventListener("close", () => {
    if (dlg.open) return; // já foi aberto de novo
    root.classList.remove("menu-open");
    btn.setAttribute("aria-expanded", "false");
    if (closing) finish(); // fechou sem a animação: o que esperava por ela roda agora
  });
  // virou o celular ou alargou a janela até o tamanho de computador: o menu não existe lá
  try {
    const wide = window.matchMedia("(min-width: 761px)");
    const onWide = () => { if (wide.matches && dlg.open) finish(); };
    wide.addEventListener ? wide.addEventListener("change", onWide) : wide.addListener(onWide);
  } catch (e) { /* ignorado */ }

  window.BuscaMenu = { open, close, setCurrent };
})();
