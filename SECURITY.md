# Security Policy

## Read-only by design

This project does not contain private keys, signing code, or transaction
submission. It performs HTTP requests to the Meteora/Agent Meridian data APIs
and, when enabled, the Telegram Bot API and the Helius RPC read-only methods
(`getBalance`, `getSignaturesForAddress`, `getTransaction`, `getAccountInfo`),
and writes local files for cache, logs, state, and exports. GMGN support only
writes `exports/gmgn-follow.json`, `exports/gmgn-new.json`, and the local ledger
`data/gmgn-exported.json`; it has no GMGN API client and never uploads or imports
anything automatically.

The Telegram control bot is restricted to an explicit allowlist of chat IDs and
a fixed command set. It never executes arbitrary shell commands.

The Helius RPC URL contains an API key. It is stored only in `config.json`
(gitignored) or an environment variable, masked by `node finder.js config`, and
redacted from RPC error messages.

The only write outside this project's directory is the opt-in
`export --merge` target, which always creates a timestamped backup first.

## Never commit secrets

Do not commit:

- `config.json`
- `.env` or `.env.*`
- `data/`
- `exports/`
- Telegram bot tokens
- RPC URLs containing API keys
- Agent Meridian API keys
- Meridian's `smart-wallets.json`

The included `.gitignore` covers these paths. If a secret is committed
accidentally, rotate it immediately and remove it from git history.

## Reporting a vulnerability

Please do not open a public issue for security problems. Contact the repository
maintainer privately with:

- a description of the issue
- steps to reproduce
- affected version or commit
- potential impact

## Supported versions

Security fixes are applied to the latest version on the `main` branch.
