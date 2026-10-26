ALTER TABLE price_history ADD COLUMN source TEXT NOT NULL DEFAULT 'market' CHECK (source IN ('market','simulation'));
ALTER TABLE trades ADD COLUMN source TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('user','simulation'));
CREATE TABLE market_simulation (
 market_id TEXT PRIMARY KEY NOT NULL REFERENCES markets(id),
 user_id TEXT NOT NULL REFERENCES users(id),
 epoch_ms INTEGER NOT NULL,
 anchor_probability REAL NOT NULL,
 last_tick_ms INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE scenario_history (
 market_id TEXT NOT NULL REFERENCES markets(id),
 created_at INTEGER NOT NULL,
 probability REAL NOT NULL CHECK (probability > 0 AND probability < 1),
 PRIMARY KEY (market_id,created_at)
);
