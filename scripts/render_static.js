// Monta uma página de views/ com as configurações padrão (sem servidor), para a versão de demonstração.
// Uso: node scripts/render_static.js index.html > saida.html
"use strict";
const { render } = require("../lib/render");
const { sanitize } = require("../lib/settings");
const s = sanitize({});
process.stdout.write(render(process.argv[2] || "index.html", s, { BRL: s.rates.BRL, PYG: s.rates.PYG, source: "manual", at: "" }, { server: false, path: "/" }));
