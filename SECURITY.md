# Security policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Report it privately through GitHub's security advisories, at https://github.com/whitespace-se/no-bs-time-tracking/security/advisories/new.

Include affected versions, reproduction steps, impact, and any suggested mitigation. Do not access data that is not yours and do not run availability-impacting tests against public instances.

## Deployment expectations

- Put the application behind HTTPS and a maintained reverse proxy, and set `APP_URL` to the
  public address. Without it the cross-site check and the `Secure` cookie flag both work from
  the wrong origin, and no form post succeeds.
- Give each instance its own Unix user or container, directory, port, and `SECRET_KEY`.
- Do not expose an instance directory or SQLite file through a web server.
- Protect and rotate Harvest tokens; revoke them after migration if synchronization is no longer needed.
- Back up the whole instance directory and periodically test restoration.
- Run supported Node.js and dependency versions.

The downloadable database snapshot deliberately excludes everything that authenticates against a live instance: encrypted source credentials, the database-resident key, active sessions, and API tokens. A restored copy therefore asks for the Harvest token again and everyone signs in again.

It still contains personal and commercial data, including password hashes, and must be protected accordingly.
