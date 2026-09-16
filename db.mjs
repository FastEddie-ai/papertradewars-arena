// PaperTradeWars arena — database layer.
// libsql client: Turso when TURSO_DATABASE_URL is set, local SQLite file otherwise
// (same pattern as prediction-arena). Async API throughout.
import { createClient } from "@libsql/client";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import crypto from "node:crypto";

const rootDir = process.cwd();

function resolveDatabaseUrl() {
  if (process.env.TURSO_DATABASE_URL) return process.env.TURSO_DATABASE_URL;
  if (process.env.DB_PATH) {
    const p = process.env.DB_PATH;
    return p.startsWith("file:") ? p : `file:${p.startsWith("/") ? p : join(rootDir, p)}`;
  }
  return `file:${join(rootDir, "data", "arena.db")}`;
}

function ensureParentDir(url) {
  if (!url.startsWith("file:")) return;
  let p = url.slice("file:".length);
  if (!p.startsWith("/")) p = join(rootDir, p);
  mkdirSync(dirname(p), { recursive: true });
}

const DB_URL = resolveDatabaseUrl();
ensureParentDir(DB_URL);

export const client = createClient({
  url: DB_URL,
  authToken: process.env.TURSO_AUTH_TOKEN || undefined,
});

export function dbMode() {
  return DB_URL.startsWith("file:") ? "local-sqlite" : "turso";
}

export const nowIso = () => new Date().toISOString();
export const nanoid = (n = 16) => crypto.randomBytes(n).toString("hex").slice(0, n);

// ---------------------------------------------------------------- schema (v2)
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS weeks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL,
    entry_label TEXT NOT NULL DEFAULT 'Tuesday 4:35 PM ET',
    cutoff_label TEXT NOT NULL DEFAULT 'Tuesday 4:00 PM ET',
    created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS assets (
    ticker TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('stock','crypto')))`,
  `CREATE TABLE IF NOT EXISTS personas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    emoji TEXT NOT NULL,
    color TEXT NOT NULL,
    tagline TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS ai_picks (
    week_id INTEGER NOT NULL,
    persona_id INTEGER NOT NULL,
    slot INTEGER NOT NULL CHECK (slot BETWEEN 1 AND 5),
    ticker TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (week_id, persona_id, slot))`,
  `CREATE TABLE IF NOT EXISTS prices (
    week_id INTEGER NOT NULL,
    ticker TEXT NOT NULL,
    entry REAL,
    current REAL,
    PRIMARY KEY (week_id, ticker))`,
  `CREATE TABLE IF NOT EXISTS price_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    week_id INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('entry','current')),
    method TEXT NOT NULL CHECK (method IN ('fetch','manual')),
    ok INTEGER NOT NULL DEFAULT 1,
    fetched_at TEXT NOT NULL,
    fetched_at_et TEXT NOT NULL,
    source TEXT NOT NULL,
    values_json TEXT NOT NULL,
    failures_json TEXT)`,
  // Real accounts (v2): email + password. Drafts bind to user_id — no squattable names.
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    revoked_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS drafts (
    week_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    picks TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (week_id, user_id))`,
];

// ---------------------------------------------------------------- Season 1 seed (real data, Week 1 locked)
const SEED_ASSETS = [
  ["MSFT", "Microsoft", "stock"], ["AAPL", "Apple", "stock"], ["NVDA", "Nvidia", "stock"],
  ["TSLA", "Tesla", "stock"], ["AMD", "AMD", "stock"],
  ["BTC", "Bitcoin", "crypto"], ["ETH", "Ethereum", "crypto"], ["SOL", "Solana", "crypto"],
  ["XRP", "XRP", "crypto"], ["DOGE", "Dogecoin", "crypto"],
];
const SEED_PERSONAS = [
  ["ChatGPT", "🤖", "#10a37c", "Blue-chip + majors. The sensible one."],
  ["Grok", "😈", "#f97316", "Full meme. The timeline's portfolio."],
  ["Claude", "🧠", "#d97706", "Careful and diversified. The adult in the room."],
  ["Gemini", "✨", "#3b82f6", "Chasing the AI trade."],
  ["Muse", "🟣", "#8b5cf6", "The insider. Ed's own model — no pressure."],
  ["Bananas", "🐵", "#a16207", "A monkey throwing darts. The control group."],
];
// [personaIndex(0-based), ticker, note]
const SEED_PICKS = [
  [0, "MSFT", "The cloud cash machine."], [0, "AAPL", "Can't argue with the install base."],
  [0, "NVDA", "AI picks and shovels."], [0, "BTC", "Digital gold, small slice."],
  [0, "ETH", "The app store of crypto."],
  [1, "DOGE", "The people's coin. Obviously."], [1, "SOL", "Fast. Cheap. Memeable."],
  [1, "XRP", "The army holds."], [1, "TSLA", "Not a car company."],
  [1, "NVDA", "Even memes need chips."],
  [2, "MSFT", "Boring in the best way."], [2, "AAPL", "Nobody got fired for buying Apple."],
  [2, "ETH", "Useful beats hype."], [2, "BTC", "The reserve asset."],
  [2, "AMD", "The sensible chip bet."],
  [3, "NVDA", "The AI trade, full stop."], [3, "MSFT", "Copilot money."],
  [3, "SOL", "Speed wins."], [3, "BTC", "Have to hold some."],
  [3, "TSLA", "Robots."],
  [4, "BTC", "The insider's anchor."], [4, "ETH", "Gas fees pay."],
  [4, "SOL", "Throughput matters."], [4, "NVDA", "Compute is king."],
  [4, "MSFT", "The safe pair of hands."],
  [5, "SOL", "Dart one."], [5, "AAPL", "Dart two."], [5, "TSLA", "Dart three."],
  [5, "MSFT", "Dart four."], [5, "NVDA", "Dart five. See you Tuesday."],
];
// Week 1 entry prices, locked Tue Sep 15, 2026 ~4:35 PM ET (master record:
// goals/make-10-000-month-from-my-own-products/files/week1-draft-2026-09-15.md)
export const SEED_ENTRY = {
  MSFT: 497.12, AAPL: 331.34, NVDA: 212.17, TSLA: 356.58, AMD: 504.20,
  BTC: 75643.87, ETH: 2399.60, DOGE: 0.07996, XRP: 1.2708, SOL: 96.71,
};

async function seedSeason1() {
  const insA = `INSERT INTO assets (ticker,name,kind) VALUES (?,?,?)`;
  for (const a of SEED_ASSETS) await client.execute({ sql: insA, args: a });
  const ids = [];
  for (const p of SEED_PERSONAS) {
    const r = await client.execute({
      sql: `INSERT INTO personas (name,emoji,color,tagline) VALUES (?,?,?,?)`, args: p,
    });
    ids.push(Number(r.lastInsertRowid));
  }
  const w = await client.execute({
    sql: `INSERT INTO weeks (label, entry_label, cutoff_label) VALUES (?,?,?)`,
    args: ["Week 1", "Tue Sep 15, 2026 ~4:35 PM ET", "Tue Sep 22, 2026 4:00 PM ET"],
  });
  const weekId = Number(w.lastInsertRowid);
  const slotCount = {};
  for (const [pi, ticker, note] of SEED_PICKS) {
    slotCount[pi] = (slotCount[pi] || 0) + 1;
    await client.execute({
      sql: `INSERT INTO ai_picks (week_id,persona_id,slot,ticker,note) VALUES (?,?,?,?,?)`,
      args: [weekId, ids[pi], slotCount[pi], ticker, note],
    });
  }
  for (const [t, v] of Object.entries(SEED_ENTRY)) {
    await client.execute({
      sql: `INSERT INTO prices (week_id,ticker,entry,current) VALUES (?,?,?,NULL)`,
      args: [weekId, t, v],
    });
  }
  // The entry snapshot is real locked data — log it so the board's provenance tells the truth.
  await client.execute({
    sql: `INSERT INTO price_snapshots (week_id,kind,method,ok,fetched_at,fetched_at_et,source,values_json,failures_json)
          VALUES (?,?,?,?,?,?,?,? ,NULL)`,
    args: [weekId, "entry", "manual", 1, "2026-09-15T20:35:00.000Z",
      "Tue, Sep 15, 2026, ~4:35 PM EDT", "week1-lock", JSON.stringify(SEED_ENTRY)],
  });
  console.log(`[db] seeded Season 1 Week 1: 6 contestants, 30 picks, 10 entry prices (locked).`);
}

async function getMeta(key) {
  const r = await client.execute({ sql: `SELECT value FROM schema_meta WHERE key=?`, args: [key] });
  return r.rows[0]?.value ?? null;
}

export async function initDb() {
  for (const stmt of SCHEMA) await client.execute(stmt);
  const v = await getMeta("schema_version");
  if (v !== "2") {
    // v1 (node:sqlite prototype) had invented personas + squattable drafts — rebuild from real data.
    for (const t of ["price_snapshots", "prices", "ai_picks", "drafts", "personas", "assets", "weeks"]) {
      await client.execute(`DROP TABLE IF EXISTS ${t}`);
    }
    for (const stmt of SCHEMA) await client.execute(stmt);
    await seedSeason1();
    await client.execute({
      sql: `INSERT INTO schema_meta (key,value) VALUES ('schema_version','2')
            ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    });
    console.log(`[db] schema v2 ready (${dbMode()}).`);
  }
}
