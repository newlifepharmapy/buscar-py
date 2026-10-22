// Login do painel admin: uma senha (variável ADMIN_PASSWORD) e um cookie de sessão assinado.
// Sem banco de dados: o cookie carrega a validade e uma assinatura HMAC que só o servidor sabe gerar.
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const COOKIE = "bpy_admin";
const TTL_MS = 12 * 60 * 60 * 1000;     // a sessão vale 12 horas
const WINDOW_MS = 15 * 60 * 1000;       // janela de contagem de senhas erradas
const MAX_PER_IP = 8;                   // tentativas erradas por IP na janela
const MAX_GLOBAL = 40;                  // tentativas erradas somando todos os IPs (freia ataques distribuídos)

const sha = (s) => crypto.createHash("sha256").update(s).digest();

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
    this.fails = new Map(); // ip -> [timestamps]
    this.globalFails = [];
  }

  get enabled() { return this.password.length >= 8; }

  sign(payload) { return crypto.createHmac("sha256", this.key).update(payload).digest("base64url"); }

  issue(now = Date.now()) {
    const payload = `v1.${now + TTL_MS}.${crypto.randomBytes(9).toString("base64url")}`;
    return `${payload}.${this.sign(payload)}`;
  }

  verify(token, now = Date.now()) {
    if (!this.enabled || typeof token !== "string") return false;
    const i = token.lastIndexOf(".");
    if (i < 0) return false;
    const payload = token.slice(0, i), sig = Buffer.from(token.slice(i + 1));
    const good = Buffer.from(this.sign(payload));
    if (sig.length !== good.length || !crypto.timingSafeEqual(sig, good)) return false;
    const [v, exp] = payload.split(".");
    return v === "v1" && Number(exp) > now;
  }

  // Bloqueio temporário depois de muitas senhas erradas.
  blocked(ip, now = Date.now()) {
    const recent = (this.fails.get(ip) || []).filter((t) => now - t < WINDOW_MS);
    this.globalFails = this.globalFails.filter((t) => now - t < WINDOW_MS);
    return recent.length >= MAX_PER_IP || this.globalFails.length >= MAX_GLOBAL;
  }

  check(password, ip, now = Date.now()) {
    if (!this.enabled || this.blocked(ip, now)) return false;
    const ok = typeof password === "string" && crypto.timingSafeEqual(sha(password), sha(this.password));
    if (ok) { this.fails.delete(ip); return true; }
    const list = (this.fails.get(ip) || []).filter((t) => now - t < WINDOW_MS);
    list.push(now); this.fails.set(ip, list); this.globalFails.push(now);
    if (this.fails.size > 5000) this.fails.clear(); // não deixa a memória crescer sem limite
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

module.exports = { Auth, COOKIE };
