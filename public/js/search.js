/*
 * Buscar PY — busca por texto.
 * Sem acentos, tolerante a erros de digitação (distância de edição 1) e com sinônimos
 * português/espanhol -> termos do catálogo (que veio em inglês).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.BuscaText = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const SYN = {
    fone: ["headphones", "headphone", "earphones", "earbuds", "headset", "fones"], fones: ["headphones", "earphones", "earbuds"],
    auricular: ["headphones", "earphones"], audifono: ["headphones", "earphones", "earbuds"], headset: ["headphones"],
    caixa: ["speaker", "speakers"], parlante: ["speaker"], som: ["speaker", "audio"], alto: ["speaker"], falante: ["speaker"],
    cabo: ["cable", "cord"], cable: ["cable"], carregador: ["charger", "charging"], cargador: ["charger"],
    teclado: ["keyboard"], relogio: ["watch"], reloj: ["watch"],
    mochila: ["backpack", "daypack"], mala: ["suitcase", "luggage", "bag"], maleta: ["suitcase", "luggage"],
    bolsa: ["handbag", "bag", "tote", "crossbody", "clutch", "satchel"], cartera: ["wallet", "handbag"], carteira: ["wallet", "purse"],
    tenis: ["sneaker", "sneakers", "shoe", "shoes", "trainers", "running"], zapatilla: ["sneaker", "sneakers", "shoe", "shoes", "trainers"], sapato: ["shoe", "shoes", "loafer", "oxford"], zapato: ["shoe", "shoes"], calcado: ["shoe", "shoes"],
    bota: ["boot", "boots"], botas: ["boot", "boots"], sandalia: ["sandal", "sandals", "slide"], chinelo: ["slipper", "slide", "flip"],
    luminaria: ["lamp", "led"], luz: ["lamp", "led"], lampada: ["bulb", "lamp"], lampara: ["lamp"], abajur: ["lamp"], frigideira: ["pan", "fry", "skillet"], panela: ["pan", "pot", "wok", "cookware"], sarten: ["pan", "skillet"],
    capinha: ["case", "cover"], capa: ["case", "cover"], funda: ["case", "cover"], celular: ["mobile", "phone"],
    couro: ["leather"], cuero: ["leather"], masculino: ["men", "mens"], homem: ["men", "mens"], hombre: ["men", "mens"],
    feminino: ["women", "womens"], mulher: ["women", "womens"], mujer: ["women", "womens"], infantil: ["kids", "girls", "boys"],
    sem: ["wireless"], fio: ["wireless"], inalambrico: ["wireless"], bluetooth: ["bluetooth", "wireless"],
    preto: ["black"], negro: ["black"], branco: ["white"], blanco: ["white"],
    azul: ["blue", "navy"], vermelho: ["red"], rojo: ["red"], verde: ["green"], rosa: ["pink", "rose"],
    marrom: ["brown", "tan"], marron: ["brown"], cinza: ["grey", "gray"], gris: ["grey", "gray"], dourado: ["gold"], dorado: ["gold"],
    prata: ["silver"], plata: ["silver"], amarelo: ["yellow"], amarillo: ["yellow"], roxo: ["purple", "violet"], bege: ["beige", "tan", "taupe"],
    morado: ["purple", "violet"], celeste: ["blue", "sky"], naranja: ["orange"], laranja: ["orange"], viagem: ["travel"], viaje: ["travel"], gamer: ["gaming"], jogo: ["gaming"], mecanico: ["mechanical"], digital: ["digital"],
    de: [], da: [], do: [], para: [], com: [], con: [], e: [], y: [], o: [], a: [],
  };

  function norm(s) {
    return (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  }
  function tokens(s) { return norm(s).split(" ").filter(Boolean); }

  // Distância de edição até 1, contando troca de duas letras vizinhas como um erro (mochlia -> mochila)
  function within1(a, b) {
    if (Math.abs(a.length - b.length) > 1) return false;
    if (a.length === b.length) {
      const diff = [];
      for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) diff.push(k);
      if (diff.length === 2 && diff[1] === diff[0] + 1 && a[diff[0]] === b[diff[1]] && a[diff[1]] === b[diff[0]]) return true;
    }
    let i = 0, j = 0, edits = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { i++; j++; continue; }
      if (++edits > 1) return false;
      if (a.length > b.length) i++;
      else if (a.length < b.length) j++;
      else { i++; j++; }
    }
    return edits + (a.length - i) + (b.length - j) <= 1;
  }

  // Cada documento: {id, fields: [{text, weight}]}
  function buildIndex(docs) {
    const vocab = new Set();
    const index = docs.map((d) => {
      const toks = new Map();
      for (const f of d.fields) for (const t of tokens(f.text)) { toks.set(t, Math.max(toks.get(t) || 0, f.weight)); vocab.add(t); }
      return { id: d.id, toks };
    });
    index.vocab = vocab;
    return index;
  }

  // strict = sinônimo gerado por nós: só vale palavra exata ou plural, sem prefixo solto nem erro de digitação
  // (evita "light" casar com "lightweight" ou "sneaker" com "speaker").
  function matchTerm(term, toks, strict) {
    let best = 0;
    for (const [t, w] of toks) {
      let s = 0;
      if (t === term) s = 3;
      else if (term.length >= 4 && t.startsWith(term) && t.length - term.length <= 2) s = 2.8; // plural/flexão
      else if (strict) continue;
      else if (term.length >= 3 && t.startsWith(term)) s = 2;
      else if (term.length >= 5 && within1(term, t)) s = 1.2;
      if (s * w > best) best = s * w;
    }
    return best;
  }

  // Formas de base de uma palavra em português/espanhol: plural -> singular, feminino -> masculino
  // (mochilas -> mochila, relojes -> reloj, blancas -> blanco, vermelha -> vermelho).
  function baseForms(t) {
    const out = [t];
    const add = (w) => { if (w.length >= 3 && !out.includes(w)) out.push(w); };
    if (t.endsWith("oes")) add(t.slice(0, -3) + "ao");
    if (t.endsWith("es")) add(t.slice(0, -2));
    if (t.endsWith("s")) add(t.slice(0, -1));
    for (const w of out.slice()) if (w.endsWith("a")) add(w.slice(0, -1) + "o");
    return out;
  }
  // Correção de digitação só para nomes de produto: em cores e gêneros ela trocaria uma palavra válida por outra
  // (rosa/roxo, mulher/muller). E as duas primeiras letras precisam bater.
  const FUZZY_KEYS = ("auricular audifono headset caixa parlante falante carregador cargador teclado relogio mochila maleta " +
    "bolsa cartera carteira zapatilla sapato zapato calcado sandalia chinelo luminaria lampara abajur frigideira panela " +
    "sarten capinha celular").split(" ");

  function synonymsFor(t, vocab) {
    const forms = baseForms(t);
    for (const f of forms) if (SYN[f]) return { forms, syn: SYN[f] };
    // erro de digitação numa palavra em português/espanhol (ex.: mochlia, relogo), se a palavra não existe no catálogo
    if (t.length >= 5 && !(vocab && vocab.has(t))) {
      const k = FUZZY_KEYS.find((key) => key.slice(0, 2) === t.slice(0, 2) && within1(t, key));
      if (k) return { forms: [t, k], syn: SYN[k] };
    }
    return { forms, syn: null };
  }

  // Retorna Map(id -> score). Todos os termos precisam aparecer (cada termo vale pelo melhor sinônimo).
  function search(index, query) {
    const terms = tokens(query).map((t) => {
      const { forms, syn } = synonymsFor(t, index.vocab);
      if (syn && syn.length === 0) return null; // palavra vazia
      // a palavra digitada aceita prefixo e erro; formas derivadas (singular, masculino) e sinônimos, só exata ou plural
      const derived = forms.filter((w) => w !== t && w.length >= 4);
      // sinônimos em ordem de preferência: "tenis" traz primeiro sneaker, depois shoe
      return [[t, false, 1], ...derived.map((w) => [w, true, 1]), ...(syn || []).map((w, i) => [w, true, 1 - 0.03 * i])];
    }).filter(Boolean);
    const out = new Map();
    if (!terms.length) return out;
    for (const doc of index) {
      let total = 0, ok = true;
      for (const alts of terms) {
        let best = 0;
        for (const [a, strict, f] of alts) best = Math.max(best, matchTerm(a, doc.toks, strict) * f);
        if (best === 0) { ok = false; break; }
        total += best;
      }
      if (ok) out.set(doc.id, total);
    }
    return out;
  }

  return { buildIndex, search, norm, tokens };
});
