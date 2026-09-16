// PaperTradeWars arena — human-vs-AI scoreboard for the TikTok series.
// Server-rendered, libsql (Turso remote or local SQLite file), no build step.
// Simulated portfolios for entertainment. Not financial advice.
import express from "express";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { client, initDb, nowIso, nanoid, dbMode } from "./db.mjs";
import { scorePortfolio, compareRanked } from "./scoring.mjs";

await initDb();

const PORT = Number(process.env.PORT || 3000);
const ADMIN_SECRET = process.env.ADMIN_SECRET || "changeme";
const SITE_TITLE = process.env.SITE_TITLE || "PaperTradeWars";

if (ADMIN_SECRET === "changeme") {
  console.warn("⚠️  ADMIN_SECRET is the default — set a real one in production!");
}

// ---------------------------------------------------------------- db helpers (async, libsql)
async function one(sql, args = []) {
  const r = await client.execute({ sql, args });
  return r.rows[0] ?? null;
}
async function all(sql, args = []) {
  const r = await client.execute({ sql, args });
  return r.rows;
}
async function run(sql, args = []) {
  return client.execute({ sql, args });
}
// Transactions go through the client's transaction API — never raw BEGIN/COMMIT
// via client.execute(): the file client's connection pool rolls back any
// transaction a borrowed connection still has open when it's released, so a
// manual BEGIN can never survive to the matching COMMIT. Everything inside fn
// must use the scoped db.run/one/all — the global helpers would borrow a
// *different* connection, which is either outside the transaction or, with a
// single-connection pool, a deadlock.
async function txn(fn) {
  const tx = await client.transaction("write");
  const db = {
    run: (sql, args = []) => tx.execute(sql, args),
    one: async (sql, args = []) => (await tx.execute(sql, args)).rows[0] ?? null,
    all: async (sql, args = []) => (await tx.execute(sql, args)).rows,
  };
  try {
    const r = await fn(db);
    await tx.commit();
    return r;
  } catch (e) {
    await tx.rollback().catch(() => {});
    throw e;
  }
}
// Express 4 doesn't catch async errors — wrap every async handler.
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------------------------------------------------------------- helpers
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[c]));

async function currentWeekId() {
  const r = await one("SELECT id FROM weeks ORDER BY id DESC LIMIT 1");
  return Number(r.id);
}
async function getWeek(id) {
  const r = await one("SELECT * FROM weeks WHERE id = ?", [id]);
  if (r) { r.id = Number(r.id); }
  return r;
}
async function listWeeks() {
  const rows = await all("SELECT * FROM weeks ORDER BY id DESC");
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}
async function listAssets() {
  return all("SELECT * FROM assets ORDER BY kind DESC, ticker");
}
async function listPersonas() {
  const rows = await all("SELECT * FROM personas ORDER BY id");
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}
async function aiPicksFor(weekId) {
  const rows = await all(`
    SELECT p.*, a.name AS persona_name, a.emoji, a.color
    FROM ai_picks p JOIN personas a ON a.id = p.persona_id
    WHERE p.week_id = ? ORDER BY p.persona_id, p.slot`, [weekId]);
  return rows.map((r) => ({ ...r, persona_id: Number(r.persona_id), slot: Number(r.slot) }));
}
async function draftsFor(weekId) {
  return all(`SELECT d.*, u.display_name FROM drafts d
    JOIN users u ON u.id = d.user_id WHERE d.week_id = ? ORDER BY d.created_at`, [weekId]);
}
async function pricesFor(weekId) {
  const m = {};
  for (const r of await all("SELECT * FROM prices WHERE week_id = ?", [weekId])) m[r.ticker] = r;
  return m;
}
const MENU_TICKERS = ["MSFT", "AAPL", "NVDA", "TSLA", "AMD", "BTC", "ETH", "SOL", "XRP", "DOGE"];
const VALID_TICKERS = new Set(MENU_TICKERS);
function validatePicks(picks) {
  if (!Array.isArray(picks) || picks.length !== 5) return "Pick exactly 5 tickers.";
  const up = picks.map((t) => String(t).toUpperCase().trim());
  if (up.some((t) => !VALID_TICKERS.has(t))) return "One or more tickers are not on this week's menu.";
  if (new Set(up).size !== 5) return "All 5 picks must be different tickers.";
  return null;
}

// ---------------------------------------------------------------- live price feed
// Stocks: Yahoo Finance v8 chart API (free, no key). Crypto: CoinGecko free API.
// Env overrides exist for QA: YAHOO_URL_TEMPLATE, COINGECKO_URL.
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const YAHOO_URL_TEMPLATE = process.env.YAHOO_URL_TEMPLATE ||
  "https://query1.finance.yahoo.com/v8/finance/chart/{T}?interval=1d&range=1d";
const COINGECKO_URL = process.env.COINGECKO_URL ||
  "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana,ripple,dogecoin&vs_currencies=usd";
const STOCK_TICKERS = ["NVDA", "TSLA", "AAPL", "MSFT", "AMD"];
const CG_ID_TO_TICKER = { bitcoin: "BTC", ethereum: "ETH", solana: "SOL", ripple: "XRP", dogecoin: "DOGE" };

async function fetchWithTimeout(url, ms = 15000, ua = "papertradewars-arena/1.0") {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { "user-agent": ua } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally { clearTimeout(t); }
}

function validPrice(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Returns { prices: {TICKER: number}, failures: [{ticker, source, error}] }.
// A ticker only lands in `prices` when its value parsed AND is a sane positive
// number — failures never overwrite existing values downstream.
async function fetchLivePrices() {
  const prices = {}, failures = [];
  const stockResults = await Promise.allSettled(STOCK_TICKERS.map(async (t) => {
    const body = await fetchWithTimeout(YAHOO_URL_TEMPLATE.replace("{T}", t), 15000, BROWSER_UA);
    let data;
    try { data = JSON.parse(body); } catch { throw new Error("invalid JSON"); }
    const p = validPrice(data?.chart?.result?.[0]?.meta?.regularMarketPrice);
    if (p == null) throw new Error("bad/missing regularMarketPrice");
    return [t, p];
  }));
  stockResults.forEach((r, i) => {
    const t = STOCK_TICKERS[i];
    if (r.status === "fulfilled") prices[r.value[0]] = r.value[1];
    else failures.push({ ticker: t, source: "yahoo", error: String(r.reason?.message || r.reason).slice(0, 120) });
  });
  try {
    const body = await fetchWithTimeout(COINGECKO_URL);
    let data;
    try { data = JSON.parse(body); } catch { throw new Error("invalid JSON"); }
    for (const [id, ticker] of Object.entries(CG_ID_TO_TICKER)) {
      const p = validPrice(data?.[id]?.usd);
      if (p == null) failures.push({ ticker, source: "coingecko", error: "bad/missing usd price" });
      else prices[ticker] = p;
    }
  } catch (e) {
    for (const t of Object.values(CG_ID_TO_TICKER)) failures.push({ ticker: t, source: "coingecko", error: String(e.message || e).slice(0, 120) });
  }
  return { prices, failures };
}

// ---------------------------------------------------------------- price snapshots (audit trail)
async function logSnapshot(weekId, kind, method, prices, failures, ok) {
  const now = new Date();
  const et = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).format(now);
  await run(`INSERT INTO price_snapshots (week_id, kind, method, ok, fetched_at, fetched_at_et, source, values_json, failures_json)
    VALUES (?,?,?,?,?,?,?,?,?)`,
    [weekId, kind, method, ok ? 1 : 0, now.toISOString(), et,
      method === "fetch" ? "yahoo+coingecko" : "manual",
      JSON.stringify(prices), failures.length ? JSON.stringify(failures) : null]);
  return et;
}
async function latestSnapshot(weekId, kind) {
  return one(`SELECT * FROM price_snapshots WHERE week_id=? AND kind=? AND ok=1 ORDER BY id DESC LIMIT 1`, [weekId, kind]);
}
function snapshotLabel(snap) {
  if (!snap) return "not set";
  return `${snap.fetched_at_et} · ${snap.method === "fetch" ? "live fetch" : "manual entry"}`;
}
function snapshotSummary(snap) {
  if (!snap) return null;
  return {
    fetched_at_et: snap.fetched_at_et, method: snap.method, source: snap.source,
    tickers: Object.keys(JSON.parse(snap.values_json)).length,
  };
}

// Applies fetched prices to ONE column (entry or current). Only tickers that
// fetched successfully are touched — failures keep their old values, and
// nothing is ever zeroed out.
async function applyFetchedPrices(weekId, kind, fetched) {
  const col = kind === "entry" ? "entry" : "current"; // kind is internally controlled
  let n = 0;
  await txn(async (db) => {
    for (const [t, v] of Object.entries(fetched)) {
      await db.run(`INSERT INTO prices (week_id,ticker,${col}) VALUES (?,?,?)
        ON CONFLICT(week_id,ticker) DO UPDATE SET ${col}=excluded.${col}`, [weekId, t, v]);
      n++;
    }
  });
  return n;
}

// ---------------------------------------------------------------- helpers (db-backed; pure scoring lives in scoring.mjs)

// Builds the full leaderboard for a week: AI contestants + human drafts, ranked.
// Tie-breaks: 1) fewer losing picks, 2) best single pick, 3) AI before humans, then name.
async function leaderboard(weekId) {
  const prices = await pricesFor(weekId);
  const rows = [];
  const personas = await listPersonas();
  const picks = await aiPicksFor(weekId);
  for (const p of personas) {
    const tickers = picks.filter((k) => k.persona_id === p.id).map((k) => k.ticker);
    if (tickers.length !== 5) continue;
    rows.push({
      kind: "ai", name: p.name, emoji: p.emoji, color: p.color,
      tickers, score: scorePortfolio(tickers, prices),
    });
  }
  for (const d of await draftsFor(weekId)) {
    const tickers = JSON.parse(d.picks);
    rows.push({
      kind: "human", name: d.display_name, emoji: "🧑", color: "#64748b",
      tickers, score: scorePortfolio(tickers, prices),
    });
  }
  const priced = rows.filter((r) => r.score);
  const unpriced = rows.filter((r) => !r.score);
  priced.sort(compareRanked);
  return { rows: [...priced.map((r, i) => ({ ...r, rank: i + 1 })), ...unpriced.map((r) => ({ ...r, rank: null }))], priced: priced.length > 0 };
}

const fmtPct = (x) => (x >= 0 ? "+" : "") + x.toFixed(2) + "%";
const fmtUsd = (x) => "$" + x.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 });

// ---------------------------------------------------------------- auth (email + password, session cookies)
const SESSION_COOKIE = "ptw_session";
const SESSION_DAYS = 30;
function secureCookies() {
  return (process.env.APP_URL || "").startsWith("https://");
}
function parseCookies(req) {
  const m = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) {
      const k = part.slice(0, i).trim();
      let v = part.slice(i + 1).trim();
      try { v = decodeURIComponent(v); } catch { /* malformed encoding — keep raw */ }
      m[k] = v;
    }
  }
  return m;
}
// Post-login redirect target: must be a same-origin path. Rejects "//evil.com"
// style protocol-relative URLs, which start with "/" but escape the site.
function safeNext(v) {
  const n = String(v || "/");
  return n.startsWith("/") && !n.startsWith("//") ? n : "/";
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NAME_RE = /^[A-Za-z0-9 _-]{2,24}$/;

async function createSession(userId, res) {
  const token = crypto.randomBytes(32).toString("hex");
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  await run("INSERT INTO sessions (id,user_id,token_hash,expires_at) VALUES (?,?,?,?)",
    [nanoid(), userId, hash, expires]);
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true, sameSite: "lax", secure: secureCookies(),
    path: "/", maxAge: SESSION_DAYS * 864e5,
  });
}
async function destroySession(req, res) {
  const t = parseCookies(req)[SESSION_COOKIE];
  if (t) {
    const hash = crypto.createHash("sha256").update(t).digest("hex");
    await run("UPDATE sessions SET revoked_at=? WHERE token_hash=?", [nowIso(), hash]);
  }
  res.clearCookie(SESSION_COOKIE, { path: "/" });
}
async function attachUser(req, _res, next) {
  req.user = null;
  const t = parseCookies(req)[SESSION_COOKIE];
  if (t) {
    const hash = crypto.createHash("sha256").update(t).digest("hex");
    const s = await one(
      `SELECT u.id, u.email, u.display_name FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?`,
      [hash, nowIso()]);
    if (s) req.user = { id: s.id, email: s.email, display_name: s.display_name };
  }
  next();
}
function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).send(layout("Sign in required",
      `<div class="card"><div class="err">You need an account to draft. <a href="/login">Log in</a> or <a href="/signup">create a free account</a>.</div></div>`, null));
  }
  next();
}

// ---------------------------------------------------------------- templates
function layout(title, body, user) {
  const navUser = user
    ? `<span class="mut">👋 ${esc(user.display_name)}</span><a href="/draft">Draft</a><a href="#" onclick="fetch('/logout',{method:'POST'}).then(()=>location.href='/');return false;">Log out</a>`
    : `<a href="/login">Log in</a><a href="/signup">Sign up</a>`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${esc(SITE_TITLE)}</title>
<style>
:root{--bg:#0b1220;--card:#131c2e;--line:#223;--txt:#e8eef7;--mut:#93a1b8}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--txt);
font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;line-height:1.45}
.wrap{max-width:860px;margin:0 auto;padding:16px}
header.top{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:8px 0 16px}
.brand{font-size:22px;font-weight:800}.brand small{display:block;font-size:12px;color:var(--mut);font-weight:400}
nav a{color:var(--mut);text-decoration:none;margin-left:14px;font-size:14px}nav a:hover{color:#fff}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;margin:12px 0}
h2{margin:4px 0 12px;font-size:18px}.mut{color:var(--mut);font-size:13px}
table.board{width:100%;border-collapse:collapse;font-size:14px}
table.board th,table.board td{padding:10px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
table.board th{color:var(--mut);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
.up{color:#4ade80;font-weight:700}.down{color:#f87171;font-weight:700}
.chip{display:inline-block;background:#0e1626;border:1px solid var(--line);border-radius:8px;
padding:2px 8px;margin:2px 4px 2px 0;font-size:12px;white-space:nowrap}
.persona{display:flex;gap:12px;align-items:flex-start}
.avatar{font-size:30px;line-height:1}
.dot{width:10px;height:10px;border-radius:50%;display:inline-block;margin-right:6px}
.btn{display:inline-block;background:#2563eb;color:#fff;border:0;border-radius:10px;
padding:12px 20px;font-size:16px;font-weight:700;text-decoration:none;cursor:pointer}
.btn.sec{background:#1e293b}
input[type=text],input[type=email],input[type=password],input[type=number],select{width:100%;background:#0e1626;color:var(--txt);
border:1px solid var(--line);border-radius:10px;padding:12px;font-size:16px;margin:6px 0}
label{font-size:13px;color:var(--mut)}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.err{background:#3b1116;border:1px solid #7f1d1d;color:#fecaca;border-radius:10px;padding:12px;margin:12px 0}
.ok{background:#0f2f1c;border:1px solid #14532d;color:#bbf7d0;border-radius:10px;padding:12px;margin:12px 0}
.rules{font-size:13px;color:var(--mut)}.rules li{margin:4px 0}
footer{margin:28px 0 12px;color:var(--mut);font-size:12px;text-align:center}
.weeknav{font-size:13px;margin-bottom:8px}.weeknav a{color:#7db4ff;text-decoration:none;margin-right:10px}
</style></head><body><div class="wrap">
<header class="top"><div class="brand">🤖 ${esc(SITE_TITLE)}<small>5 AIs + 1 monkey · $10K simulated each · Season 1</small></div>
<nav><a href="/">Board</a>${navUser}</nav></header>
${body}
<footer>Simulated portfolios for entertainment only. Not financial advice. Not affiliated with OpenAI, xAI, Anthropic, Google, or Meta.</footer>
</div></body></html>`;
}

async function homePage(weekId, user, msg) {
  const week = await getWeek(weekId);
  const weeks = await listWeeks();
  const { rows, priced } = await leaderboard(weekId);
  const picks = await aiPicksFor(weekId);
  const personas = await listPersonas();
  const prices = await pricesFor(weekId);

  const weekNav = weeks.length > 1
    ? `<div class="weeknav">` + weeks.map((w) =>
        w.id === weekId ? `<strong>${esc(w.label)}</strong>` : `<a href="/?week=${w.id}">${esc(w.label)}</a>`).join(" ") + `</div>` : "";

  const boardRows = rows.map((r) => {
    const s = r.score;
    const scoreCell = s
      ? `<span class="${s.total >= 0 ? "up" : "down"}">${fmtPct(s.total)}</span><br><span class="mut">${fmtUsd(s.value)}</span>`
      : `<span class="mut">awaiting prices</span>`;
    const legChips = r.tickers.map((t) => {
      const leg = s && s.legs.find((l) => l.ticker === t);
      return `<span class="chip">${t}${leg ? ` <span class="${leg.ret >= 0 ? "up" : "down"}">${fmtPct(leg.ret)}</span>` : ""}</span>`;
    }).join("");
    return `<tr><td>${s ? "#" + r.rank : "–"}</td>
      <td><span class="dot" style="background:${r.color}"></span>${r.emoji} <strong>${esc(r.name)}</strong>
      ${r.kind === "human" ? `<span class="mut"> (human)</span>` : ""}<br>${legChips}</td>
      <td style="text-align:right;white-space:nowrap">${scoreCell}</td></tr>`;
  }).join("");

  const draftCards = personas.map((p) => {
    const kp = picks.filter((k) => k.persona_id === p.id);
    const lis = kp.map((k) => {
      const pr = prices[k.ticker];
      const ret = pr && pr.entry && pr.current
        ? ` <span class="${((pr.current - pr.entry) / pr.entry) >= 0 ? "up" : "down"}">${fmtPct(((pr.current - pr.entry) / pr.entry) * 100)}</span>` : "";
      return `<div style="margin:8px 0"><span class="chip"><strong>${k.ticker}</strong></span>${ret}<br><span class="mut">“${esc(k.note)}”</span></div>`;
    }).join("");
    return `<div class="card"><div class="persona"><div class="avatar">${p.emoji}</div>
      <div><h2 style="margin:0"><span class="dot" style="background:${p.color}"></span>${esc(p.name)}</h2>
      <div class="mut">${esc(p.tagline)}</div>${lis}</div></div></div>`;
  }).join("");

  return layout(`${week.label} standings`, `
    ${weekNav}
    ${msg ? `<div class="ok">${esc(msg)}</div>` : ""}
    <div class="card"><h2>🏆 ${esc(week.label)} — Leaderboard</h2>
      <div class="mut">Entry: ${esc(week.entry_label)} · Cutoff: ${esc(week.cutoff_label)} · Equal 20% weights · $10,000 simulated per portfolio</div>
      <div class="mut">Prices — entry: ${esc(snapshotLabel(await latestSnapshot(weekId, "entry")))} · current: ${esc(snapshotLabel(await latestSnapshot(weekId, "current")))}</div>
      ${priced ? `<table class="board"><tr><th>Rank</th><th>Trader</th><th style="text-align:right">Return</th></tr>${boardRows}</table>`
        : `<p class="mut">Current prices haven't refreshed yet — entries are locked, scoring starts with the first refresh.</p>
           <table class="board"><tr><th></th><th>Trader</th><th style="text-align:right">Return</th></tr>${boardRows}</table>`}
    </div>
    <div class="card"><h2>📋 The draft board</h2>
      <div class="mut">What each contestant drafted. Ed drafts for the AIs — their vibes, his guesses. No mid-week trades.</div></div>
    ${draftCards}
    <div class="card" style="text-align:center"><h2>Think you can beat the machines — and the monkey?</h2>
      <p class="mut">Draft your own 5-ticker portfolio from the same menu. Free account, 30 seconds. Simulated, no money involved.</p>
      <a class="btn" href="/draft">Draft my portfolio</a></div>
    <div class="card"><h2 class="mut">The rules</h2><ul class="rules">
      <li>Entry prices lock Tuesday ~4:35 PM ET; scoring cuts off the following Tuesday at 4:00 PM ET.</li>
      <li>Stocks use the 4 PM ET closing price; crypto uses the spot price at lock.</li>
      <li>No trading mid-week. No re-picks. One draft per account per week.</li>
      <li>Tie-breaks: fewest losing picks → best single pick → AI contestants rank ahead of humans, then alphabetical.</li>
      <li>All portfolios simulated and dramatized for entertainment. Not financial advice. Not affiliated with OpenAI, xAI, Anthropic, Google, or Meta.</li></ul></div>`, user);
}

function draftPage(user, err, prev) {
  const assets = [["MSFT", "Microsoft"], ["AAPL", "Apple"], ["NVDA", "Nvidia"], ["TSLA", "Tesla"], ["AMD", "AMD"],
    ["BTC", "Bitcoin"], ["ETH", "Ethereum"], ["SOL", "Solana"], ["XRP", "XRP"], ["DOGE", "Dogecoin"]];
  const opts = assets.map((a) => `<option value="${a[0]}">${a[0]} — ${esc(a[1])}</option>`).join("");
  const selects = [0, 1, 2, 3, 4].map((i) =>
    `<label>Pick ${i + 1}<select name="pick${i}">${prev && prev[i] ? `<option selected>${esc(prev[i])}</option>` : `<option value="">— choose —</option>`}${opts}</select></label>`).join("");
  return layout("Draft your portfolio", `
    <div class="card"><h2>🧑 Draft against the AIs</h2>
    <p class="mut">Drafting as <strong>${esc(user.display_name)}</strong>. Pick 5 different tickers from the menu — one draft per account per week, locked in.</p>
    ${err ? `<div class="err">${esc(err)}</div>` : ""}
    <form method="POST" action="/draft">
      ${selects}
      <button class="btn" type="submit" style="margin-top:12px">Lock in my draft</button>
    </form></div>`, user);
}

function loginPage(err, next) {
  return layout("Log in", `<div class="card"><h2>🔑 Log in</h2>
    ${next === "/draft" ? `<p class="mut">Log in to lock in your draft.</p>` : ""}
    ${err ? `<div class="err">${esc(err)}</div>` : ""}
    <form method="POST" action="/login">
      <input type="hidden" name="next" value="${esc(next || "/")}">
      <label>Email<input type="email" name="email" required placeholder="you@example.com"></label>
      <label>Password<input type="password" name="password" required></label>
      <button class="btn" type="submit" style="margin-top:12px">Log in</button>
    </form>
    <p class="mut">No account? <a href="/signup${next ? `?next=${encodeURIComponent(next)}` : ""}">Create a free one</a>.</p></div>`, null);
}

function signupPage(err, next) {
  return layout("Create account", `<div class="card"><h2>📝 Create your free account</h2>
    <p class="mut">One account per email. Your display name is permanent and shows on the leaderboard — pick a good one.</p>
    ${err ? `<div class="err">${esc(err)}</div>` : ""}
    <form method="POST" action="/signup">
      <input type="hidden" name="next" value="${esc(next || "/")}">
      <label>Email<input type="email" name="email" required maxlength="120" placeholder="you@example.com"></label>
      <label>Display name (2–24 chars: letters, numbers, spaces, _ -)<input type="text" name="display_name" required maxlength="24" placeholder="e.g. Ed"></label>
      <label>Password (8+ characters)<input type="password" name="password" required minlength="8"></label>
      <button class="btn" type="submit" style="margin-top:12px">Create account</button>
    </form>
    <p class="mut">Already have one? <a href="/login${next ? `?next=${encodeURIComponent(next)}` : ""}">Log in</a>.</p></div>`, null);
}

function adminLoginPage(err) {
  return layout("Admin", `<div class="card"><h2>🔐 Admin</h2>
    ${err ? `<div class="err">${esc(err)}</div>` : ""}
    <form method="POST" action="/admin/login"><label>Admin secret<input type="text" name="secret" required></label>
    <button class="btn" type="submit" style="margin-top:12px">Unlock</button></form></div>`, null);
}

async function adminPanel(weekId, msg, err) {
  const week = await getWeek(weekId);
  const assets = await listAssets();
  const prices = await pricesFor(weekId);
  const personas = await listPersonas();
  const picks = await aiPicksFor(weekId);
  const entrySnap = await latestSnapshot(weekId, "entry");
  const currentSnap = await latestSnapshot(weekId, "current");
  const priceRows = assets.map((a) => {
    const pr = prices[a.ticker] || {};
    return `<tr><td><strong>${a.ticker}</strong><br><span class="mut">${esc(a.name)}</span></td>
      <td><input type="number" step="any" min="0" name="entry_${a.ticker}" value="${pr.entry ?? ""}" placeholder="entry"></td>
      <td><input type="number" step="any" min="0" name="current_${a.ticker}" value="${pr.current ?? ""}" placeholder="current"></td></tr>`;
  }).join("");
  const pickEditors = personas.map((p) => {
    const kp = picks.filter((k) => k.persona_id === p.id).map((k) => k.ticker).join(", ");
    return `<label>${p.emoji} ${esc(p.name)} — 5 tickers, comma-separated
      <input type="text" name="picks_${p.id}" value="${esc(kp)}"></label>`;
  }).join("");
  return layout("Admin panel", `
    ${msg ? `<div class="ok">${esc(msg)}</div>` : ""}${err ? `<div class="err">${esc(err)}</div>` : ""}
    <div class="card"><h2>⚡ Live price fetch — ${esc(week.label)}</h2>
      <p class="mut">Entry snapshot is taken Tuesday ~4:35 PM ET (one click). "Current" can be refreshed any time.
      Tickers that fail keep their previous values — nothing is ever zeroed out.</p>
      <p class="mut">Entry: <strong>${esc(snapshotLabel(entrySnap))}</strong><br>
      Current: <strong>${esc(snapshotLabel(currentSnap))}</strong></p>
      <form method="POST" action="/admin/fetch-entry" style="display:inline-block;margin:4px 8px 4px 0">
        <button class="btn" type="submit">📸 Fetch &amp; set ENTRY prices</button></form>
      <form method="POST" action="/admin/fetch-current" style="display:inline-block;margin:4px 0">
        <button class="btn sec" type="submit">🔄 Fetch &amp; update CURRENT prices</button></form>
    </div>
    <div class="card"><h2>💰 Prices — ${esc(week.label)} (manual fallback)</h2>
      <p class="mut">Entry prices lock Tuesday ~4:35 PM ET. Update "current" any time; leaderboard recomputes live.</p>
      <form method="POST" action="/admin/prices">
      <table class="board"><tr><th>Asset</th><th>Entry $</th><th>Current $</th></tr>${priceRows}</table>
      <button class="btn" type="submit" style="margin-top:12px">Save prices</button></form></div>
    <div class="card"><h2>🤖 AI picks — ${esc(week.label)}</h2>
      <form method="POST" action="/admin/ai-picks">${pickEditors}
      <button class="btn" type="submit" style="margin-top:12px">Save AI picks</button></form></div>
    <div class="card"><h2>📅 New week</h2>
      <p class="mut">Opens a new week on the Tuesday–Tuesday cycle: human drafts reset (they're per-week), AI picks carry over for editing, prices start empty.</p>
      <form method="POST" action="/admin/new-week"><label>Label<input type="text" name="label" value="Week ${week.id + 1}"></label>
      <button class="btn sec" type="submit" style="margin-top:12px">Open new week</button></form></div>`, null);
}

// Screenshot-ready scoreboard graphic for video production.
// Same public data as /, styled as a narrow vertical column for phone screenshots.
async function boardImagePage(weekId) {
  const week = await getWeek(weekId);
  const { rows, priced } = await leaderboard(weekId);
  const rowsHtml = rows.map((r) => {
    const s = r.score;
    const medal = r.rank === 1 ? "🥇" : r.rank === 2 ? "🥈" : r.rank === 3 ? "🥉" : "";
    const pct = s
      ? `<div class="pct ${s.total >= 0 ? "up" : "down"}">${fmtPct(s.total)}</div>`
      : `<div class="pct flat">–</div>`;
    const chips = r.tickers.map((t) => `<span class="tk">${t}</span>`).join("");
    return `<div class="brow${r.rank === 1 && s ? " lead" : ""}">
      <div class="brank">${s ? `<span class="medal">${medal}</span>#${r.rank}` : "–"}</div>
      <div class="bwho"><div class="bname">${r.emoji} ${esc(r.name)}${r.kind === "human" ? ' <span class="htag">HUMAN</span>' : ""}</div>
      <div class="bpicks">${chips}</div></div>${pct}</div>`;
  }).join("");
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(week.label)} scoreboard · ${esc(SITE_TITLE)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0b1220;color:#e8eef7;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.shot{max-width:420px;margin:0 auto;padding:24px 16px 20px}
.kicker{font-size:13px;letter-spacing:.18em;color:#93a1b8;text-transform:uppercase;text-align:center}
h1{font-size:32px;font-weight:800;text-align:center;margin:6px 0 2px}
.week{font-size:20px;font-weight:700;text-align:center;color:#7db4ff;margin-bottom:4px}
.dates{font-size:12px;color:#93a1b8;text-align:center;margin-bottom:14px}
.await{background:#3b2f0b;border:1px solid #a16207;color:#fde68a;border-radius:12px;
padding:10px 14px;font-size:14px;text-align:center;margin-bottom:14px}
.brow{display:flex;align-items:center;gap:10px;background:#131c2e;border:1px solid #223;
border-radius:14px;padding:12px;margin:8px 0}
.brow.lead{border-color:#a16207;background:#1a1610}
.brank{font-size:15px;font-weight:800;color:#93a1b8;min-width:52px;text-align:center}
.medal{font-size:18px}
.bwho{flex:1;min-width:0}
.bname{font-size:17px;font-weight:700}
.htag{font-size:10px;background:#2563eb;border-radius:6px;padding:2px 6px;vertical-align:2px;letter-spacing:.06em}
.bpicks{margin-top:6px}
.tk{display:inline-block;background:#0e1626;border:1px solid #223;border-radius:7px;
padding:1px 7px;margin:1px 3px 1px 0;font-size:11px;color:#93a1b8}
.pct{font-size:24px;font-weight:800;white-space:nowrap}
.up{color:#4ade80}.down{color:#f87171}.flat{color:#93a1b8}
.foot{margin-top:16px;font-size:12px;color:#93a1b8;text-align:center}
</style></head><body><div class="shot">
<div class="kicker">🤖 AI trader showdown</div>
<h1>${esc(SITE_TITLE)}</h1>
<div class="week">${esc(week.label)} standings</div>
<div class="dates">Entry ${esc(week.entry_label)} · Cutoff ${esc(week.cutoff_label)}</div>
<div class="dates">Prices — entry: ${esc(snapshotLabel(await latestSnapshot(weekId, "entry")))} · current: ${esc(snapshotLabel(await latestSnapshot(weekId, "current")))}</div>
${priced ? "" : `<div class="await">⏳ Entries locked — awaiting the first current-price refresh.</div>`}
${rowsHtml}
<div class="foot">Simulated · Dramatized · Not financial advice</div>
</div></body></html>`;
}

// ---------------------------------------------------------------- admin auth (shared secret -> HMAC cookie)
function adminToken() {
  return crypto.createHmac("sha256", ADMIN_SECRET).update("papertradewars-arena-admin").digest("hex");
}
function isAdmin(req) {
  const c = parseCookies(req).ia_admin;
  return !!c && c.length === 64 && crypto.timingSafeEqual(Buffer.from(c), Buffer.from(adminToken()));
}
function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return res.status(403).send(layout("Forbidden", `<div class="card"><div class="err">Admin only. <a href="/admin">Log in</a>.</div></div>`, req.user));
  next();
}

// ---------------------------------------------------------------- app
const app = express();
app.use(express.urlencoded({ extended: false, limit: "64kb" }));
app.use(express.json({ limit: "64kb" }));
app.use(ah(attachUser));

app.get("/", ah(async (req, res) => {
  const w = Number(req.query.week) || await currentWeekId();
  if (!await getWeek(w)) return res.status(404).send(layout("Not found", `<div class="card"><div class="err">Unknown week.</div></div>`, req.user));
  res.send(await homePage(w, req.user, req.query.drafted ? "Draft locked in — you're on the board. Good luck beating the monkey. 🐵" : ""));
}));

app.get("/api/health", ah(async (req, res) => {
  res.json({ ok: true, site: SITE_TITLE, db: dbMode(), week: await currentWeekId() });
}));

// Screenshot-ready scoreboard for video production (no auth — same public data as /).
app.get("/board-image", ah(async (req, res) => {
  const w = Number(req.query.week) || await currentWeekId();
  if (!await getWeek(w)) return res.status(404).send("Unknown week.");
  res.send(await boardImagePage(w));
}));

// ---------------------------------------------------------------- accounts
app.get("/signup", (req, res) => {
  if (req.user) return res.redirect(safeNext(req.query.next));
  res.send(signupPage("", req.query.next || ""));
});
app.post("/signup", ah(async (req, res) => {
  const next = safeNext(req.body.next);
  const email = String(req.body.email || "").trim().toLowerCase().slice(0, 120);
  const displayName = String(req.body.display_name || "").trim();
  const password = String(req.body.password || "");
  if (!EMAIL_RE.test(email)) return res.status(400).send(signupPage("Enter a valid email address.", next));
  if (!NAME_RE.test(displayName)) return res.status(400).send(signupPage("Display name must be 2–24 characters: letters, numbers, spaces, _ or -.", next));
  if (password.length < 8) return res.status(400).send(signupPage("Password must be at least 8 characters.", next));
  const clash = await one("SELECT id FROM users WHERE email = ? OR lower(display_name) = lower(?)", [email, displayName]);
  if (clash) return res.status(409).send(signupPage("That email or display name is already taken.", next));
  const id = nanoid();
  await run("INSERT INTO users (id,email,display_name,password_hash) VALUES (?,?,?,?)",
    [id, email, displayName, await bcrypt.hash(password, 12)]);
  await createSession(id, res);
  res.redirect(next);
}));

app.get("/login", (req, res) => {
  if (req.user) return res.redirect(safeNext(req.query.next));
  res.send(loginPage("", req.query.next || ""));
});
app.post("/login", ah(async (req, res) => {
  const next = safeNext(req.body.next);
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const user = await one("SELECT * FROM users WHERE email = ?", [email]);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).send(loginPage("Wrong email or password.", next));
  }
  await destroySession(req, res); // rotate: kill any stale session cookie first
  await createSession(user.id, res);
  res.redirect(next);
}));
app.post("/logout", ah(async (req, res) => {
  await destroySession(req, res);
  res.redirect("/");
}));
app.get("/api/me", ah(async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "unauthorized" });
  res.json({ user: req.user });
}));

// ---------------------------------------------------------------- human drafts (account-bound, one per week)
app.get("/draft", ah(async (req, res) => {
  if (!req.user) return res.redirect("/login?next=/draft");
  const weekId = await currentWeekId();
  const existing = await one("SELECT 1 FROM drafts WHERE week_id=? AND user_id=?", [weekId, req.user.id]);
  if (existing) return res.redirect("/?drafted=1");
  res.send(draftPage(req.user, "", null));
}));
app.post("/draft", requireAuth, ah(async (req, res) => {
  const weekId = await currentWeekId();
  const picks = [0, 1, 2, 3, 4].map((i) => String(req.body["pick" + i] || "").toUpperCase().trim());
  const perr = validatePicks(picks);
  if (perr) return res.status(400).send(draftPage(req.user, perr, { 0: picks[0], 1: picks[1], 2: picks[2], 3: picks[3], 4: picks[4] }));
  try {
    await run("INSERT INTO drafts (week_id,user_id,picks) VALUES (?,?,?)",
      [weekId, req.user.id, JSON.stringify(picks)]);
  } catch (e) {
    if (String(e.message).includes("UNIQUE") || String(e.message).includes("PRIMARY")) {
      return res.status(409).send(draftPage(req.user, "You already have a draft this week — one per account.", null));
    }
    throw e;
  }
  res.redirect("/?drafted=1");
}));

// ---------------------------------------------------------------- admin
app.get("/admin", ah(async (req, res) => res.send(isAdmin(req) ? await adminPanel(await currentWeekId()) : adminLoginPage(""))));
app.post("/admin/login", (req, res) => {
  if (String(req.body.secret || "") !== ADMIN_SECRET) return res.status(401).send(adminLoginPage("Wrong secret."));
  res.cookie("ia_admin", adminToken(), { httpOnly: true, sameSite: "lax", secure: secureCookies(), path: "/", maxAge: 864e5 });
  res.redirect("/admin");
});
app.post("/admin/prices", requireAdmin, ah(async (req, res) => {
  const weekId = await currentWeekId();
  const entryVals = {}, currentVals = {};
  const updates = [];
  for (const a of await listAssets()) {
    const e = req.body["entry_" + a.ticker], c = req.body["current_" + a.ticker];
    const entry = e === "" || e == null ? null : Number(e);
    const current = c === "" || c == null ? null : Number(c);
    if ((entry != null && !(entry > 0)) || (current != null && !(current > 0))) {
      return res.status(400).send(await adminPanel(weekId, "", `Prices for ${a.ticker} must be positive numbers.`));
    }
    if (entry != null || current != null) updates.push([a.ticker, entry, current]);
    if (entry != null) entryVals[a.ticker] = entry;
    if (current != null) currentVals[a.ticker] = current;
  }
  // Only touch the columns the admin actually filled in — a current-only
  // refresh must never wipe the locked entry prices (or vice versa).
  await txn(async (db) => {
    for (const [t, entry, current] of updates) {
      if (entry != null && current != null) {
        await db.run(`INSERT INTO prices (week_id,ticker,entry,current) VALUES (?,?,?,?)
          ON CONFLICT(week_id,ticker) DO UPDATE SET entry=excluded.entry, current=excluded.current`,
          [weekId, t, entry, current]);
      } else if (entry != null) {
        await db.run(`INSERT INTO prices (week_id,ticker,entry) VALUES (?,?,?)
          ON CONFLICT(week_id,ticker) DO UPDATE SET entry=excluded.entry`,
          [weekId, t, entry]);
      } else {
        await db.run(`INSERT INTO prices (week_id,ticker,current) VALUES (?,?,?)
          ON CONFLICT(week_id,ticker) DO UPDATE SET current=excluded.current`,
          [weekId, t, current]);
      }
    }
  });
  // Manual saves join the same audit trail so the board always shows the truth.
  if (Object.keys(entryVals).length) await logSnapshot(weekId, "entry", "manual", entryVals, [], true);
  if (Object.keys(currentVals).length) await logSnapshot(weekId, "current", "manual", currentVals, [], true);
  res.send(await adminPanel(weekId, `Saved prices for ${updates.length} assets. Leaderboard recomputed.`));
}));

// Shared fetch handler for the admin's one-click ENTRY / CURRENT buttons.
async function handleFetch(req, res, kind) {
  const weekId = await currentWeekId();
  const { prices, failures } = await fetchLivePrices();
  const n = await applyFetchedPrices(weekId, kind, prices);
  const total = Object.keys(prices).length + failures.length;
  const label = kind === "entry" ? "ENTRY" : "CURRENT";
  if (n > 0) {
    await logSnapshot(weekId, kind, "fetch", prices, failures, true);
    const okMsg = `⚡ Fetched ${label} prices for ${n}/${total} tickers — leaderboard recomputed.`;
    const errMsg = failures.length
      ? `Kept previous values for: ${[...new Set(failures.map((f) => f.ticker))].join(", ")} (${failures[0].source}: ${failures[0].error}).`
      : "";
    return res.send(await adminPanel(weekId, okMsg, errMsg));
  }
  await logSnapshot(weekId, kind, "fetch", {}, failures, false);
  const bySrc = {};
  for (const f of failures) bySrc[f.source] = f.error;
  return res.status(502).send(await adminPanel(weekId, "",
    `Price fetch failed for all ${total} tickers — nothing changed. ` +
    Object.entries(bySrc).map(([s, e]) => `${s}: ${e}`).join(" · ")));
}
app.post("/admin/fetch-entry", requireAdmin, ah((req, res) => handleFetch(req, res, "entry")));
app.post("/admin/fetch-current", requireAdmin, ah((req, res) => handleFetch(req, res, "current")));
app.post("/admin/ai-picks", requireAdmin, ah(async (req, res) => {
  const weekId = await currentWeekId();
  const personas = await listPersonas();
  const parsed = [];
  for (const p of personas) {
    const raw = String(req.body["picks_" + p.id] || "").split(",").map((t) => t.toUpperCase().trim()).filter(Boolean);
    const perr = validatePicks(raw);
    if (perr) return res.status(400).send(await adminPanel(weekId, "", `${p.name}: ${perr}`));
    parsed.push([p.id, raw]);
  }
  await txn(async (db) => {
    await db.run("DELETE FROM ai_picks WHERE week_id = ?", [weekId]);
    for (const [pid, raw] of parsed) {
      for (let i = 0; i < raw.length; i++) {
        await db.run("INSERT INTO ai_picks (week_id,persona_id,slot,ticker,note) VALUES (?,?,?,?,?)",
          [weekId, pid, i + 1, raw[i], ""]);
      }
    }
  });
  res.send(await adminPanel(weekId, "AI picks updated."));
}));
app.post("/admin/new-week", requireAdmin, ah(async (req, res) => {
  const label = String(req.body.label || "").trim().slice(0, 40) || `Week ${await currentWeekId() + 1}`;
  const prev = await currentWeekId();
  const id = await txn(async (db) => {
    const r = await db.run("INSERT INTO weeks (label) VALUES (?)", [label]);
    const newId = Number(r.lastInsertRowid);
    const rows = await db.all("SELECT persona_id,slot,ticker,note FROM ai_picks WHERE week_id = ?", [prev]);
    for (const r2 of rows) {
      await db.run("INSERT INTO ai_picks (week_id,persona_id,slot,ticker,note) VALUES (?,?,?,?,?)",
        [newId, Number(r2.persona_id), Number(r2.slot), r2.ticker, r2.note]);
    }
    return newId;
  });
  res.send(await adminPanel(id, `${label} is open. Human drafts reset; AI picks carried over — edit them above if needed.`));
}));

// JSON board (for QA + future video tooling)
app.get("/api/board", ah(async (req, res) => {
  const w = Number(req.query.week) || await currentWeekId();
  const week = await getWeek(w);
  if (!week) return res.status(404).json({ error: "unknown week" });
  const { rows, priced } = await leaderboard(w);
  res.json({
    week: { id: week.id, label: week.label, entry_label: week.entry_label, cutoff_label: week.cutoff_label },
    priced,
    snapshots: {
      entry: snapshotSummary(await latestSnapshot(w, "entry")),
      current: snapshotSummary(await latestSnapshot(w, "current")),
    },
    standings: rows.map((r) => ({
      rank: r.rank, kind: r.kind, name: r.name, emoji: r.emoji,
      picks: r.tickers,
      legs: r.score ? r.score.legs.map((l) => ({ ticker: l.ticker, ret_pct: +l.ret.toFixed(4) })) : null,
      total_ret_pct: r.score ? +r.score.total.toFixed(4) : null,
      losers: r.score ? r.score.losers : null,
      best_pick_ret_pct: r.score ? +r.score.best.toFixed(4) : null,
      portfolio_value: r.score ? +r.score.value.toFixed(2) : null,
    })),
  });
}));

// Errors render as a page, never a stack trace.
app.use((err, _req, res, _next) => {
  console.error("[error]", err);
  res.status(500).send(layout("Something broke",
    `<div class="card"><div class="err">Something went wrong on our end. Try again in a bit.</div></div>`, null));
});

app.listen(PORT, () => console.log(`PaperTradeWars arena on :${PORT} (db: ${dbMode()})`));
