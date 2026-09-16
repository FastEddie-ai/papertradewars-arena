// QA pass for PaperTradeWars arena v2. Boots the real server on temp DBs, drives it
// over HTTP, and independently recomputes every number. Run: npm run qa
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

// Pick a genuinely free port so a stale server from a crashed run can never
// shadow the server under test.
async function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

let pass = 0, fail = 0;
const ok = (cond, label, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label} ${extra}`); }
};

function bootServer(extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ptw-qa-"));
  const dbFile = path.join(dir, "qa.db");
  return { dir, dbFile, extraEnv };
}

async function startServer(env) {
  const PORT = await freePort();
  const server = spawn("node", ["server.mjs"], {
    cwd: path.resolve("."),
    env: { ...process.env, PORT, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((r) => {
    const t = setTimeout(() => r(), 8000);
    server.stdout.on("data", (d) => { if (String(d).includes("PaperTradeWars")) { clearTimeout(t); r(); } });
    server.stderr.on("data", (d) => { process.env.QA_DEBUG && console.log("[srv]", String(d).slice(0, 200)); });
  });
  return { server, PORT };
}

function makeClient(PORT) {
  const jar = {};
  async function req(method, p, body, opts = {}) {
    const headers = {};
    const cookies = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
    if (cookies) headers.cookie = cookies;
    let payload;
    if (body) { payload = new URLSearchParams(body).toString(); headers["content-type"] = "application/x-www-form-urlencoded"; }
    const r = await fetch(`http://127.0.0.1:${PORT}${p}`, {
      method, headers, body: payload, redirect: "manual",
    });
    for (const sc of r.headers.getSetCookie()) {
      const [kv] = sc.split(";");
      const i = kv.indexOf("=");
      if (i > 0) {
        const k = kv.slice(0, i).trim(), v = kv.slice(i + 1).trim();
        if (/expires=thu, 01 jan 1970/i.test(sc)) delete jar[k]; else jar[k] = v;
      }
    }
    return { status: r.status, text: await r.text(), loc: r.headers.get("location") };
  }
  const get = (p) => req("GET", p);
  const board = async (week) => (await (await fetch(`http://127.0.0.1:${PORT}/api/board${week ? `?week=${week}` : ""}`)).json());
  return { req, get, board, jar };
}

// Real Week 1 entry prices (locked Tue Sep 15, 2026 ~4:35 PM ET)
const ENTRY = {
  MSFT: 497.12, AAPL: 331.34, NVDA: 212.17, TSLA: 356.58, AMD: 504.20,
  BTC: 75643.87, ETH: 2399.60, DOGE: 0.07996, XRP: 1.2708, SOL: 96.71,
};
const EXPECTED_PICKS = {
  ChatGPT: ["MSFT", "AAPL", "NVDA", "BTC", "ETH"],
  Grok: ["DOGE", "SOL", "XRP", "TSLA", "NVDA"],
  Claude: ["MSFT", "AAPL", "ETH", "BTC", "AMD"],
  Gemini: ["NVDA", "MSFT", "SOL", "BTC", "TSLA"],
  Muse: ["BTC", "ETH", "SOL", "NVDA", "MSFT"],
  Bananas: ["SOL", "AAPL", "TSLA", "MSFT", "NVDA"],
};
const SECRET = "qa-secret-123";

// ---------------------------------------------------------------- main server (Turso-config path via file: URL)
const main = bootServer();
const { server, PORT } = await startServer({
  ADMIN_SECRET: SECRET,
  TURSO_DATABASE_URL: `file:${main.dbFile}`,
});
const { req, get, board, jar } = makeClient(PORT);

console.log("— boot + config paths");
{
  const h = await (await fetch(`http://127.0.0.1:${PORT}/api/health`)).json();
  // TURSO_DATABASE_URL=file:... is the local-dev config path and intentionally
  // maps to the local-sqlite driver (no network). The assertion that matters:
  // the URL from the env var is honored and the DB boots + seeds.
  ok(h.ok === true && h.site === "PaperTradeWars" && h.db === "local-sqlite",
    `health ok via TURSO_DATABASE_URL file path (db=${h.db})`);
}
// DB_PATH fallback: a second server must boot and seed identically.
{
  const alt = bootServer();
  const s2 = await startServer({ ADMIN_SECRET: SECRET, DB_PATH: alt.dbFile });
  const c2 = makeClient(s2.PORT);
  const b = await c2.board();
  ok(b.week.label === "Week 1" && b.standings.length === 6, "DB_PATH fallback boots + seeds Week 1");
  s2.server.kill();
}

console.log("— Season 1 seed data (real, not invented)");
{
  const b = await board();
  if (b.week.label !== "Week 1" || b.standings.length !== 6) {
    console.log("❌ stale server detected on test port — aborting");
    server.kill(); process.exit(2);
  }
  const names = b.standings.map((s) => s.name);
  for (const n of Object.keys(EXPECTED_PICKS)) ok(names.includes(n), `contestant on board: ${n}`);
  ok(!names.some((n) => /Professor|Degen|Contrarian|FOMO|Quant Queen|Dartboard/.test(n)), "no invented v1 personas remain");
  let picksOk = true;
  for (const s of b.standings) {
    const exp = EXPECTED_PICKS[s.name];
    if (JSON.stringify(s.picks) !== JSON.stringify(exp)) { picksOk = false; console.log(`    picks mismatch ${s.name}: ${s.picks}`); }
  }
  ok(picksOk, "all 30 picks match the locked Week 1 draft");
  ok(b.priced === false, "not scored before current-price refresh");
  ok(b.snapshots.entry && b.snapshots.entry.source === "week1-lock" && b.snapshots.entry.tickers === 10,
    "entry snapshot = week1-lock, 10 tickers");
  ok(b.snapshots.current === null, "no current snapshot yet");
  ok(b.week.entry_label.includes("Sep 15") && b.week.cutoff_label.includes("Sep 22"),
    `Tuesday–Tuesday labels (${b.week.entry_label} / ${b.week.cutoff_label})`);
  const r = await get("/");
  ok(r.status === 200 && r.text.includes("PaperTradeWars"), "home shows PaperTradeWars brand");
  ok(r.text.includes("5 AIs + 1 monkey"), "rebranded header subtitle");
  ok(!r.text.includes("Investor Arena"), "no Investor Arena copy left on home");
}

console.log("— accounts (email + password)");
{
  const badEmail = await req("POST", "/signup", { email: "not-an-email", display_name: "Ed", password: "password123" });
  ok(badEmail.status === 400, "bad email -> 400");
  const badName = await req("POST", "/signup", { email: "ed@example.com", display_name: "<script>", password: "password123" });
  ok(badName.status === 400, "xss display name -> 400");
  const shortPw = await req("POST", "/signup", { email: "ed@example.com", display_name: "Ed", password: "short" });
  ok(shortPw.status === 400, "short password -> 400");
  const s1 = await req("POST", "/signup", { email: "ed@example.com", display_name: "Ed", password: "password123" });
  ok(s1.status === 302 && jar.ptw_session, "signup -> 302 + session cookie");
  const me = await (await fetch(`http://127.0.0.1:${PORT}/api/me`, { headers: { cookie: `ptw_session=${jar.ptw_session}` } })).json();
  ok(me.user && me.user.display_name === "Ed", "session resolves to Ed");
  const dupEmail = await req("POST", "/signup", { email: "ED@example.com", display_name: "Eddie", password: "password123" });
  ok(dupEmail.status === 409, "duplicate email (case-insensitive) -> 409");
  const dupName = await req("POST", "/signup", { email: "other@example.com", display_name: "ed", password: "password123" });
  ok(dupName.status === 409, "duplicate display name (case-insensitive) -> 409");
  // fresh client, no cookie
  const c2 = makeClient(PORT);
  const badLogin = await c2.req("POST", "/login", { email: "ed@example.com", password: "wrongpassword" });
  ok(badLogin.status === 401, "wrong password -> 401");
  const goodLogin = await c2.req("POST", "/login", { email: "ed@example.com", password: "password123" });
  ok(goodLogin.status === 302 && c2.jar.ptw_session, "login -> 302 + session cookie");
  const lo = await c2.req("POST", "/logout", null);
  ok(lo.status === 302 && !c2.jar.ptw_session, "logout clears session cookie");
  const meAfter = await c2.req("GET", "/api/me");
  ok(meAfter.status === 401, "me after logout -> 401");
}

console.log("— human drafting (account-bound)");
{
  // no session -> 401
  const c3 = makeClient(PORT);
  const anon = await c3.req("POST", "/draft", { pick0: "NVDA", pick1: "BTC", pick2: "ETH", pick3: "AAPL", pick4: "DOGE" });
  ok(anon.status === 401, "draft without login -> 401");
  const loginPage = await c3.req("GET", "/draft");
  ok(loginPage.status === 302 && (loginPage.loc || "").startsWith("/login"), "GET /draft logged out -> /login");
  // Ed (jar from signup section) drafts
  const d1 = await req("POST", "/draft", { pick0: "NVDA", pick1: "BTC", pick2: "ETH", pick3: "AAPL", pick4: "DOGE" });
  ok(d1.status === 302 && d1.loc === "/?drafted=1", "valid draft -> redirect");
  const d2 = await req("POST", "/draft", { pick0: "SOL", pick1: "XRP", pick2: "MSFT", pick3: "TSLA", pick4: "AMD" });
  ok(d2.status === 409, "second draft same week -> 409 (one per account)");
  // second user drafts fine
  const c4 = makeClient(PORT);
  await c4.req("POST", "/signup", { email: "cuz@example.com", display_name: "Cuz", password: "password123" });
  const badPicks = await c4.req("POST", "/draft", { pick0: "NVDA", pick1: "NVDA", pick2: "ETH", pick3: "AAPL", pick4: "DOGE" });
  ok(badPicks.status === 400, "duplicate tickers -> 400");
  const offMenu = await c4.req("POST", "/draft", { pick0: "NVDA", pick1: "FAKE", pick2: "ETH", pick3: "AAPL", pick4: "DOGE" });
  ok(offMenu.status === 400, "off-menu ticker -> 400");
  const d3 = await c4.req("POST", "/draft", { pick0: "SOL", pick1: "XRP", pick2: "MSFT", pick3: "TSLA", pick4: "AMD" });
  ok(d3.status === 302, "second human drafts fine");
  const b = await board();
  const humans = b.standings.filter((s) => s.kind === "human");
  ok(humans.length === 2 && humans.some((h) => h.name === "Ed") && humans.some((h) => h.name === "Cuz"),
    "both humans on board by display name");
}

console.log("— admin auth (unchanged)");
{
  const c5 = makeClient(PORT);
  const bad = await c5.req("POST", "/admin/login", { secret: "wrong" });
  ok(bad.status === 401, "wrong secret -> 401");
  const noAuth = await c5.req("POST", "/admin/prices", { entry_NVDA: "1" });
  ok(noAuth.status === 403, "price POST without auth -> 403");
  const good = await c5.req("POST", "/admin/login", { secret: SECRET });
  ok(good.status === 302 && c5.jar.ia_admin, "right secret -> admin cookie");
  var adminReq = c5.req; // reuse authed client below
}

console.log("— price entry validation + admin entry snapshot with REAL Week 1 prices");
{
  const neg = await adminReq("POST", "/admin/prices", { entry_NVDA: "-5", current_NVDA: "10" });
  ok(neg.status === 400, "negative price rejected");
  // Re-save the real locked entries via the admin path (idempotent — same values).
  const body = {};
  for (const [t, e] of Object.entries(ENTRY)) body["entry_" + t] = String(e);
  const r = await adminReq("POST", "/admin/prices", body);
  ok(r.status === 200, "admin entry snapshot with real Week 1 prices accepted");
}

console.log("— scoring unit tests (pure functions, exact ties)");
{
  const { scorePortfolio, compareRanked } = await import("./scoring.mjs");
  const mk = (kind, name, total, losers, best) => ({ kind, name, score: { total, losers, best } });
  ok(compareRanked(mk("ai", "Zed", 5, 0, 10), mk("ai", "Amy", 5, 2, 50)) < 0,
    "exact total tie -> fewer losers wins (Zed before Amy)");
  ok(compareRanked(mk("ai", "Zed", 5, 1, 30), mk("ai", "Amy", 5, 1, 10)) < 0,
    "total+losers tie -> best single pick wins");
  ok(compareRanked(mk("ai", "Zed", 5, 1, 10), mk("human", "Amy", 5, 1, 10)) < 0,
    "full numeric tie -> AI ranks before human");
  ok(compareRanked(mk("ai", "Amy", 5, 1, 10), mk("ai", "Zed", 5, 1, 10)) < 0,
    "full tie -> alphabetical (Amy before Zed)");
  ok(compareRanked(mk("ai", "Zed", 6, 5, 0), mk("ai", "Amy", 5, 0, 99)) < 0,
    "higher total wins despite more losers");
  ok(compareRanked(mk("ai", "A", 5, 1, 10), mk("ai", "A", 5, 1, 10)) === 0,
    "identical rows compare equal");
  ok(scorePortfolio(["A", "B"], { A: { entry: 100, current: 120 } }) === null,
    "missing price -> unpriced (null)");
  ok(scorePortfolio(["A"], { A: { entry: 0, current: 5 } }) === null,
    "zero entry -> unpriced (null, no div-by-zero)");
  const s = scorePortfolio(["A", "B"], { A: { entry: 100, current: 110 }, B: { entry: 200, current: 100 } });
  ok(Math.abs(s.total - -20) < 1e-9 && s.losers === 1 && Math.abs(s.best - 10) < 1e-9 && Math.abs(s.value - 8000) < 1e-6,
    `scorePortfolio math: total=${s.total.toFixed(4)} losers=${s.losers} best=${s.best.toFixed(4)} value=${s.value.toFixed(2)}`);
}

console.log("— scoring math vs independent recompute (real entries, crafted currents)");
const FRIDAY = {
  NVDA: 212.17 * 1.04, TSLA: 356.58 * 0.97, AAPL: 331.34 * 1.01, MSFT: 497.12 * 1.02, AMD: 504.20 * 0.99,
  BTC: 75643.87 * 1.05, ETH: 2399.60 * 0.96, SOL: 96.71 * 1.08, XRP: 1.2708 * 1.02, DOGE: 0.07996 * 0.95,
};
{
  const body = {};
  for (const [t, c] of Object.entries(FRIDAY)) body["current_" + t] = String(c);
  const r = await adminReq("POST", "/admin/prices", body);
  ok(r.status === 200, "current-price refresh accepted");
  const b = await board();
  ok(b.priced === true, "priced after current refresh");
  ok(b.snapshots.current && b.snapshots.current.method === "manual", "current snapshot logged");
  const ret = (t) => ((FRIDAY[t] - ENTRY[t]) / ENTRY[t]) * 100;
  let mathOk = true;
  for (const s of b.standings) {
    const exp = s.picks.reduce((sum, t) => sum + ret(t), 0) / 5;
    if (Math.abs(s.total_ret_pct - exp) > 1e-3) { mathOk = false; console.log(`    mismatch ${s.name}: got ${s.total_ret_pct} want ${exp}`); }
    const expVal = 10000 * (1 + exp / 100);
    if (Math.abs(s.portfolio_value - expVal) > 0.01) { mathOk = false; console.log(`    value mismatch ${s.name}`); }
    for (const leg of s.legs) {
      if (Math.abs(leg.ret_pct - ret(leg.ticker)) > 1e-3) { mathOk = false; console.log(`    leg mismatch ${s.name} ${leg.ticker}`); }
    }
  }
  ok(mathOk, "all 8 portfolio returns + legs + values match independent recompute");
  // rank order predicate: desc total, then fewer losers, then best pick, then ai-before-human, then name
  const ranked = b.standings.filter((s) => s.rank);
  let orderOk = true;
  const key = (s) => [-s.total_ret_pct, s.losers, -s.best_pick_ret_pct, s.kind === "ai" ? 0 : 1, s.name];
  const cmpKey = (a, b) => {
    for (let k = 0; k < 4; k++) { if (a[k] !== b[k]) return a[k] - b[k]; }
    return a[4] < b[4] ? -1 : a[4] > b[4] ? 1 : 0;
  };
  for (let i = 1; i < ranked.length; i++) {
    if (cmpKey(key(ranked[i - 1]), key(ranked[i])) > 0) { orderOk = false; console.log(`    order violation: ${ranked[i - 1].name} before ${ranked[i].name}`); }
  }
  ok(orderOk, "rank order respects total desc + tie-breaks");
  // Hand-computed from the FRIDAY multipliers (+4/-3/+1/+2/-1/+5/-4/+8/+2/-5):
  // Gemini 3.2, Muse 3.0, Bananas 2.4, ChatGPT 1.6 (1 loser), Cuz 1.6 (2 losers),
  // Grok 1.2, Claude 0.6, Ed 0.2 — ChatGPT beats Cuz on the fewest-losers tie-break.
  const expectOrder = ["Gemini", "Muse", "Bananas", "ChatGPT", "Cuz", "Grok", "Claude", "Ed"];
  ok(JSON.stringify(ranked.map((s) => s.name)) === JSON.stringify(expectOrder),
    `exact hand-computed rank order (${ranked.map((s) => s.name).join(", ")})`);
  ok(JSON.stringify(ranked.map((s) => s.rank)) === JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8]), "ranks 1–8 in order");
  const home = await get("/");
  ok(home.text.includes("Bananas") && home.text.includes("🐵"), "Bananas the monkey on home page");
}

console.log("— /board-image");
{
  const r = await get("/board-image");
  ok(r.status === 200 && r.text.includes("PaperTradeWars") && r.text.includes("Bananas"),
    "board-image renders with brand + contestants");
  ok(r.text.includes("Simulated · Dramatized · Not financial advice"), "disclosure footer present");
  const bad = await get("/board-image?week=99");
  ok(bad.status === 404, "unknown week -> 404");
}

console.log("— new week rollover (Tuesday–Tuesday cycle)");
{
  const nw = await adminReq("POST", "/admin/new-week", { label: "Week 2" });
  ok(nw.status === 200 && nw.text.includes("Week 2 is open"), "new week created");
  const b2 = await (await fetch(`http://127.0.0.1:${PORT}/api/board?week=2`)).json();
  ok(b2.standings.length === 6 && b2.standings.every((s) => s.kind === "ai"), "week 2: 6 AIs, drafts cleared");
  ok(b2.priced === false, "week 2 starts unpriced");
  ok(b2.standings.every((s) => s.picks.length === 5), "AI picks carried over");
  ok(b2.week.entry_label === "Tuesday 4:35 PM ET" && b2.week.cutoff_label === "Tuesday 4:00 PM ET",
    "new weeks default to Tuesday–Tuesday labels");
  const b1 = await board(1);
  ok(b1.week.label === "Week 1" && b1.standings.length === 8, "week 1 history intact (6 AI + 2 humans)");
  // AI picks editor validation on week 2 (persona ids are 1..6)
  const badPicks = await adminReq("POST", "/admin/ai-picks", {
    picks_1: "NVDA,NVDA,BTC,ETH,AAPL", picks_2: "DOGE,XRP,SOL,TSLA,AMD", picks_3: "MSFT,AAPL,ETH,BTC,AMD",
    picks_4: "NVDA,MSFT,SOL,BTC,TSLA", picks_5: "BTC,ETH,SOL,NVDA,MSFT", picks_6: "SOL,AAPL,TSLA,MSFT,NVDA",
  });
  ok(badPicks.status === 400, "AI picks editor rejects duplicate tickers");
}

console.log("— live price fetch paths (stubbed Yahoo + CoinGecko)");
{
  // Stub feeds: the server reads YAHOO_URL_TEMPLATE / COINGECKO_URL /
  // COINBASE_URL_TEMPLATE once at boot, so a second server instance gets
  // pointed at this in-process stub.
  let stubMode = "all-good"; // all-good | partial (NVDA 500s) | total (everything 500s) | cg-down (coingecko 500s, coinbase ok)
  const STUB_STOCK = { NVDA: 220.00, TSLA: 360.10, AAPL: 335.00, MSFT: 500.50, AMD: 510.25 };
  const STUB_CRYPTO = { bitcoin: 76000, ethereum: 2450, solana: 100.5, ripple: 1.30, dogecoin: 0.082 };
  const CB_TICKER_TO_ID = { BTC: "bitcoin", ETH: "ethereum", SOL: "solana", XRP: "ripple", DOGE: "dogecoin" };
  const stub = http.createServer((req, res) => {
    const u = new URL(req.url, "http://stub");
    if (u.pathname.startsWith("/yahoo/")) {
      const t = u.pathname.split("/")[2];
      if (stubMode === "total" || (stubMode === "partial" && t === "NVDA")) {
        res.writeHead(500); res.end("boom"); return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ chart: { result: [{ meta: { regularMarketPrice: STUB_STOCK[t] } }] } }));
      return;
    }
    if (u.pathname === "/coingecko") {
      if (stubMode === "total" || stubMode === "cg-down") { res.writeHead(500); res.end("boom"); return; }
      const out = {};
      for (const [id, price] of Object.entries(STUB_CRYPTO)) out[id] = { usd: price };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(out));
      return;
    }
    if (u.pathname.startsWith("/coinbase/")) {
      const t = u.pathname.split("/")[2];
      if (stubMode === "total") { res.writeHead(500); res.end("boom"); return; }
      const id = CB_TICKER_TO_ID[t];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: { amount: String(STUB_CRYPTO[id]), base: t, currency: "USD" } }));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  const stubPort = stub.address().port;

  const s3env = bootServer();
  const s3 = await startServer({
    ADMIN_SECRET: SECRET,
    TURSO_DATABASE_URL: `file:${s3env.dbFile}`,
    YAHOO_URL_TEMPLATE: `http://127.0.0.1:${stubPort}/yahoo/{T}`,
    COINGECKO_URL: `http://127.0.0.1:${stubPort}/coingecko`,
    COINBASE_URL_TEMPLATE: `http://127.0.0.1:${stubPort}/coinbase/{T}`,
  });
  const cA = makeClient(s3.PORT);
  await cA.req("POST", "/admin/login", { secret: SECRET });

  // all-good fetch-current
  stubMode = "all-good";
  const r = await cA.req("POST", "/admin/fetch-current", null);
  ok(r.status === 200 && r.text.includes("10/10 tickers"), "fetch-current all-good -> 200, 10/10");
  const b = await cA.board();
  ok(b.priced === true, "priced after fetch-current");
  ok(b.snapshots.current && b.snapshots.current.method === "fetch" && b.snapshots.current.tickers === 10,
    "current snapshot method=fetch, 10 tickers");
  // hand-check: NVDA leg = (220.00 - 212.17) / 212.17 * 100
  const nvdaRet = (220.00 - 212.17) / 212.17 * 100;
  const leg = b.standings.find((s) => s.name === "ChatGPT").legs.find((l) => l.ticker === "NVDA");
  ok(Math.abs(leg.ret_pct - nvdaRet) < 1e-3, `fetched NVDA leg matches hand calc (${leg.ret_pct} vs ${nvdaRet.toFixed(4)})`);

  // partial failure: NVDA's Yahoo call 500s — it must keep its previous price
  stubMode = "partial";
  const before = (await cA.board()).standings.find((s) => s.name === "ChatGPT").legs.find((l) => l.ticker === "NVDA").ret_pct;
  const rp = await cA.req("POST", "/admin/fetch-current", null);
  ok(rp.status === 200 && rp.text.includes("9/10 tickers"), "partial fetch -> 200, 9/10");
  ok(rp.text.includes("NVDA"), "failure message names the failed ticker");
  const after = (await cA.board()).standings.find((s) => s.name === "ChatGPT").legs.find((l) => l.ticker === "NVDA").ret_pct;
  ok(Math.abs(after - before) < 1e-9, "failed ticker keeps its previous price (never zeroed)");

  // total failure: 502, nothing changes, failure snapshot is NOT the latest ok one
  stubMode = "total";
  const bBefore = await cA.board();
  const rt = await cA.req("POST", "/admin/fetch-current", null);
  ok(rt.status === 502, "total fetch failure -> 502");
  ok(rt.text.includes("nothing changed"), "502 page says nothing changed");
  const bAfter = await cA.board();
  ok(JSON.stringify(bAfter.standings.map((s) => s.total_ret_pct)) ===
    JSON.stringify(bBefore.standings.map((s) => s.total_ret_pct)), "total failure changes no prices");
  ok(bAfter.snapshots.current.method === "fetch", "latest ok snapshot still the good fetch");

  // resilience: CoinGecko 500s -> Coinbase fallback still prices all 5 crypto
  stubMode = "cg-down";
  const rcg = await cA.req("POST", "/admin/fetch-current", null);
  ok(rcg.status === 200 && rcg.text.includes("10/10 tickers"), "coingecko down -> coinbase fallback, 200, 10/10");
  // hand-check: BTC leg = (76000 - 75643.87) / 75643.87 * 100
  const btcRet = (76000 - 75643.87) / 75643.87 * 100;
  const btcLeg = (await cA.board()).standings.find((s) => s.name === "ChatGPT").legs.find((l) => l.ticker === "BTC");
  ok(Math.abs(btcLeg.ret_pct - btcRet) < 1e-3, `coinbase BTC leg matches hand calc (${btcLeg.ret_pct} vs ${btcRet.toFixed(4)})`);

  // fetch-entry on a fresh week (doesn't disturb the locked Week 1 entries)
  stubMode = "all-good";
  const nw = await cA.req("POST", "/admin/new-week", { label: "Week 9" });
  ok(nw.status === 200, "new week opened for entry-fetch test");
  const re = await cA.req("POST", "/admin/fetch-entry", null);
  ok(re.status === 200 && re.text.includes("10/10 tickers"), "fetch-entry all-good -> 200, 10/10");
  ok(re.text.includes('name="entry_NVDA" value="220"'), "fetched entry price landed in DB (admin re-render)");
  const b2 = await cA.board(2);
  ok(b2.snapshots.entry && b2.snapshots.entry.method === "fetch", "week 2 entry snapshot method=fetch");
  ok(b2.priced === false && b2.snapshots.current === null, "week 2 unpriced until current refresh");

  // robustness: malformed cookie must not 500
  const badCookie = await fetch(`http://127.0.0.1:${s3.PORT}/`, { headers: { cookie: "ptw_session=%" } });
  ok(badCookie.status === 200, "malformed session cookie -> 200, not 500");

  // open redirect: protocol-relative next must be rejected
  const cB = makeClient(s3.PORT);
  await cB.req("POST", "/signup", { email: "x@y.zz", display_name: "Xx", password: "password123", next: "//evil.com" });
  const lr = await cB.req("POST", "/login", { email: "x@y.zz", password: "password123", next: "//evil.com" });
  ok(lr.status === 302 && lr.loc === "/", `protocol-relative next rejected (Location: ${lr.loc})`);
  const gl = await cB.req("GET", "/login?next=//evil.com");
  ok(gl.status === 302 && gl.loc === "/", "logged-in GET /login with bad next -> /");

  s3.server.kill();
  stub.close();
}

server.kill();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
