# ![No BS Time Tracking](docs/social-preview.png)

**A stepping stone, not another big decision.**

When the tool you track time in gets expensive, the usual choices are to pay up or to rush into a
replacement that brings its own headaches. This is a third option: simple time tracking your
company runs itself, with no license fees. Bring your history over, keep your team tracking time
the same day, and decide what comes next when you are ready.

> [!TIP]
> **Harvest season is over.** Get self-hosted time tracking with your full history: your whole
> account comes over in one import, and Harvest stays as it is until you decide to switch.
> [How the move works](docs/migrating-from-harvest.md).

No BS as in no bullshit: time tracking and nothing else.

## What your team gets

- Timesheets and timers, projects, clients, team and reports.
- CSV and PDF exports for payroll and invoicing.
- Your imported history, including past invoices, estimates and expenses, kept for reference.

It does not send invoices: you invoice from your accounting system using the exports. There is no
single sign-on, two-factor login or password reset by email.

## Why it is low risk

- **Nothing changes until you are ready.** Imports only read from your current tool, so you can
  run both side by side.
- **Your data stays yours.** It lives in one file on your own server and exports to CSV at any
  time.
- **It is open source.** Anyone can run, fix or extend it, and it stays available.
- **A backup is one folder.** Copy it and you have everything.

## Get started

Whoever handles your IT runs this on a machine with Docker:

```sh
git clone https://github.com/whitespace-se/no-bs-time-tracking.git
cd no-bs-time-tracking
docker compose up -d
```

Then open it in a browser and follow the setup wizard, to import your history or start empty.
Everything else, from your own domain to backups and upgrades, is in
[docs/running.md](docs/running.md).

## Made by Whitespace

Built by [Johan De Geer](https://github.com/degeer) at [Whitespace](https://whitespace.se), a SaaS
company and creative studio in one, based in Malmö, Stockholm and Dubai. We run cloud products for
web analytics, digital identity, publishing and crisis communication (Whitespace Analys, Whitespace
ID, Municipio Cloud and Kriswebb), and design and build websites for companies, unions,
municipalities and government agencies.

We built this to move off our own time tracker, and used it as the stepping stone to rework how we
report time and invoice. If you want a hand doing the same,
[get in touch](https://whitespace.se/om-whitespace/kontakt/).

## License

AGPL-3.0-or-later, see [LICENSE](LICENSE). Not affiliated with Harvest, whose name is a trademark
of its owner.
