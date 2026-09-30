# Migrating from Harvest

Optional: the setup wizard can also start an empty workspace. Both import paths only read from
Harvest and can be repeated.

## CSV export

No API token needed.

1. In Harvest, export a detailed time report as CSV (and the invoice report, if wanted).
2. Upload it in the setup wizard, or run `npm run import:csv -- time.csv invoices.csv`.
3. Check the imported people, projects and totals, then claim your account and set a password.

CSV exports lack stable IDs, rates, budgets and archived state. On a CSV-built instance, the
Import page can read those settings from Harvest afterwards. People without an email get an
`@invalid.local` placeholder. Ambiguous dates are rejected, not guessed. Receipts are skipped.

## API

The most complete import, and the only one that can sync later.

1. Create a personal access token at <https://id.getharvest.com/developers>.
2. Enter the account ID, token and a contact email in the setup wizard, or set them in `.env`
   and run `npm run import:api`.
3. Untick "Remember the token" for a one-off import; leave it ticked to sync later.
4. Revoke the token once you no longer sync.

The token can read everything its owner can. Treat it as a password.

## Scripts written for Harvest

A read-only API at `/v2` answers like Harvest's API v2 for the company, people, clients, projects,
tasks and time entries: the same paths, record shapes, paging and filters. Point a script at
`https://<your instance>/v2` instead of `https://api.harvestapp.com/v2`, with a token created on
this instance's Tokens page. Ids are this instance's own.

## Cutover

- Agree on a final cutoff, then run the last import or sync.
- Compare total hours per year and for the last month with Harvest.
- Check everyone's role, and test exports and one backup restore.
- Revoke the Harvest token.
