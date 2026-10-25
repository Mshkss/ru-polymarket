CREATE TABLE auth_accounts (
 user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id),
 email TEXT NOT NULL UNIQUE,
 password_hash TEXT NOT NULL,
 role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
 created_at INTEGER NOT NULL
);
CREATE TABLE sessions (
 token_hash TEXT PRIMARY KEY NOT NULL,
 user_id TEXT NOT NULL REFERENCES auth_accounts(user_id) ON DELETE CASCADE,
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user_id ON sessions(user_id);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE auth_attempts (
 scope TEXT PRIMARY KEY NOT NULL,
 count INTEGER NOT NULL,
 expires_at INTEGER NOT NULL
);
