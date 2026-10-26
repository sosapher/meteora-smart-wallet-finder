# Meteora Smart Wallet Finder

[![test](https://github.com/sosapher/meteora-smart-wallet-finder/actions/workflows/test.yml/badge.svg)](https://github.com/sosapher/meteora-smart-wallet-finder/actions/workflows/test.yml)

Read-only research bot that finds and scores **smart LP wallets on Meteora DLMM**, then
exports them in a format that can be added manually to Meridian's
`smart-wallets.json`.

It never touches private keys, never signs transactions, and never modifies Meridian
unless you explicitly run `export --merge`.

```
Pool discovery ──> top LPers ──> candidate aggregation ──> deep check
                                                              │
                                          closed-position PnL history
                                                              │
                                                    metrics + score
                                                              │
                             exports/recommended.*  ──>  manual Meridian entry
```

## Requirements

- Node.js 18 or newer
- Network access to Meteora and Agent Meridian APIs
- No npm dependencies

## Install

### On a fresh VPS

```bash
git clone https://github.com/sosapher/meteora-smart-wallet-finder.git
cd meteora-smart-wallet-finder
npm run setup
node finder.js config
```

`npm run setup` copies `config.example.json` to `config.json`. There are no npm
dependencies, so `npm install` is not required.

If Meridian is installed somewhere else, edit
`export.meridianSmartWalletsPath` in `config.json`. The default is
`../meridian/smart-wallets.json`, relative to this project.

`config.json` is gitignored, so your local settings stay local.

### Smoke test

```bash
node finder.js pools --pools 3
node finder.js scan --pools 3 --top 3 --no-export
```

## Commands

```bash
# Full scan: discover pools, find top LPers, deep-check, score, export
node finder.js scan

# Quick scan
node finder.js scan --pools 5 --top 8

# Ignore caches
node finder.js scan --refresh

# List pools that pass the discovery filters
node finder.js pools --pools 20

# Deep-check one wallet
node finder.js check 7Weigvc3E2kE42djnRFths1ReU62HYf8q1fRVHnexGkK

# Re-export from the last scan at a stricter score
node finder.js export --min-score 80

# Opt in: merge into Meridian's smart-wallets.json (creates a backup)
node finder.js export --merge

# Continuous watch mode
node finder.js watch --interval 30

# Print effective config with secrets masked
node finder.js config
```

Run `node finder.js --help` for every option.

### Useful flags

| Flag | Effect |
|---|---|
| `--pools <n>` | Maximum pools to scan |
| `--top <n>` | Base candidates to deep-check (multi-pool wallets may add up to 10) |
| `--pool <addr,...>` | Scan specific pools, skipping discovery |
| `--min-score <n>` | Override `export.minScore` for this run |
| `--refresh` | Ignore cache |
| `--no-cache` | Disable cache entirely |
| `--no-export` | Do not write export files |
| `--allow-partial` | Allow low-confidence wallets |
| `--merge` | Merge exported wallets into Meridian |
| `--json` | Machine-readable output |
| `--once` | Watch mode: one scan then exit |

## Outputs

| File | Purpose |
|---|---|
| `data/last-scan.json` | Full scan result, including per-position detail |
| `data/state.json` | Wallet scores across watch cycles |
| `data/check-<wallet>.json` | Single-wallet report |
| `exports/recommended.json` | Wrapper with metadata and criteria |
| `exports/recommended.snippet.json` | Plain array ready to copy |
| `exports/recommended.md` | Human-readable report |
| `data/finder.log` | Append-only log |

`exports/recommended.snippet.json` contains entries in Meridian's format:

```json
[
  {
    "name": "auto-28F7nE",
    "address": "28F7nEtbmHJbAZkDH6U6LYNvWrXksDSoGUhhrdvyTs6L",
    "category": "smart",
    "type": "lp",
    "addedAt": "2026-10-26T09:00:00.000Z"
  }
]
```

Only `name`, `address`, and `type` matter to Meridian. `category` is display-only.
`type` must be `"lp"` for Meridian's smart-LP checks to include the wallet.

## How scoring works

A wallet must first pass **all gates**:

| Gate | Default | Config |
|---|---:|---|
| Closed positions | >= 5 | `metrics.minClosedPositions` |
| Win rate | >= 45% | `score.minWinRatePct` |
| Fee yield | >= 1% | `score.minFeeYieldPct` |
| Net ROI | >= 0% | `score.minNetRoiPct` |
| Total deposits | >= $500 | `metrics.minTotalDepositUsd` |
| Recency | active/open within 30 days | `metrics.maxDaysSinceActive` |
| Data confidence | not `low` | `score.allowLowConfidence` |

Qualified wallets receive a 0–100 weighted score:

| Component | Max | Meaning |
|---|---:|---|
| Sample size | 10 | More closed positions = more reliable |
| Win rate | 15 | Share of profitable closed positions |
| Fee yield | 20 | Fees earned / total deposits |
| Net ROI | 15 | Net PnL / total deposits |
| Profit factor | 10 | Gross profit / gross loss |
| Behavior | 10 | Hold time and range width profile |
| Pool diversity | 5 | Distinct pools traded |
| Recency | 10 | How recently the wallet was active |
| Fee share | 3 | Rewards fee-driven, not price-only, profit |
| Risk | 2 | Penalizes outliers, big losses, churn |

Statuses:

- **recommended**: qualified and score >= 75 → exported
- **watch**: qualified and score >= 62
- **rejected**: failed a gate or scored below 62

Tiers: `S >= 85`, `A >= 75`, `B >= 65`, `C >= 55`, `D < 55`.

Warnings are informational and do not auto-reject a wallet. Examples:
`low_sample`, `one_pool`, `ultra_tight`, `too_wide`, `outlier_dependent`,
`big_loss`, `fee_driven`, `price_dependent`, `stale`, `partial_data`.

### Why closed positions, not aggregate fields?

Agent Meridian's `/top-lp` aggregate fields (`winRatePct`, `totalLp`,
`avgAgeHours`) are often `0`, so the bot deep-checks each candidate against
Meteora's closed-position PnL endpoint. Metrics come from actual positions:
deposits, fees, PnL, hold time, bin width, and pool.

## Adding wallets to Meridian

Meridian reads `smart-wallets.json` on every tool call, so **no restart is
needed**. By default this project targets `../meridian/smart-wallets.json`;
change `export.meridianSmartWalletsPath` if Meridian lives elsewhere.

Manual method:

1. Open `exports/recommended.snippet.json`.
2. Copy the entries you trust into the `wallets` array of
   `smart-wallets.json` in your Meridian installation.
3. Ask Meridian to run a smart-wallet check on a pool to confirm the wallets load.

Opt-in merge method:

```bash
node finder.js export --merge
```

This rewrites the Meridian file atomically, skips addresses already present, and
creates a timestamped `.bak.<ms>` backup first. Review the result before relying on it.

Keep the list small (roughly 5–20 wallets). Meridian checks each `type: "lp"`
wallet against active positions and caches positions for 5 minutes, so a long list
means more RPC and API work.

## Configuration

Start from `config.example.json`. The most useful fields:

```jsonc
{
  "pools": {
    "timeframe": "24h",          // 5m, 30m, 1h, 2h, 4h, 12h, 24h
    "limit": 20,                 // pools scanned per run
    "minTvl": 50000,
    "minVolume": 50000,
    "minUniqueLps": 25,
    "minPositionsCreated": 50,
    "minAgeDays": 3,
    "excludeStablePairs": true
  },
  "discovery": {
    "topLpersPerPool": 20,
    "deepCheckTop": 25,
    "concurrency": 2,            // keep low: upstream rate-limits
    "maxPoolsPerWallet": 3
  },
  "metrics": {
    "minClosedPositions": 5,
    "minPositionDepositUsd": 50,
    "minTotalDepositUsd": 500,
    "maxDaysSinceActive": 30
  },
  "score": {
    "minScore": 75,
    "watchMinScore": 62,
    "minWinRatePct": 45,
    "minFeeYieldPct": 1,
    "minNetRoiPct": 0
  },
  "export": {
    "minScore": 75,
    "maxWallets": 10,
    "namePrefix": "auto",
    "type": "lp",
    "meridianSmartWalletsPath": "../meridian/smart-wallets.json",
    "excludeExisting": true
  }
}
```

Environment overrides:

| Variable | Overrides |
|---|---|
| `AGENT_MERIDIAN_BASE` | `api.agentMeridianBase` |
| `AGENT_MERIDIAN_API_KEY` | `api.agentMeridianApiKey` |
| `MERIDIAN_SMART_WALLETS` | `export.meridianSmartWalletsPath` |
| `TELEGRAM_BOT_TOKEN` | `telegram.botToken` |
| `TELEGRAM_CHAT_ID` | `telegram.chatId` |
| `RPC_URL` | `hygiene.rpcUrl` (reserved) |

## Watch mode and Telegram

```bash
node finder.js watch --interval 30
```

Each cycle runs a scan, updates `data/state.json`, and reports newly recommended
wallets whose score is at least `watch.alertMinScore`. Set
`watch.telegram: true` plus `telegram.botToken` and `telegram.chatId` to send
HTML alerts. Invalid tokens are not fatal; the bot logs a warning and continues.

### Run under PM2

```bash
cd ~/meteora-smart-wallet-finder
pm2 start ecosystem.config.cjs
pm2 logs meteora-smart-wallet-finder
pm2 save
```

The included ecosystem file runs `finder.js watch` with the default 30-minute
interval. It is independent of the existing `meridian` PM2 process.

## API sources and limitations

| Source | Used for |
|---|---|
| `pool-discovery-api.datapi.meteora.ag/pools` | Pool discovery and 24h metrics |
| `api.agentmeridian.xyz/api/top-lp/<pool>` | Ranked LPers per pool |
| `api.agentmeridian.xyz/api/study-top-lp/<pool>` | Fallback when `/top-lp` fails |
| `dlmm.datapi.meteora.ag/portfolio/open?user=<wallet>` | Open positions |
| `dlmm.datapi.meteora.ag/positions/<pool>/pnl?user=<wallet>&status=closed` | Closed-position history |

Known limitations:

- `/top-lp` intermittently returns HTTP 500 with `upstream HTTP 429`. The bot falls
  back to `/study-top-lp`, which exposes fewer owners per pool (~5). That narrows
  coverage but keeps scans working.
- Fallback data has no inflow figures. The preliminary ranking then uses the
  available per-owner fee/PnL percentages instead.
- Meteora's pool sorting is unreliable server-side; the bot fetches pages and
  sorts locally.
- Many healthy DLMM positions have `widthBins = 1`. This is real single-bin
  behavior, flagged `ultra_tight` and penalized only mildly in behavior score.
- Closed-position history is limited by `metrics.maxPagesPerPool` (default 2 pages
  of 50) per pool. Wallets with long histories may be truncated; the
  `partial_data` flag surfaces this.
- Only positions above `minPositionDepositUsd` are counted.
- Wallet history is not predictive. A wallet can change strategy or stop working
  at any time.

## Read-only guarantee

This project contains no wallet keys, no signing code, and no transaction
submission. It only performs HTTP GET requests plus local file writes for caches,
logs, state, and exports. The only write outside its own directory is the opt-in
`--merge` target, which always creates a backup first.

## Development

```bash
npm test          # node:test suite
node --check finder.js
```

Layout:

```
finder.js            CLI and orchestration
src/config.js        defaults, merge, env overrides, validation
src/pools.js         discovery, filtering, pool scoring
src/lpers.js         top-LPer fetching, fallback, aggregation
src/wallets.js       portfolio/open, closed PnL, deep check
src/metrics.js       closed-position metrics and flags
src/score.js         gates, weighted score, tiers
src/output.js        tables, exports, Meridian merge
src/state.js         watch-mode state
src/telegram.js      optional alerts
test/                node:test unit tests
```

## Disclaimer

This is research software, not financial advice. Smart-wallet history does not
guarantee future performance. Always verify a wallet manually before adding it to
Meridian or allocating capital.
