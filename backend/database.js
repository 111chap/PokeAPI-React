import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function openDatabase(filename = resolve('data/pokemon.db')) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL, password TEXT NOT NULL,
      chosen_pokemon_id INTEGER, trophies INTEGER NOT NULL DEFAULT 0 CHECK(trophies >= 0),
      coins INTEGER NOT NULL DEFAULT 100 CHECK(coins >= 0), created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS user_pokemon (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id),
      pokemon_id INTEGER NOT NULL, pokemon_name TEXT NOT NULL, pokemon_data TEXT NOT NULL,
      is_starter INTEGER NOT NULL DEFAULT 0, level INTEGER NOT NULL DEFAULT 5,
      experience INTEGER NOT NULL DEFAULT 0, obtained_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_starter ON user_pokemon(user_id) WHERE is_starter = 1;
    CREATE TABLE IF NOT EXISTS user_battles (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id),
      opponent_pokemon_data TEXT NOT NULL, result TEXT NOT NULL,
      trophies_earned INTEGER NOT NULL, coins_earned INTEGER NOT NULL, battle_date TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS starter_draws (
      user_id INTEGER PRIMARY KEY REFERENCES users(id), pokemon_id INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS battles (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
      user_pokemon TEXT NOT NULL, opponent TEXT NOT NULL, turns INTEGER NOT NULL DEFAULT 0,
      damage_taken INTEGER NOT NULL DEFAULT 0, damage_dealt INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS user_battle_lookup ON battles(user_id, state);
  `);
  return {
    get: (sql, ...args) => db.prepare(sql).get(...args),
    all: (sql, ...args) => db.prepare(sql).all(...args),
    run: (sql, ...args) => db.prepare(sql).run(...args),
    transaction(fn) {
      db.exec('BEGIN IMMEDIATE');
      try { const result = fn(); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    close: () => db.close(),
  };
}
