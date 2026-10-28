/* Buscar PY — menu lateral de categorias (celular). Abre pela esquerda no botão ☰ do cabeçalho e fecha
   no X, no Esc, tocando fora dele ou ao escolher uma categoria. No computador ele não aparece: as categorias
   ficam na barra embaixo da busca. */
(function () {
  "use strict";
  const dlg = document.getElementById("menu"), btn = document.getElementById("menuBtn");
  if (!dlg || !btn) return;
  // navegador sem <dialog>: a barra de categorias volta a aparecer no lugar do botão
  if (typeof dlg.showModal !== "function") { document.documentElement.classList.add("no-drawer"); return; }

  const root = document.documentElement;
  const reduceMotion = () => { try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { return false; } };
  let closing = null;

  function open() {
    if (dlg.open) return;
    dlg.classList.remove("is-closing");
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
    let timer = 0;
    // só a animação do próprio painel conta (não a do fundo nem a do ponto "ao vivo" dos links)
    const onEnd = (e) => { if (e.target === dlg && !e.pseudoElement) finish(); };
    const finish = () => {
      dlg.removeEventListener("animationend", onEnd);
      clearTimeout(timer);
      if (!closing) return;
      const list = closing; closing = null;
      dlg.classList.remove("is-closing");
      dlg.close();
      list.forEach((f) => f());
    };
    if (reduceMotion()) return finish();
    dlg.classList.add("is-closing");
    dlg.addEventListener("animationend", onEnd);
    timer = setTimeout(finish, 300); // garantia, caso a animação não rode
  }
  function setCurrent(id) {
    dlg.querySelectorAll("#menuCats [data-cat]").forEach((a) => {
      if ((a.dataset.cat || null) === (id || null)) a.setAttribute("aria-current", "true");
      else a.removeAttribute("aria-current");
    });
  }

  btn.addEventListener("click", open);
  document.getElementById("menuClose").addEventListener("click", () => close());
  // toque fora do painel (no fundo escurecido)
  dlg.addEventListener("click", (e) => { if (e.target === dlg) close(); });
  // Esc: fecha com a mesma animação
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); close(); });
  dlg.addEventListener("close", () => {
    root.classList.remove("menu-open");
    btn.setAttribute("aria-expanded", "false");
  });
  // virou o celular ou alargou a janela até o tamanho de computador: o menu não existe lá
  try {
    const wide = window.matchMedia("(min-width: 761px)");
    const onWide = () => { if (wide.matches && dlg.open) { closing = null; dlg.classList.remove("is-closing"); dlg.close(); } };
    wide.addEventListener ? wide.addEventListener("change", onWide) : wide.addListener(onWide);
  } catch (e) { /* ignorado */ }

  window.BuscaMenu = { open, close, setCurrent };
})();
