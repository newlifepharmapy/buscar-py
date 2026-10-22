// Login do painel admin: uma senha (variável ADMIN_PASSWORD) e um cookie de sessão assinado.
// Sem banco de dados: o cookie carrega a validade, a hora em que foi emitido e uma assinatura HMAC
// que só o servidor sabe gerar. "Sair" encerra todas as sessões emitidas até aquele momento.
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const COOKIE = "bpy_admin";
const TTL_MS = 12 * 60 * 60 * 1000;     // a sessão vale 12 horas
const WINDOW_MS = 15 * 60 * 1000;       // janela de contagem de senhas erradas
const MAX_PER_IP = 8;                   // tentativas erradas por IP na janela (depois disso, bloqueio)
const MAX_GLOBAL = 40;                  // tentativas erradas somando todos os IPs (só deixa as respostas mais lentas)

const sha = (s) => crypto.createHash("sha256").update(s).digest();

// IP de quem fez o pedido. CF-Connecting-IP só vale com TRUST_CLOUDFLARE=1: sem a Cloudflare na frente,
// qualquer um poderia inventar esse cabeçalho e trocar de "IP" a cada tentativa.
function clientIp(req, trustCloudflare = process.env.TRUST_CLOUDFLARE === "1") {
  const cf = req.headers["cf-connecting-ip"];
  if (trustCloudflare && cf) return String(cf).trim();
  const xff = req.headers["x-forwarded-for"];
  // o Railway acrescenta o IP de quem conectou no fim da lista; o começo pode ter sido inventado pelo cliente
  if (xff) { const last = String(xff).split(",").pop().trim(); if (last) return last; }
  return (req.socket && req.socket.remoteAddress) || "?";
}

class Auth {
  constructor({ password, secret, dir }) {
    this.password = password || "";
    // Chave das assinaturas: SESSION_SECRET, ou uma chave aleatória guardada no disco (para as sessões
    // sobreviverem a um reinício). Ela é misturada à senha: trocar a senha derruba todas as sessões.
    let key = secret || "";
    if (!key && dir) {
      const f = path.join(dir, ".session-key");
      try { key = fs.readFileSync(f, "utf8").trim(); } catch (e) {
        key = crypto.randomBytes(32).toString("hex");
        try { fs.writeFileSync(f, key, { mode: 0o600 }); } catch (e2) { /* só em memória */ }
      }
    }
    if (!key) key = crypto.randomBytes(32).toString("hex");
    this.key = sha(key + "\u0000" + this.password);
    // Sessões emitidas até este instante não valem mais (gravado ao clicar em "Sair").
    this.revokedFile = dir ? path.join(dir, ".sessions-after") : null;
    this.revokedBefore = 0;
    if (this.revokedFile) {
      try { this.revokedBefore = Number(fs.readFileSync(this.revokedFile, "utf8").trim()) || 0; } catch (e) { /* nenhuma saída ainda */ }
    }
    this.fails = new Map(); // ip -> [timestamps]
    this.globalFails = [];  // só as últimas MAX_GLOBAL, em ordem
  }

  get enabled() { return this.password.length >= 8; }

  sign(payload) { return crypto.createHmac("sha256", this.key).update(payload).digest("base64url"); }

  // Formato: v2.<validade>.<emitido em>.<aleatório>.<assinatura>
  issue(now = Date.now()) {
    const at = Math.max(now, this.revokedBefore + 1); // uma sessão nova nunca nasce já encerrada
    const payload = `v2.${at + TTL_MS}.${at}.${crypto.randomBytes(9).toString("base64url")}`;
    return `${payload}.${this.sign(payload)}`;
  }

  verify(token, now = Date.now()) {
    if (!this.enabled || typeof token !== "string") return false;
    const i = token.lastIndexOf(".");
    if (i < 0) return false;
    const payload = token.slice(0, i), sig = Buffer.from(token.slice(i + 1));
    const good = Buffer.from(this.sign(payload));
    if (sig.length !== good.length || !crypto.timingSafeEqual(sig, good)) return false;
    const [v, exp, at] = payload.split(".");
    return v === "v2" && Number(exp) > now && Number(at) > this.revokedBefore;
  }

  // Encerra todas as sessões emitidas até agora (em qualquer aparelho).
  revokeAll(now = Date.now()) {
    this.revokedBefore = Math.max(this.revokedBefore, now);
    if (!this.revokedFile) return;
    try {
      const tmp = this.revokedFile + "." + process.pid + ".tmp";
      fs.writeFileSync(tmp, String(this.revokedBefore), { mode: 0o600 });
      fs.renameSync(tmp, this.revokedFile);
    } catch (e) { /* disco só de leitura: vale até o próximo reinício */ }
  }

  // Bloqueio temporário deste IP depois de muitas senhas erradas.
  blocked(ip, now = Date.now()) {
    const recent = (this.fails.get(ip) || []).filter((t) => now - t < WINDOW_MS);
    return recent.length >= MAX_PER_IP;
  }

  // Muitas senhas erradas somando todos os IPs (ataque de vários lugares). Não bloqueia ninguém,
  // senão bastaria errar a senha de propósito para trancar o dono do site fora do painel:
  // o servidor só demora mais para responder.
  throttled(now = Date.now()) {
    return this.globalFails.length >= MAX_GLOBAL && now - this.globalFails[0] < WINDOW_MS;
  }

  check(password, ip, now = Date.now()) {
    if (!this.enabled || this.blocked(ip, now)) return false;
    const ok = typeof password === "string" && crypto.timingSafeEqual(sha(password), sha(this.password));
    if (ok) { this.fails.delete(ip); return true; }
    const list = (this.fails.get(ip) || []).filter((t) => now - t < WINDOW_MS);
    list.push(now); this.fails.set(ip, list);
    this.globalFails.push(now);
    if (this.globalFails.length > MAX_GLOBAL) this.globalFails.shift();
    // não deixa a memória crescer sem limite: primeiro tira os IPs sem erro recente
    if (this.fails.size > 5000) {
      for (const [k, v] of this.fails) if (now - v[v.length - 1] >= WINDOW_MS) this.fails.delete(k);
      if (this.fails.size > 5000) this.fails.clear();
    }
    return false;
  }

  cookie(token, secure) {
    const attrs = [`${COOKIE}=${token}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${Math.floor(TTL_MS / 1000)}`];
    if (secure) attrs.push("Secure");
    return attrs.join("; ");
  }
  clearCookie(secure) {
    return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;
  }
  tokenFrom(req) {
    const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(req.headers.cookie || "");
    return m ? m[1] : null;
  }
}

module.exports = { Auth, COOKIE, clientIp };
