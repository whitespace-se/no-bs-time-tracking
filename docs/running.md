# Running it

## Run with Docker

```sh
git clone https://github.com/whitespace-se/no-bs-time-tracking.git
cd no-bs-time-tracking
docker compose up -d
```

Open <http://localhost:4321> and follow the setup wizard. Data is kept in the `nbst-data`
volume. Set `NBST_PORT` to use another port.

## Run with Node.js

Requires Node.js 24 or later.

```sh
npm ci
npm run build
npm start
```

Data is kept in `instances/default`. Set `INSTANCE_DIR` and `PORT` to run another instance
beside it.

## Configure

Nothing is required on a single machine. Behind a reverse proxy, set `APP_URL` to the public
address (for example `https://track.example.com`), or every form post, including login, is
refused. All settings are listed in [.env.example](../.env.example).

`npm run admin` creates or promotes an administrator from the terminal.

## Status

Version 0.1.0. Upgrades move your data forward automatically at startup; back up the instance
folder first. The API may still change before 1.0.0.

## Develop

`npm run dev` starts a dev server. Tests and rules are in [CONTRIBUTING.md](../CONTRIBUTING.md), the
layout in [architecture.md](architecture.md).
