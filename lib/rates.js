// Cotação do dólar em real (BRL) e guarani (PYG), atualizada sozinha no servidor.
// Fonte principal: a cotação que o Google mostra (Google Finance). Se ela falhar ou vier fora do
// esperado, tenta as reservas na ordem. Os visitantes recebem o valor pronto em /api/rates, então
// o Google é consultado só pelo servidor (2 consultas a cada 5 minutos), nunca pelo navegador.
"use strict";
const fs = require("fs");
const path = require("path");

const CURRENCIES = ["BRL", "PYG"];
// Faixas plausíveis: um número fora delas é erro de leitura, não cotação.
const BOUNDS = { BRL: [2, 15], PYG: [3000, 15000] };
const JUMP = 0.10;   // mudança maior que 10% de uma vez precisa ser confirmada por outra fonte
const AGREE = 0.03;  // duas fontes "concordam" se a diferença for de até 3%
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

// Página de cotação do Google Finance. O valor vem em data-last-price="5.4321", sem formatação de idioma.
function parseGoogle(html, cur) {
  const tags = html.match(/<[^>]*\sdata-last-price="[0-9.]+"[^>]*>/g) || [];
  const tag = tags.find((t) => t.includes(`"${cur}"`)) || tags[0];
  if (tag) return Number(/data-last-price="([0-9.]+)"/.exec(tag)[1]);
  const m = /class="YMlKec fxKbKc"[^>]*>([0-9.,]+)</.exec(html); // o número grande da página (em inglês)
  return m ? Number(m[1].replace(/,/g, "")) : NaN;
}

const SOURCES = [
  {
    id: "google", label: "Google",
    url: (cur) => `https://www.google.com/finance/quote/USD-${cur}?hl=en`,
    headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", Accept: "text/html", Cookie: "CONSENT=YES+1" },
    parse: (txt, cur) => parseGoogle(txt, cur),
  },
  {
    id: "awesomeapi", label: "AwesomeAPI",
    url: (cur) => `https://economia.awesomeapi.com.br/json/last/USD-${cur}`,
    parse: (txt, cur) => { const j = JSON.parse(txt)[`USD${cur}`]; return j ? Number(j.bid) : NaN; },
  },
  {
    id: "er-api", label: "ExchangeRate-API",
    url: () => "https://open.er-api.com/v6/latest/USD",
    parse: (txt, cur) => { const j = JSON.parse(txt); return j && j.rates ? Number(j.rates[cur]) : NaN; },
  },
];

async function fetchText(url, headers, timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: headers || { "User-Agent": UA }, signal: ctl.signal, redirect: "follow" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    // uma página de consentimento ou de bloqueio não tem a cotação: o parse devolve NaN e a reserva assume
    return await r.text();
  } finally { clearTimeout(t); }
}

class Rates {
  // opts: { dir, intervalMs, timeoutMs, sources, now }
  constructor(opts = {}) {
    this.intervalMs = opts.intervalMs || 5 * 60 * 1000;
    this.timeoutMs = opts.timeoutMs || 8000;
    this.sources = opts.sources || SOURCES;
    this.file = opts.dir ? path.join(opts.dir, "rates.json") : null;
    this.now = opts.now || (() => Date.now());
    this.state = { BRL: null, PYG: null };   // { value, source, at }
    this.errors = {};                          // "BRL:google" -> mensagem da última falha
    this.lastRun = null; this.nextRun = null;
    this.running = null; this.timer = null;
    this.listeners = [];
    if (this.file) {
      try {
        const saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
        for (const c of CURRENCIES) {
          const s = saved[c];
          // reaproveita a última cotação gravada, se for de menos de 24 h e plausível
          if (s && this.plausible(c, s.value) && this.now() - Date.parse(s.at) < 864e5) this.state[c] = s;
        }
      } catch (e) { /* primeira execução */ }
    }
  }

  plausible(cur, v) { return typeof v === "number" && Number.isFinite(v) && v >= BOUNDS[cur][0] && v <= BOUNDS[cur][1]; }
  onChange(fn) { this.listeners.push(fn); }

  async read(src, cur, cache) {
    const url = src.url(cur);
    try {
      if (!cache.has(url)) cache.set(url, fetchText(url, src.headers, this.timeoutMs));
      const v = src.parse(await cache.get(url), cur);
      if (!this.plausible(cur, v)) throw new Error(Number.isFinite(v) ? `valor fora da faixa (${v})` : "cotação não encontrada na resposta");
      delete this.errors[`${cur}:${src.id}`];
      return v;
    } catch (e) {
      const msg = e.name === "AbortError" ? `sem resposta em ${this.timeoutMs / 1000} s`
        : e.message === "fetch failed" ? "não foi possível conectar" : e.message;
      this.errors[`${cur}:${src.id}`] = msg.slice(0, 160);
      return null;
    }
  }

  // Tenta as fontes em ordem. Um salto grande em relação ao valor anterior só vale se outra fonte confirmar.
  async pick(cur, cache) {
    const prev = this.state[cur] && this.state[cur].value;
    let jump = null; // primeiro valor que saltou, à espera de confirmação
    for (const src of this.sources) {
      const v = await this.read(src, cur, cache);
      if (v == null) continue;
      if (!prev || Math.abs(v / prev - 1) <= JUMP) return { value: v, source: src.id };
      if (jump && Math.abs(v / jump.value - 1) <= AGREE) return jump; // duas fontes confirmam o salto
      if (!jump) jump = { value: v, source: src.id };
    }
    if (jump) this.errors[`${cur}:salto`] = `ignorado ${jump.value} (${jump.source}): mudou mais de 10% e nenhuma outra fonte confirmou`;
    return null;
  }

  refresh() {
    if (this.running) return this.running;
    this.running = (async () => {
      const cache = new Map();
      let changed = false;
      for (const cur of CURRENCIES) {
        const got = await this.pick(cur, cache);
        if (!got) continue;
        delete this.errors[`${cur}:salto`];
        const old = this.state[cur];
        this.state[cur] = { value: got.value, source: got.source, at: new Date(this.now()).toISOString() };
        if (!old || old.value !== got.value) changed = true;
      }
      this.lastRun = new Date(this.now()).toISOString();
      if (this.file) {
        try {
          const tmp = this.file + "." + process.pid + ".tmp";
          fs.writeFileSync(tmp, JSON.stringify(this.state));
          fs.renameSync(tmp, this.file);
        } catch (e) { /* disco só de leitura: segue em memória */ }
      }
      if (changed) for (const fn of this.listeners) fn(this.state);
      return this.state;
    })().finally(() => { this.running = null; });
    return this.running;
  }

  start() {
    const tick = () => {
      this.nextRun = new Date(this.now() + this.intervalMs).toISOString();
      this.refresh().catch((e) => console.error("cotação:", e.message));
    };
    tick();
    this.timer = setInterval(tick, this.intervalMs);
    this.timer.unref();
  }
  stop() { clearInterval(this.timer); }

  // Valor usado no site. Automático: a última cotação lida (ou o valor manual, se nunca leu nenhuma).
  effective(settings) {
    const r = settings.rates;
    if (!r.auto) return { BRL: r.BRL, PYG: r.PYG, source: "manual", at: null, auto: false };
    const b = this.state.BRL, p = this.state.PYG;
    const at = [b, p].filter(Boolean).map((x) => x.at).sort()[0] || null;
    const sources = [...new Set([b, p].filter(Boolean).map((x) => x.source))];
    return {
      BRL: b ? b.value : r.BRL, PYG: p ? p.value : r.PYG,
      source: sources.length ? sources.join("+") : "manual", at, auto: true,
    };
  }

  status() {
    return {
      state: this.state, lastRun: this.lastRun, nextRun: this.nextRun, intervalMs: this.intervalMs,
      errors: this.errors, sources: this.sources.map((s) => ({ id: s.id, label: s.label })),
    };
  }
}

module.exports = { Rates, SOURCES, parseGoogle, BOUNDS };
