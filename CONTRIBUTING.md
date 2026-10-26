# Contributing

Thanks for taking a look. This project is intentionally small and dependency-free.

## Development

```bash
git clone https://github.com/sosapher/meteora-smart-wallet-finder.git
cd meteora-smart-wallet-finder
npm run setup
npm test
```

Requirements:

- Node.js 18 or newer
- No runtime npm dependencies

## Guidelines

- Keep the bot read-only: no private keys, signing, or transactions.
- Do not add the ability to write to Meridian by default. Merging must stay
  opt-in and must create a backup.
- Prefer Node built-ins over new dependencies.
- Keep secrets and local data out of git (`config.json`, `.env`, `data/`,
  `exports/`).
- Add or update tests for behavior changes under `test/`.
- Keep API calls rate-limited and retryable; upstream APIs are flaky.

## Before opening a pull request

```bash
npm test
node --check finder.js
```

Include a short description, the motivation, and any behavior changes. If you
change scoring or gates, include a sample scan result or explain the expected
effect.
