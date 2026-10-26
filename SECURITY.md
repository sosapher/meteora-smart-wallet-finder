# Security Policy

## Read-only by design

This project does not contain private keys, signing code, or transaction
submission. It only performs HTTP GET requests and writes local files for cache,
logs, state, and exports.

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
