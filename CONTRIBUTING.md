# Contributing

Contributions are welcome. By taking part you agree to the [code of conduct](CODE_OF_CONDUCT.md),
and to license your contribution under AGPL-3.0-or-later.

Open an issue first for changes to behavior or the database schema.

## Before you open a pull request

```sh
npm run build && npm test && npm run check && npm run test:smoke
```

Build first: the HTTP tests drive the built server and skip themselves without `dist/`.
`npm run test:docker` runs the smoke test against the Docker image, and `npm run test:e2e` runs
the browser tests (once: `npx playwright install chromium webkit`).

## Rules

- No real data: no exports, databases, credentials, names, emails, receipts or invoices, in
  code, tests or commit messages. Fixtures are synthetic.
- Harvest connectors only read.
- Durations are integer seconds and money is integer minor units. Imports are transactional.
- A schema change is a new forward-only migration, and an older build must still boot
  against the new database.
