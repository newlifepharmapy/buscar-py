/*
 * Buscar PY — filtro da página /lojas: nome da loja (sem acento), tipo de loja e "só com produtos aqui".
 * Sem JavaScript a página mostra todas as lojas; a barra de filtros só aparece quando este script roda.
 */
(function () {
  "use strict";
  const tools = document.getElementById("storeTools");
  if (!tools) return;
  const q = document.getElementById("storeQ"), spec = document.getElementById("storeSpec"), only = document.getElementById("storeOnly");
  const count = document.getElementById("storeCount"), none = document.getElementById("storeNone");
  const cards = Array.from(document.querySelectorAll(".store-card"));
  const fold = (t) => String(t).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  const word = (n) => `${n.toLocaleString("pt-BR")} ${n === 1 ? "loja" : "lojas"}`;
  if (!cards.some((c) => !c.hasAttribute("data-has"))) only.closest("label").remove();
  tools.hidden = false;

  function apply() {
    const t = fold(q.value), sp = spec.value, mine = only.checked;
    let n = 0;
    for (const c of cards) {
      const ok = (!t || c.dataset.name.includes(t)) && (!sp || c.dataset.spec === sp) && (!mine || c.hasAttribute("data-has"));
      c.hidden = !ok;
      if (ok) n++;
    }
    count.textContent = n === cards.length ? word(n) : `${word(n)} de ${cards.length.toLocaleString("pt-BR")}`;
    none.hidden = n > 0;
  }
  q.addEventListener("input", apply);
  spec.addEventListener("change", apply);
  only.addEventListener("change", apply);
  // vindo de um link /lojas#loja: a loja aparece mesmo com o navegador lembrando um filtro antigo
  if (location.hash && document.getElementById(decodeURIComponent(location.hash.slice(1)))) { q.value = ""; spec.value = ""; only.checked = false; }
  apply();
})();
