// PaperTradeWars scoring — pure functions, no DB, no side effects.
// Unit-tested directly by test-qa.mjs; used by server.mjs for the live board.

// Equal 20% weights: a portfolio's return is the mean of its 5 pick returns.
// Returns null when any leg can't be priced yet (missing entry/current).
export function scorePortfolio(tickers, prices) {
  const legs = [];
  for (const t of tickers) {
    const pr = prices[t];
    if (!pr || pr.entry == null || pr.current == null || pr.entry <= 0) return null; // not priced yet
    legs.push({ ticker: t, ret: ((pr.current - pr.entry) / pr.entry) * 100 });
  }
  const total = legs.reduce((s, l) => s + l.ret, 0) / legs.length;
  const losers = legs.filter((l) => l.ret < 0).length;
  const best = Math.max(...legs.map((l) => l.ret));
  return { legs, total, losers, best, value: 10000 * (1 + total / 100) };
}

// Ranked-board comparator. Tie-breaks: 1) higher total return,
// 2) fewer losing picks, 3) best single pick, 4) AI before humans, 5) name.
// Exported so QA can pin the contract with exact ties (float dust from live
// prices can otherwise mask whether a tie-break branch was even reached).
export function compareRanked(a, b) {
  return b.score.total - a.score.total ||
    a.score.losers - b.score.losers ||
    b.score.best - a.score.best ||
    (a.kind === b.kind ? a.name.localeCompare(b.name) : (a.kind === "ai" ? -1 : 1));
}
