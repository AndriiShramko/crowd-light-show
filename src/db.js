import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(path.join(config.dataDir, 'uploads'), { recursive: true });
fs.mkdirSync(path.join(config.dataDir, 'timelines'), { recursive: true });

export const db = new Database(path.join(config.dataDir, 'app.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS show (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',     -- draft | live | ended
  join_code TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'blob',         -- blob | zones | seatmap
  active_track_id INTEGER,
  nudge_ms INTEGER NOT NULL DEFAULT 0,
  seatmap_id INTEGER,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER
);

CREATE TABLE IF NOT EXISTS track (
  id INTEGER PRIMARY KEY,
  show_id INTEGER NOT NULL REFERENCES show(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'upload', -- upload | youtube(deferred)
  file_path TEXT,
  youtube_id TEXT,
  duration_ms INTEGER,
  bytes INTEGER,
  position INTEGER NOT NULL DEFAULT 0,
  analysis_status TEXT NOT NULL DEFAULT 'pending', -- pending | done | failed | unsupported
  timeline_path TEXT,
  cue_count INTEGER,
  license_attested INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- Devices/seatmaps: schema present from day one so the per-seat "draw with light"
-- roadmap (P3) is a feature-unlock, not a migration. Unused in the MVP (blob mode).
CREATE TABLE IF NOT EXISTS seatmap (
  id INTEGER PRIMARY KEY,
  show_id INTEGER NOT NULL REFERENCES show(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS seat (
  id INTEGER PRIMARY KEY,
  seatmap_id INTEGER NOT NULL REFERENCES seatmap(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  label TEXT,
  grid_x INTEGER,
  grid_y INTEGER,
  zone TEXT
);

-- Lead capture from the marketing landing (stored for the admin list; also DM'd
-- to the owner via Telegram if configured).
CREATE TABLE IF NOT EXISTS application (
  id INTEGER PRIMARY KEY,
  name TEXT,
  contact TEXT,
  event_type TEXT,
  message TEXT,
  ip TEXT,
  notified INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_track_show ON track(show_id);
CREATE INDEX IF NOT EXISTS idx_seat_map ON seat(seatmap_id);
CREATE INDEX IF NOT EXISTS idx_app_created ON application(created_at DESC);
`);

// Round 8C — idempotent migration. CREATE TABLE IF NOT EXISTS does NOT add columns to an
// already-existing (populated, live) table, so add the new lead fields one-by-one, each
// wrapped so a re-run on a DB that already has the column is a silent no-op.
for (const col of ['email TEXT', 'phone TEXT', 'company TEXT', 'source TEXT', 'tier TEXT']) {
  try { db.exec(`ALTER TABLE application ADD COLUMN ${col}`); } catch { /* column already exists */ }
}

// Round 9 — public operator console. Same idempotent ALTER pattern on the live populated DB.
// is_public = a track Andrii curated into the PUBLIC playlist (the /studio console may arm it,
// zero-friction, no consent tick — Andrii already attested the licence). Default 0 = private.
for (const col of ['is_public INTEGER NOT NULL DEFAULT 0']) {
  try { db.exec(`ALTER TABLE track ADD COLUMN ${col}`); } catch { /* column already exists */ }
}
// public_config singleton (id=1): the defaults the PUBLIC console starts from. Andrii edits it
// from his OWN authed console; the public side reads it read-only and RE-validates on read.
db.exec(`
CREATE TABLE IF NOT EXISTS public_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  default_track_id INTEGER,
  default_screen_preset TEXT,
  default_screen_params TEXT,            -- JSON
  default_torch_preset TEXT,
  default_torch_params TEXT,             -- JSON
  welcome_text TEXT,
  brand_name TEXT NOT NULL DEFAULT 'Crowd Light Show',
  allow_upload INTEGER NOT NULL DEFAULT 0,
  allow_torch INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER
);
`);
// Round 10: seed REACTIVE public defaults so /studio opens with the screen + flash already
// reacting to the music (pulse with audioDepth 0.6, beat torch). validatePreset/validateTorchPreset
// re-fill the rest of the params + clamp on read, so a sparse seed normalizes to a full safe set.
db.prepare(`INSERT OR IGNORE INTO public_config (id, brand_name, allow_torch, default_screen_preset, default_screen_params, default_torch_preset, default_torch_params, updated_at)
  VALUES (1, 'Crowd Light Show', 1, 'pulse', '{"audioDepth":0.6}', 'beat', '{}', ?)`).run(Date.now());
// On an ALREADY-seeded (live) DB the INSERT OR IGNORE no-ops, so fill the reactive defaults only
// where they are still NULL (never overwrite a default Andrii has set from his console).
db.prepare(`UPDATE public_config SET
  default_screen_preset = COALESCE(default_screen_preset, 'pulse'),
  default_screen_params = COALESCE(default_screen_params, '{"audioDepth":0.6}'),
  default_torch_preset  = COALESCE(default_torch_preset,  'beat'),
  default_torch_params  = COALESCE(default_torch_params,  '{}')
  WHERE id = 1`).run();

export function now() { return Date.now(); }

// Round 9 — public console helpers.
export function getPublicConfig() { return db.prepare('SELECT * FROM public_config WHERE id = 1').get(); }
// Curated public playlist: is_public AND fully analyzed (a timeline exists to broadcast).
export function listPublicTracks() {
  return db.prepare(`SELECT id, title, duration_ms, cue_count FROM track WHERE is_public = 1 AND analysis_status = 'done' AND timeline_path IS NOT NULL ORDER BY position, id`).all();
}

export function getOrCreateDefaultShow() {
  let show = db.prepare(`SELECT * FROM show WHERE status != 'ended' ORDER BY id DESC LIMIT 1`).get();
  if (!show) {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const info = db.prepare(
      `INSERT INTO show (name, status, join_code, mode, created_at) VALUES (?, 'draft', ?, 'blob', ?)`
    ).run('Light Show', code, now());
    show = db.prepare(`SELECT * FROM show WHERE id = ?`).get(info.lastInsertRowid);
  }
  return show;
}

export function listTracks(showId) {
  return db.prepare(`SELECT * FROM track WHERE show_id = ? ORDER BY position, id`).all(showId);
}

export function uploadsUsage() {
  const row = db.prepare(`SELECT COALESCE(SUM(bytes),0) AS total FROM track`).get();
  return row.total || 0;
}
