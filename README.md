# Meteora Smart Wallet Finder

[![test](https://github.com/sosapher/meteora-smart-wallet-finder/actions/workflows/test.yml/badge.svg)](https://github.com/sosapher/meteora-smart-wallet-finder/actions/workflows/test.yml)

Read-only research bot that finds and scores **smart LP wallets on Meteora DLMM**, then
exports them in formats that can be added manually to Meridian's
`smart-wallets.json` or batch-imported into **GMGN's followed-wallet list**.

It never touches private keys, never signs transactions, and never modifies Meridian
unless you explicitly run `export --merge`. Scans can be triggered from the CLI or
from a private Telegram control bot. An optional Helius RPC endpoint adds wallet
age, SOL balance, and funding-source checks.

```
Pool discovery ──> top LPers ──> candidate aggregation ──> deep check
                                                              │
                                          closed-position PnL history
                                                              │
                                                    metrics + score
                                                              │
                             exports/recommended.*  ──>  manual Meridian entry
                             exports/gmgn-follow.json ──>  GMGN batch import
```

## Requirements

- Node.js 18 or newer
- Network access to Meteora and Agent Meridian APIs
- Optional: a Helius RPC endpoint for on-chain wallet checks
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

# Re-write only the GMGN files
node finder.js export --gmgn-only

# Preview what would be exported without writing anything
node finder.js export --dry-run

# Opt in: merge into Meridian's smart-wallets.json (creates a backup)
node finder.js export --merge

# Continuous watch mode
node finder.js watch --interval 30

# Telegram control bot: /scan, /stop, /status, /last
node finder.js bot

# On-chain hygiene for one wallet (requires Helius RPC)
node finder.js hygiene 7Weigvc3E2kE42djnRFths1ReU62HYf8q1fRVHnexGkK

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
| `--gmgn-only` | Re-write only the GMGN files, leaving Meridian exports untouched |
| `--dry-run` | Compute exports but do not write files or update the GMGN ledger |
| `--allow-partial` | Allow low-confidence wallets |
| `--merge` | Merge exported wallets into Meridian |
| `--json` | Machine-readable output |
| `--once` | Watch mode: one scan then exit |

## Outputs

| File | Purpose |
|---|---|
| `data/last-scan.json` | Full scan result, including per-position detail |
| `data/state.json` | Wallet scores across watch cycles |
| `data/telegram-offset.json` | Telegram bot update offset (so commands are not replayed) |
| `data/check-<wallet>.json` | Single-wallet report |
| `exports/recommended.json` | Wrapper with metadata and criteria |
| `exports/recommended.snippet.json` | Plain array ready to copy |
| `exports/recommended.md` | Human-readable report |
| `exports/gmgn-follow.json` | Full GMGN batch-import array (`address`, `name`, `emoji`) |
| `exports/gmgn-new.json` | Only GMGN wallets never exported before |
| `data/gmgn-exported.json` | GMGN export ledger (stable names + first/last export time) |
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

`exports/gmgn-follow.json` uses GMGN's batch-import format instead:

```json
[
  {
    "address": "7Weigvc3E2kE42djnRFths1ReU62HYf8q1fRVHnexGkK",
    "name": "meteora-7Weigv",
    "emoji": "🔥"
  }
]
```

The name is address-based so it stays stable when the score changes. The emoji
follows the current tier: `S` 🔥, `A` ⭐, `B` 👀, `C` 🧐, `D` 💤. Names are always
unique inside the file.

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

## On-chain hygiene with Helius RPC

This check is optional. Without `hygiene.rpcUrl`, scans behave exactly as before:
no RPC calls, no new gates, no extra credits.

### Setup

1. Create a free key at [dashboard.helius.dev](https://dashboard.helius.dev).
2. Set the endpoint in `config.json`:

```json
{
  "hygiene": {
    "enabled": true,
    "rpcUrl": "https://mainnet.helius-rpc.com/?api-key=YOUR_KEY",
    "checkWalletAge": true,
    "minWalletAgeDays": 30,
    "maxDaysSinceSignature": 14,
    "minSolBalance": 0.02,
    "detectSharedFunder": true,
    "minSharedFunderWallets": 2,
    "ignoreFunders": [],
    "requireOnchainData": false,
    "cacheTtlMinutes": 1440,
    "maxSignaturePages": 3,
    "signaturePageSize": 1000
  }
}
```

Or use an environment variable:

```bash
export HELIUS_RPC_URL="https://mainnet.helius-rpc.com/?api-key=YOUR_KEY"
```

`config.json` is gitignored. The URL contains your API key, so never commit it.
`node finder.js config` masks it, and RPC errors are logged without the URL.

### What it checks

| Data | RPC method | Used for |
|---|---|---|
| SOL balance | `getBalance` | Warn on wallets too low on SOL for fees |
| Transaction history | `getSignaturesForAddress` | Wallet age, last activity, history depth |
| Earliest transaction | `getTransaction` | Funding source |
| Funder account | `getAccountInfo` | Distinguish a wallet from a program |

Results are cached for `hygiene.cacheTtlMinutes` (24 hours by default) so repeat
scans do not burn Helius credits.

### Gates and warnings

When `checkWalletAge` is on, a wallet must pass one more gate:

| Gate | Default | Config |
|---|---:|---|
| Wallet age | >= 30 days | `hygiene.minWalletAgeDays` |

Behavior:

- If history is capped by `maxSignaturePages`, age is a lower bound and the gate
  passes. The CLI shows `(at least)`.
- If age cannot be read at all, the gate passes unless
  `hygiene.requireOnchainData` is `true`.
- Shared-funder detection does not affect the score. It only adds a warning.

New warning flags:

| Flag | Meaning |
|---|---|
| `new_wallet` | Wallet is younger than `minWalletAgeDays` |
| `inactive_wallet` | No on-chain signature for `maxDaysSinceSignature` days |
| `low_sol` | SOL balance below `minSolBalance` |
| `shared_funder` | Another scanned candidate has the same funder |
| `no_onchain_history` | Wallet has no signatures at all |
| `wallet_age_uncertain` | History capped below the minimum age; true age is unknown |
| `hygiene_unknown` | RPC data unavailable for this wallet |

`shared_funder` is a heuristic. Exchanges and launchpads can fund many unrelated
wallets. Add known addresses to `hygiene.ignoreFunders` if they cause noise.

### Check one wallet

```bash
node finder.js hygiene <wallet>
node finder.js hygiene <wallet> --json
node finder.js hygiene <wallet> --refresh
```

Example output:

```
Wallet      : 7Weig...
Wallet age  : 142.3d
First seen  : 2026-06-07T...
Last seen   : 2026-10-26T... (1.2d ago)
SOL balance : 2.5
Signatures  : 1000 (1 page(s), partial)
Funder      : 28F7... (wallet)
```

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

## Importing into GMGN

Every `scan` or `export` writes two files:

| File | Contents |
|---|---|
| `exports/gmgn-follow.json` | Full list of selected wallets |
| `exports/gmgn-new.json` | Only wallets never exported before |

Both use the official GMGN batch-import shape: a JSON array of
`{ address, name, emoji }` objects, with no wrapper and no metadata.

### First import

1. Open <https://gmgn.ai/follow>.
2. Click **Batch import/export** in the top-right corner.
3. Paste the entire contents of `exports/gmgn-follow.json`.
4. Confirm the preview and import.

### Later scans

Use `exports/gmgn-new.json` instead. It contains only addresses that are not in
`data/gmgn-exported.json`, so you can paste a small diff instead of the whole list.

The exporter also reuses the name saved in the ledger. That keeps labels stable
even when a wallet's score or tier changes.

`gmgn-new.json` always reflects the latest run. If you skip a diff, import the full
`gmgn-follow.json` instead; GMGN will handle addresses that are already followed.

### Notes

- GMGN accepts at most **2,000 addresses per import**. The exporter caps the file
  at 2,000.
- The GMGN list is selected independently from Meridian. Configure
  `export.gmgn.minScore` and `export.gmgn.maxWallets`; Meridian keeps using
  `export.minScore` and `export.maxWallets`. Set `gmgn.minScore` to `null` to
  inherit `export.minScore`.
- `export.excludeExisting` only filters wallets already in Meridian. The GMGN files
  are independent, so a wallet already in Meridian can still appear there.
- Names and emojis are cosmetic labels for GMGN. They do not affect scoring.
- This project never uploads anything to GMGN. Importing is always manual.
- GMGN importing a wallet does **not** enable copy trading. You still choose which
  wallets to trade manually.

### Commands

```bash
# Re-generate all exports from the last scan
node finder.js export

# Re-generate only the GMGN files
node finder.js export --gmgn-only

# Preview counts without writing files or updating the ledger
node finder.js export --dry-run
```

To disable the GMGN files while keeping the Meridian exports:

```json
{
  "export": {
    "gmgn": { "enabled": false }
  }
}
```

To disable incremental diffs while keeping the full GMGN list:

```json
{
  "export": {
    "gmgn": { "incremental": false }
  }
}
```

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
    "excludeExisting": true,
    "gmgn": {
      "enabled": true,
      "minScore": null,          // null = inherit export.minScore
      "maxWallets": 2000,        // GMGN hard limit
      "namePrefix": "meteora",
      "fileName": "gmgn-follow.json",
      "incremental": true,
      "newFileName": "gmgn-new.json",
      "stateFile": "gmgn-exported.json"
    }
  },
  "hygiene": {
    "rpcUrl": "",                // empty = disabled
    "checkWalletAge": true,
    "minWalletAgeDays": 30,
    "maxDaysSinceSignature": 14,
    "minSolBalance": 0.02,
    "detectSharedFunder": true,
    "cacheTtlMinutes": 1440
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
| `TELEGRAM_ALLOWED_CHAT_IDS` | `telegram.allowedChatIds` (comma-separated) |
| `TELEGRAM_API_BASE` | `telegram.apiBase` |
| `HELIUS_RPC_URL` | `hygiene.rpcUrl` (Helius endpoint with API key) |
| `RPC_URL` | `hygiene.rpcUrl` fallback |

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
interval. It is independent of the existing `meridian` PM2 process. An optional
Telegram bot app is included as a commented block in the same file; uncomment it
after configuring `telegram.botToken` and `telegram.allowedChatIds`.

## Telegram control bot

You can start and stop scans from Telegram instead of SSH. The bot only listens
to chat IDs you whitelist, only understands a fixed command set, and never runs
arbitrary shell commands.

### 1. Create the bot

1. Open [@BotFather](https://t.me/BotFather) in Telegram.
2. Send `/newbot`, choose a name and a username.
3. Copy the token (looks like `123456789:AA...`).

### 2. Get your numeric chat ID

Message [@userinfobot](https://t.me/userinfobot) and copy your numeric `id`
(for example `123456789`). Groups have negative IDs.

### 3. Configure

Edit `config.json` (gitignored):

```json
{
  "telegram": {
    "botToken": "123456789:AA...",
    "chatId": "123456789",
    "allowedChatIds": ["123456789"],
    "apiBase": "https://api.telegram.org",
    "pollTimeoutSeconds": 30
  }
}
```

- `allowedChatIds` is the control allowlist. Messages from other chats are
  logged and ignored.
- If `allowedChatIds` is empty, it falls back to `chatId`.
- `chatId` is also the destination for watch-mode alerts.
- `config.json` is gitignored. Never commit the token. If it leaks, revoke it
  with `/revoke` in BotFather.

### 4. Start the bot

```bash
node finder.js bot
# or
npm run bot
```

Then send `/start` to your bot in Telegram.

### Commands

| Command | Action |
|---|---|
| `/scan` | Run a scan with default settings |
| `/scan --pools 5 --top 10` | Quick scan |
| `/scan --min-score 80 --refresh` | Stricter scan, ignore cache |
| `/stop` | Stop the running scan (SIGTERM, then SIGKILL after 10s) |
| `/status` | Show whether a scan is running and the last result |
| `/last` | Show top wallets from `data/last-scan.json` |
| `/export` | Send the latest GMGN file (`gmgn-new.json` if non-empty, else `gmgn-follow.json`) |
| `/export new` | Send only the new GMGN wallets |
| `/export full` | Send the full GMGN list |
| `/exporttxt` | Send smart wallets as a ranked `.txt` file (best first) |
| `/id` | Show the current chat ID |
| `/help` | Show command help |

Notes:

- Only one scan can run at a time.
- `/scan` runs in a child process, so stopping the bot or the scan is safe.
- Unknown flags are rejected. `--merge` is intentionally **not** available from
  Telegram; merging into Meridian stays a deliberate CLI action.
- Commands sent while the bot is offline are skipped on restart.
- The bot only controls scans. To stop the bot process itself, use PM2 or
  `Ctrl+C`.

### Send GMGN files from Telegram

`/export` uploads the file as a Telegram document, so you can import it on a
phone without SSH:

1. Run `/scan` and wait for it to finish.
2. Send `/export`.
3. Open the document in Telegram, copy its contents, and paste it into
   <https://gmgn.ai/follow> → **Batch import**.

`/export` picks `exports/gmgn-new.json` when it contains wallets, otherwise it
falls back to `exports/gmgn-follow.json`. Use `/export new` or `/export full` to
force one file. If no export exists yet, the bot asks you to run `/scan` first.

### Send smart wallets as text

`/exporttxt` builds `exports/smart-wallets.txt` from the last scan and sends it
as a document. The list uses the same selection as the Meridian export
(`export.minScore` and `export.maxWallets`) and is sorted by score, best first:

```text
# Meteora Smart Wallets
# Generated: 2026-10-28T02:50:00.000Z
# Source: data/last-scan.json
# Sorted by score, best first
# Criteria: score >= 75, max 10 wallets
# Count: 2

  #  Address                                       Score  Tier    Win%   Fee%   ROI%  Closed  Pools    Last
  -  --------------------------------------------  ------  ----  ------  -----  -----  ------  -----  ------
  1  B9U42uELGHcqvGvnqtJxYRGEsrJ7cBJV4MAXbNpSDJLU    88.3  S       70.3   20.6   17.0      37      3     now
  2  7Weigvc3E2kE42djnRFths1ReU62HYf8q1fRVHnexGkK    86.0  S       78.0    6.0   12.0      12      2      0d
```

The file is plain text, so it can be copied into notes or another tool. It is
read-only research, not financial advice.

### Run the bot under PM2

```bash
cd ~/meteora-smart-wallet-finder
pm2 start finder.js --name swf-bot -- bot
pm2 logs swf-bot
pm2 save
```

Avoid running `watch` mode and the Telegram bot at the same time: both can start
scans and write `data/last-scan.json`. Pick one control model:

- **Bot control:** start scans manually from Telegram.
- **Watch mode:** automatic scans every N minutes with alerts.

## API sources and limitations

| Source | Used for |
|---|---|
| `pool-discovery-api.datapi.meteora.ag/pools` | Pool discovery and 24h metrics |
| `api.agentmeridian.xyz/api/top-lp/<pool>` | Ranked LPers per pool |
| `api.agentmeridian.xyz/api/study-top-lp/<pool>` | Fallback when `/top-lp` fails |
| `dlmm.datapi.meteora.ag/portfolio/open?user=<wallet>` | Open positions |
| `dlmm.datapi.meteora.ag/positions/<pool>/pnl?user=<wallet>&status=closed` | Closed-position history |
| Helius RPC (`hygiene.rpcUrl`) | Wallet age, SOL balance, funding source, shared funders |

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
- Helius wallet age uses at most `hygiene.maxSignaturePages` pages of 1,000
  signatures. Very old wallets are reported as "at least X days"; the age gate
  still passes because the true age can only be older.
- Funding source comes from the earliest successful transaction. Exchange and
  launchpad hot wallets will look like shared funders, so treat `shared_funder`
  as a hint, not proof of common ownership.
- Helius calls consume RPC credits. Results are cached for 24 hours by default;
  lower `hygiene.cacheTtlMinutes` if you need fresher balances and activity.
- GMGN imports are limited to 2,000 addresses. The export file is generated
  locally; this project has no GMGN API integration, no automatic upload, and no
  copy-trading control. Deleting `data/gmgn-exported.json` makes every wallet look
  new again.
- Wallet history is not predictive. A wallet can change strategy or stop working
  at any time.

## Read-only guarantee

This project contains no wallet keys, no signing code, and no transaction
submission. It performs HTTP requests to the Meteora/Agent Meridian data APIs
and, when enabled, the Telegram Bot API and Helius RPC read-only methods
(`getBalance`, `getSignaturesForAddress`, `getTransaction`, `getAccountInfo`),
plus local file writes for caches, logs, state, and exports. The only write
outside its own directory is the opt-in `--merge` target, which always creates a
backup first. GMGN import is manual; there is no GMGN API client.

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
src/hygiene.js       Helius RPC wallet age, balance, funder, clustering
src/metrics.js       closed-position metrics and flags
src/score.js         gates, weighted score, tiers
src/output.js        tables, exports (Meridian + GMGN), Meridian merge
src/state.js         watch-mode state
src/telegram.js      Telegram API client and alert formatting
src/bot.js           Telegram control bot (/scan, /stop, /status)
test/                node:test unit tests
```

## Disclaimer

This is research software, not financial advice. Smart-wallet history does not
guarantee future performance. Always verify a wallet manually before adding it to
Meridian or allocating capital.
