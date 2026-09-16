# Investor Arena v0.1 — Build Notes

**What it is:** the scoreboard site for the AI-trader spectacle. Six AI personas
(each with a weekly 5-ticker draft from the 10-asset menu) compete on a public
leaderboard; humans can draft their own 5-ticker portfolio from the same menu and
appear on the same board. Simulated portfolios, entertainment only.

**Brand:** title is the `SITE_TITLE` env var (default "Investor Arena"). The
recommended brand "BotBracket" is NOT locked in — rename anytime via env.

**Stack:** Node 22+ · Express · SQLite via `node:sqlite` (zero native deps) ·
server-rendered HTML, no build step. One file: `server.mjs`.

## Run locally

```bash
cd ~/workspace/investor-arena
npm install
ADMIN_SECRET=something-long-and-random node server.mjs
# open http://localhost:3000
```

DB lives at `./data/arena.db` (auto-created + seeded with Week 1: 6 personas,
30 picks verbatim from the Week 1 content pack).

## Pages

- `/` — leaderboard (AI + humans, ranked), draft board with persona notes, rules.
  `?week=N` views past weeks. Shows price provenance ("Prices — entry: … · current: …").
- `/draft` — human draft form: display name + 5 tickers. One draft per name per week
  (case-insensitive). Prototype: no passwords, names are first-come.
- `/admin` — secret login → ⚡ live price fetch card (one-click ENTRY snapshot +
  CURRENT refresh, with last-snapshot timestamps), manual price entry (fallback),
  AI-pick editor, new-week rollover.
- `/api/board` — JSON standings (used by QA; handy for future video tooling).
  Now includes `snapshots: { entry, current }` (method, source, ET timestamp, ticker count).
- `/board-image` — screenshot-ready scoreboard graphic for video production (no auth,
  same public data as `/`): 420px vertical column, dark, big SITE_TITLE, ranked rows
  with emoji + name + green/red %, medals + leader highlight, Week N label,
  entry/cutoff dates, price-provenance line, "Simulated · Not financial advice" footer.
  `?week=N` for past weeks; shows "Awaiting entry prices" gracefully before prices are entered.

## Live price feed (Phase 1 — landed)

- **Stocks** (NVDA, TSLA, AAPL, MSFT, AMD): Yahoo Finance v8 chart API, no key —
  `chart.result[0].meta.regularMarketPrice`, 5 parallel calls with a browser UA.
  (Stooq was the original plan but now serves a JS bot-challenge to servers; dead.)
- **Crypto** (BTC, ETH, SOL, XRP, DOGE): CoinGecko free `simple/price`, no key.
- **Admin UX:** "📸 Fetch & set ENTRY prices" (Monday ~9:35 AM ET, one click) and
  "🔄 Fetch & update CURRENT prices" (anytime). Manual entry remains as fallback.
- **Failure model:** per-ticker — a failed ticker keeps its previous value, never
  zeroed out; the result message names every failed ticker + source + error. Total
  failure → 502, nothing touched.
- **Audit trail:** `price_snapshots` table (week_id, kind entry|current, method
  fetch|manual, ok flag, ISO + ET timestamps, source, values JSON, failures JSON).
  Manual saves are logged too, so the board's provenance line always tells the truth.
- **QA overrides:** `YAHOO_URL_TEMPLATE` (`{T}` placeholder) and `COINGECKO_URL` env
  vars for failure-path testing.

## Scoring (matches the content-pack spec exactly)

- Equal 20% weights; portfolio return = mean of the 5 pick returns.
- `pick return % = (current − entry) / entry × 100`; portfolio value = $10,000 × (1 + return/100).
- Tie-breaks: fewest losing picks → best single pick → AI before humans, then name
  (the pack's "coin flip on camera" stays a content moment, not site logic).
- A portfolio only scores when all 5 picks have entry + current prices.

## What's stubbed / known limitations

1. **~~Manual prices.~~ Live feed is in (see above).** Remaining: scheduled Monday
   9:35 AM ET auto-snapshot (needs a cron/Render cron job — not scheduled until Ed
   declares the real Week 1 date), Yahoo/CoinGecko rate-limit retries/backoff.
2. **No real accounts.** Draft names are trivially squattable — fine for v0.1,
   needs real auth before public launch.
3. **Render free tier has no persistent disk** — the SQLite file resets on
   redeploy/restart. Add Turso (same pattern as the Prediction Arena) or a paid
   disk before real users draft.
4. **One shared 10-asset menu for all weeks** (add/edit assets is a next step).
5. **No broker CTA links** — gated on eToro US affiliate approval (see pack §5).

## Deploy (when Ed is ready — he drives from his iPhone)

`render.yaml` is included (free tier, `npm install` → `node server.mjs`).
Set `ADMIN_SECRET` (auto-generated) and `SITE_TITLE`. Do NOT deploy before the
price feed + accounts land if real users will draft.

## QA status

- `npm run qa` — 37 checks, all passing: seed data verbatim (6 personas, 30
  picks), admin auth (wrong secret 401, unauth 403, negative price 400), scoring
  math independently recomputed for all portfolios, pack worked example
  (MSFT 505.41→520.00 = +2.89%) verified, rank order + tie-breaks, human draft
  validation (dup name 409 case-insensitive, dup tickers 400, off-menu 400,
  blank name 400), week rollover (drafts cleared, picks carried, history intact).
- Second pass — 13 checks: form structure, lowercase ticker normalization, XSS
  escaping on names, unknown-week 404, partial-pricing safety, zero-price
  rejection, admin prefill. All passing.
- Bugs found and fixed during QA: `db.transaction is not a function`
  (node:sqlite has no such helper — replaced with manual BEGIN/COMMIT/ROLLBACK).
- Phase 1 QA (`/tmp/qa-prices.mjs`, run twice, fresh temp DBs): **26/26 × 2** —
  real fetch end-to-end (all 10 tickers, stored values match an independent fetch
  with 0.000% worst relative diff), total-failure 502 with zero changes,
  partial failure (crypto applied, stocks kept old values, failed tickers named),
  manual fallback + snapshot logging, provenance lines on `/`, `/board-image`,
  `/api/board`. Existing `npm run qa`: **37/37**, no regressions.
- Notable find: **Stooq is dead as a server source** (JS bot-challenge on all
  endpoints as of 2026-09-15) — stocks moved to Yahoo Finance v8 chart API.
  `capture-prices.sh` updated to match.

---

# v0.2 — Public-ready PaperTradeWars build (2026-09-15)

**What changed since v0.1:**
1. **Rebrand:** default `SITE_TITLE` is now `PaperTradeWars` (was "Investor Arena").
2. **Real Season 1 data:** the invented personas are gone. Seed is now
   ChatGPT, Grok, Claude, Gemini, Muse, and Bananas 🐵 (the monkey), each with
   their real Week 1 five-ticker drafts (see `db.mjs` seed + the Week 1 master
   record at `~/workspace/goals/make-10-000-month-from-my-own-products/files/week1-draft-2026-09-15.md`).
3. **Locked entry prices pre-seeded** (source `week1-lock`, method `manual`):
   MSFT 497.12, AAPL 331.34, NVDA 212.17, TSLA 356.58, AMD 504.20,
   BTC 75643.87, ETH 2399.60, DOGE 0.07996, XRP 1.2708, SOL 96.71.
   Do NOT re-snapshot entry prices for Week 1.
4. **Tuesday–Tuesday week cycle:** Week 1 entry label "Tue Sep 15, 2026 ~4:35 PM
   ET", cutoff "Tue Sep 22, 2026 4:00 PM ET". Admin labels, rules text, and
   `/board-image` dates follow this cycle.
5. **Real accounts:** email + password (bcrypt) + session cookies, one account
   per email, unique display name. Human drafts bind to accounts — the old
   squattable name field is gone. Google OAuth is a planned later upgrade.
6. **Turso persistence:** `@libsql/client`; Turso is primary when
   `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` are set, local SQLite file fallback
   for dev only. `render.yaml` updated (service `papertradewars-arena`,
   `ADMIN_SECRET` generated, Turso + `APP_URL` as manual env vars).
7. **Scoring extracted** to `scoring.mjs` (same math: mean of 5 pick returns;
   tie-breaks fewest losers → best single pick → AI before humans → name).

**Verification (2026-09-15):** 87/87 QA checks green across 3 consecutive runs;
3 real bugs fixed (broken `txn()` on the file client, admin price form wiping
the untouched price column, open-redirect + malformed-cookie issues); scoring
math hand-verified against the Week 1 master record; price-feed failure paths
tested against stubs; smoke-tested boot + `/api/health` + `/api/board` +
`/` + `/board-image` (all 200, correct Season 1 data).

**Deploy:** see `DEPLOY_NOTES.md`. Deploy zip:
`~/workspace/your_files/papertradewars-arena-site.zip` (excludes node_modules;
includes `scoring.mjs`, `db.mjs`, `server.mjs`, `test-qa.mjs`, docs).

**Still parked:** broker CTA links, subscriptions, Google OAuth.
