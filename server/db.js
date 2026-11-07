import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const METALS = ['gold', 'silver', 'platinum', 'palladium'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT    NOT NULL,
  category        TEXT    NOT NULL CHECK (category IN ('bullion', 'collectible')),
  metal           TEXT    NOT NULL DEFAULT 'none'
                  CHECK (metal IN ('gold', 'silver', 'platinum', 'palladium', 'none')),
  weight_ozt      REAL    NOT NULL DEFAULT 0,   -- gross weight of ONE unit, troy ounces
  purity          REAL    NOT NULL DEFAULT 0,   -- fineness, 0..1 (e.g. 0.999)
  quantity        INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  year            TEXT,
  mint_mark       TEXT,
  grade           TEXT,
  grading_service TEXT,
  cert_number     TEXT,
  purchase_price  REAL    NOT NULL CHECK (purchase_price >= 0), -- total paid for all units
  purchase_date   TEXT    NOT NULL,             -- YYYY-MM-DD
  premium_pct     REAL    NOT NULL DEFAULT 0,   -- bullion: valuation adjustment over melt
  notes           TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Market values you record for collectibles (e.g. recent sold listings,
-- auction results, PCGS/NGC price guide). Stored per unit.
CREATE TABLE IF NOT EXISTS market_values (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id        INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  value_per_unit REAL    NOT NULL CHECK (value_per_unit >= 0),
  recorded_on    TEXT    NOT NULL,              -- YYYY-MM-DD the sale/quote happened
  source         TEXT,
  note           TEXT,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_market_values_item ON market_values(item_id, recorded_on);

-- Every spot price observation (API pulls and manual entries).
CREATE TABLE IF NOT EXISTS spot_prices (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  metal      TEXT NOT NULL,
  price      REAL NOT NULL,                     -- per troy ounce
  currency   TEXT NOT NULL,
  source     TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_spot_metal_time ON spot_prices(metal, fetched_at);

-- One row per item per day: the item's value as of the last snapshot that day.
CREATE TABLE IF NOT EXISTS item_value_history (
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  day     TEXT    NOT NULL,
  value   REAL    NOT NULL,
  cost    REAL    NOT NULL,
  PRIMARY KEY (item_id, day)
);

CREATE TABLE IF NOT EXISTS portfolio_history (
  day         TEXT PRIMARY KEY,
  total_value REAL NOT NULL,
  total_cost  REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

export function getMeta(db, key) {
  return db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
}

export function setMeta(db, key, value) {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value == null ? null : String(value));
}

/** Run fn inside a transaction; rolls back if it throws. */
export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
