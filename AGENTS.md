# Agent guide

Self-hosted time tracker: Astro server app, TypeScript, one SQLite database per instance, Node.js
24 or later. See [docs/architecture.md](docs/architecture.md) for the layout and storage rules.

## Commands

```sh
npm ci
npm run build        # required before npm test: HTTP tests drive dist/
npm test             # node --test over test/**/*.test.ts
npm run check        # tsc --noEmit
npm run test:smoke   # starts dist/ on an empty instance, expects the setup wizard
npm run test:docker  # same, through docker compose
npm run test:e2e     # Playwright, test/browser/*.spec.ts
npm run dev          # dev server on instances/default
```

Run build, test, check and test:smoke before calling a change done.

## Rules

- Never add real data: exports, databases, credentials, customer or person names, emails,
  figures from a real account. Not in code, tests, comments or commit messages.
- Durations are integer seconds, money is integer minor units, dates are `YYYY-MM-DD` text.
- Schema changes are new files in `src/lib/db/migrations/`. Never edit an existing migration.
- Harvest code only reads from Harvest.
- Settings live in the database or env vars (see `.env.example`), not in literals.
- Tests import `.ts` directly (`--experimental-strip-types`); keep type-only imports as
  `import type`.
- Keep documentation short and correct. Update README, `.env.example` or `docs/` in the same
  change as the behavior it describes.
