-- 008_api_tokens — personal access tokens, so other systems can read this instance.
--
-- A token belongs to a person and carries exactly their permissions. That is deliberate: a
-- second permission model beside `users.role` would be a second place to get authorisation
-- wrong, and the first one already decides who may see rates and other people's time.
--
-- Only the hash is stored, so a leaked database yields no working token. The hash is a plain
-- SHA-256 rather than scrypt, which is the right call *here* and nowhere else in this app: a
-- token is 32 random bytes we generated, so there is no guessing to slow down, and a slow KDF
-- on every API request would be a self-inflicted denial of service. Passwords are human and
-- keep their scrypt (see auth/password.ts).
--
-- `prefix` is the visible half — the first characters of the token — so a person can tell
-- which row is the token in their CI config without the row containing the secret.

CREATE TABLE api_tokens (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  name         TEXT    NOT NULL,
  token_hash   TEXT    NOT NULL UNIQUE,
  prefix       TEXT    NOT NULL,
  created_at   TEXT    NOT NULL,
  last_used_at TEXT,
  expires_at   TEXT,
  revoked_at   TEXT
) STRICT;
CREATE INDEX idx_api_tokens_user ON api_tokens(user_id, revoked_at);
CREATE INDEX idx_api_tokens_hash ON api_tokens(token_hash);
