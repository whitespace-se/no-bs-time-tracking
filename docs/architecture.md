# Architecture

An Astro server app (`@astrojs/node`) over one SQLite database, with no other services.

## One process, one instance

An instance is the directory named by `INSTANCE_DIR`: its database, an optional `.env` and
its log. One process serves one instance. To run another organization, start another process
with another directory and port, and isolate them with ordinary OS tools: containers, users,
file permissions.

## Storage rules

- Dates are `YYYY-MM-DD` text, never converted through a timezone.
- Durations are integer seconds. Money is integer minor units plus a currency.
- Migrations (`src/lib/db/migrations/`) are forward-only and run at startup.
- Imports run in one transaction and keep the source JSON or CSV row.
- Currency, week start and number format are instance settings, never literals.
- Imported records keep their Harvest IDs; records created here are numbered above the
  imported range.

## Layout

| Path                   | Holds                                                   |
| ---------------------- | ------------------------------------------------------- |
| `src/pages/`           | Pages and HTTP endpoints                                |
| `src/actions/`         | Form actions                                            |
| `src/middleware.ts`    | Sessions, setup redirect, cross-site check              |
| `src/lib/db/`          | Database, migrations, unit conversion                   |
| `src/lib/timesheet/`   | Timesheet and reporting queries                         |
| `src/lib/harvest/`     | Read-only Harvest API client and import                 |
| `src/lib/import/`      | CSV import                                              |
| `src/lib/api/`         | This app's own read-only API                            |
| `src/lib/harvest-api/` | Harvest-compatible API served at `/v2`                  |
| `scripts/`             | CLI imports, admin tool, smoke test                     |
| `test/`                | Unit and HTTP tests (`*.test.ts`); `test/browser/` Playwright |

## Backups

The database download uses SQLite's snapshot and leaves out stored credentials, the
database-resident key, sessions and API tokens. To restore, put the `.db` file in an empty
instance directory and start the app. A directory with several `.db` files and none named
`timetrack.db` fails at startup instead of guessing.
