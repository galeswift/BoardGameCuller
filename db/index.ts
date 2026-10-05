import { Pool } from "pg";

// Tables are created on first use so a fresh Railway Postgres needs no manual migration step.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS collection_state (
  owner text PRIMARY KEY,
  settings jsonb NOT NULL DEFAULT '{}',
  games jsonb,
  updated text NOT NULL
);
CREATE TABLE IF NOT EXISTS preferences (
  owner text NOT NULL,
  game_id text NOT NULL,
  data jsonb NOT NULL,
  updated text NOT NULL,
  PRIMARY KEY (owner, game_id)
);`;

// Survive Next dev hot reloads without opening a new pool each time.
const cache = globalThis as unknown as { pgPool?: Pool; pgReady?: Promise<unknown> };

export async function getDb(): Promise<Pool> {
  if (!process.env.DATABASE_URL) throw new Error("Preference storage is unavailable.");
  const pool = (cache.pgPool ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 5 }));
  cache.pgReady ??= pool.query(SCHEMA).catch((e) => {
    cache.pgReady = undefined;
    throw e;
  });
  await cache.pgReady;
  return pool;
}
