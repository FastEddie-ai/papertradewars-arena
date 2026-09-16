#!/usr/bin/env bash
# Capture entry/current prices for the 10-asset menu.
# Stocks via Yahoo Finance v8 (no key), crypto via CoinGecko (no key).
# (Stooq was dropped: it now serves a JS bot-challenge to servers.)
# Usage: ./capture-prices.sh >> prices.log
set -u
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
TS=$(TZ=America/New_York date '+%Y-%m-%d %H:%M %Z')
echo "=== $TS ==="
# Stocks: NVDA TSLA AAPL MSFT AMD (yahoo v8 chart -> regularMarketPrice)
for t in NVDA TSLA AAPL MSFT AMD; do
  p=$(curl -s -m 15 -A "$UA" "https://query1.finance.yahoo.com/v8/finance/chart/${t}?interval=1d&range=1d" \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['chart']['result'][0]['meta']['regularMarketPrice'])" 2>/dev/null)
  echo "$t ${p:-FAILED}"
done
# Crypto: BTC ETH SOL XRP DOGE (coingecko)
curl -s -m 15 "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana,ripple,dogecoin&vs_currencies=usd" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); m={'bitcoin':'BTC','ethereum':'ETH','solana':'SOL','ripple':'XRP','dogecoin':'DOGE'}; [print(m[k], v['usd']) for k,v in d.items()]"
