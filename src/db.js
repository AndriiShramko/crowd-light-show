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

export function now() { return Date.now(); }

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
