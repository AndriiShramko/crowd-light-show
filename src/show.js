import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { db } from './db.js';

// Master clock: a single monotonic source. Every client syncs its offset to this,
// and T0 (show start) is always expressed in these milliseconds.
export function serverClock() { return performance.now(); }

const OPEN = 1; // ws.OPEN
export const MAIN_ROOM = 'main';

// Sticky index allocator: hands each phone a stable 0-based index so spatial presets
// (and, later, the pixel wall) can place it in the crowd. Indices are STICKY — a
// surviving phone is never renumbered when others join/leave (red-team P0) — and a
// freed index is reused by the next joiner (monotonic fill, tolerates sparse sets).
class IndexAllocator {
  constructor() { this.used = new Set(); this.byWs = new Map(); }
  alloc(ws) {
    if (this.byWs.has(ws)) return this.byWs.get(ws);
    let i = 0; while (this.used.has(i)) i++;
    this.used.add(i); this.byWs.set(ws, i); return i;
  }
  free(ws) { const i = this.byWs.get(ws); if (i != null) { this.used.delete(i); this.byWs.delete(ws); } }
  indexOf(ws) { return this.byWs.get(ws); }
  total() { let m = -1; for (const i of this.used) if (i > m) m = i; return m + 1; } // grid width
}

export class ShowHub {
  constructor() {
    this.audience = new Set();   // { ws } MAIN-room audience sockets
    this.operators = new Set();  // authed operator sockets
    this.timelineCache = new Map(); // trackId -> parsed timeline
    this.alloc = new IndexAllocator();          // main-room index allocator
    this.preset = null;          // main-room live preset {type,params,epoch,startedAt} | null
    this._endTimer = null;       // auto-stop timer: ends the show when the track finishes
    this._indexDirty = new Set(); // rooms whose phones need a fresh index broadcast (coalesced)
    this._indexTimer = null;
    this.rooms = new Map();       // ephemeral demo rooms: id -> {members:Set, preset, alloc}
    this.state = {
      epoch: 0,
      status: 'idle',     // idle | running | paused | blackout
      trackId: null,      // armed track (timeline distributed)
      T0: null,           // server-clock ms of show position 0
      pausePos: 0,
    };
  }

  loadTimeline(trackId) {
    if (this.timelineCache.has(trackId)) return this.timelineCache.get(trackId);
    const track = db.prepare('SELECT * FROM track WHERE id = ?').get(trackId);
    if (!track || !track.timeline_path || !fs.existsSync(track.timeline_path)) return null;
    const data = JSON.parse(fs.readFileSync(track.timeline_path, 'utf8'));
    this.timelineCache.set(trackId, data);
    return data;
  }

  send(ws, obj) { this.sendStr(ws, JSON.stringify(obj)); }
  // Backpressure guard (M7): a stalled cellular phone that can't drain its socket
  // must not accumulate unbounded buffered frames in the process — drop instead (the
  // show runs locally off the timeline/preset it already has, so a missed frame is
  // harmless). Protects the 512 MB container at stadium scale.
  sendStr(ws, str) {
    try { if (ws.readyState === OPEN && ws.bufferedAmount < 1000000) ws.send(str); } catch { /* drop */ }
  }
  // Serialize ONCE per broadcast and reuse the string for every socket (M1) — at
  // thousands of phones this turns an N×JSON.stringify allocation bomb (which would
  // OOM-kill the container on a timeline broadcast) into a single serialization.
  broadcastAudience(obj) { const s = JSON.stringify(obj); for (const ws of this.audience) this.sendStr(ws, s); }
  broadcastOperators(obj) { const s = JSON.stringify(obj); for (const ws of this.operators) this.sendStr(ws, s); }

  // ---- rooms (main + ephemeral guest demo rooms) ----
  getRoom(roomId, create) {
    if (!roomId || roomId === MAIN_ROOM) return null; // main is special (this.audience)
    let r = this.rooms.get(roomId);
    if (!r && create) { r = { members: new Set(), preset: null, alloc: new IndexAllocator(), createdAt: serverClock() }; this.rooms.set(roomId, r); }
    return r || null;
  }

  // Reap orphan demo rooms (a preset set but no phones ever joined / all left).
  sweepRooms(ttlMs = 60000) {
    const cutoff = serverClock() - ttlMs;
    for (const [id, r] of this.rooms) if (r.members.size === 0 && (r.createdAt || 0) < cutoff) this.rooms.delete(id);
  }

  // Send every member of a room its OWN sticky index + the current grid width N.
  broadcastIndices(members, alloc) {
    const total = alloc.total();
    for (const ws of members) this.sendStr(ws, JSON.stringify({ t: 'index', index: alloc.indexOf(ws), total }));
  }
  // Coalesce index broadcasts (M2): a join/leave only marks the room dirty; a single
  // debounced flush re-indexes it. Avoids the O(N²) message storm during a join herd
  // (each of N arrivals would otherwise broadcast to all N phones).
  markIndexDirty(roomId) {
    this._indexDirty.add(roomId || MAIN_ROOM);
    if (this._indexTimer) return;
    this._indexTimer = setTimeout(() => {
      this._indexTimer = null;
      const dirty = this._indexDirty; this._indexDirty = new Set();
      for (const id of dirty) {
        if (id === MAIN_ROOM) this.broadcastIndices(this.audience, this.alloc);
        else { const r = this.rooms.get(id); if (r) this.broadcastIndices(r.members, r.alloc); }
      }
    }, 200);
    if (this._indexTimer.unref) this._indexTimer.unref();
  }

  addAudience(ws, roomId) {
    roomId = roomId || MAIN_ROOM;
    ws.room = roomId;
    if (roomId === MAIN_ROOM) {
      this.audience.add(ws);
      this.alloc.alloc(ws);
      // Late/joining client: hand it the full picture so it can run offline & in-sync.
      this.send(ws, { t: 'welcome', state: this.publicState(), serverTime: serverClock() });
      if (this.preset) this.send(ws, { t: 'preset', ...this.preset });
      if (this.state.trackId != null) {
        const tl = this.loadTimeline(this.state.trackId);
        if (tl) this.send(ws, { t: 'timeline', trackId: this.state.trackId, data: tl });
      }
      this.send(ws, { t: 'index', index: this.alloc.indexOf(ws), total: this.alloc.total() }); // joiner gets its index now
      this.markIndexDirty(MAIN_ROOM);   // others refresh total on the coalesced flush
      this.broadcastCount();
    } else {
      const r = this.getRoom(roomId, true);
      r.members.add(ws); r.alloc.alloc(ws);
      this.send(ws, { t: 'welcome', state: { status: 'demo' }, serverTime: serverClock() });
      if (r.preset) this.send(ws, { t: 'preset', ...r.preset });
      this.send(ws, { t: 'index', index: r.alloc.indexOf(ws), total: r.alloc.total() });
      this.markIndexDirty(roomId);
    }
  }

  removeAudience(ws) {
    const roomId = ws.room || MAIN_ROOM;
    if (roomId === MAIN_ROOM) {
      this.audience.delete(ws); this.alloc.free(ws);
      this.markIndexDirty(MAIN_ROOM);
      this.broadcastCount();
    } else {
      const r = this.rooms.get(roomId);
      if (r) {
        r.members.delete(ws); r.alloc.free(ws);
        if (r.members.size === 0) this.rooms.delete(roomId); // ephemeral: clean up empty rooms
        else this.markIndexDirty(roomId);
      }
    }
  }

  // ---- live parametric presets (studio channel) ----
  // `valid` must already have passed validatePreset (server-authoritative safety).
  setPreset(roomId, valid) {
    const startedAt = serverClock();
    if (!roomId || roomId === MAIN_ROOM) {
      const epoch = (this.preset ? this.preset.epoch : 0) + 1;
      this.preset = { type: valid.type, params: valid.params, epoch, startedAt };
      this.broadcastAudience({ t: 'preset', ...this.preset });
      this.broadcastState();
      return { ok: true, epoch };
    }
    const r = this.getRoom(roomId, true);
    const epoch = (r.preset ? r.preset.epoch : 0) + 1;
    r.preset = { type: valid.type, params: valid.params, epoch, startedAt };
    for (const ws of r.members) this.send(ws, { t: 'preset', ...r.preset });
    return { ok: true, epoch, members: r.members.size };
  }

  // A single param tweak: morph WITHOUT bumping epoch/startedAt (phase preserved).
  setParam(roomId, key, value) {
    const r = (!roomId || roomId === MAIN_ROOM) ? null : this.getRoom(roomId, false);
    const preset = r ? r.preset : this.preset;
    if (!preset) return { ok: false, error: 'no active preset' };
    preset.params[key] = value;
    const msg = { t: 'paramUpdate', epoch: preset.epoch, key, value };
    if (r) { for (const ws of r.members) this.send(ws, msg); }
    else this.broadcastAudience(msg);
    return { ok: true, epoch: preset.epoch };
  }

  // Drop the main-room preset (back to timeline/idle). Used when a timeline is armed.
  clearPreset() {
    if (!this.preset) return;
    const epoch = this.preset.epoch + 1;
    this.preset = null;
    this.broadcastAudience({ t: 'preset', type: 'off', params: {}, epoch, startedAt: serverClock() });
  }

  // Auto-stop the show when the track finishes, so phones don't keep flashing after
  // the music ends (the timeline runs locally; without this, each phone only goes
  // dark at durationMs but the operator must remember to STOP). One server timer ends
  // everyone together. tailMs gives a hair past the last cue before going dark.
  cancelEnd() { if (this._endTimer) { clearTimeout(this._endTimer); this._endTimer = null; } }
  scheduleEnd() {
    this.cancelEnd();
    if (this.state.status !== 'running' || this.state.T0 == null) return;
    const tl = this.loadTimeline(this.state.trackId);
    const dur = tl && tl.durationMs;
    if (!dur) return;
    const remaining = (this.state.T0 + dur) - serverClock() + 300; // +tail
    this._endTimer = setTimeout(() => { if (this.state.status === 'running') this.stop(); }, Math.max(0, remaining));
    if (this._endTimer.unref) this._endTimer.unref();
  }

  addOperator(ws) { this.operators.add(ws); this.send(ws, { t: 'state', state: this.publicState() }); this.broadcastCount(); }
  removeOperator(ws) { this.operators.delete(ws); }

  broadcastCount() {
    this.broadcastOperators({ t: 'count', audience: this.audience.size, operators: this.operators.size });
  }

  publicState() {
    return {
      epoch: this.state.epoch, status: this.state.status,
      trackId: this.state.trackId, T0: this.state.T0, pausePos: this.state.pausePos,
    };
  }

  // ---- operator actions (only callable from an authed operator socket) ----
  arm(trackId) {
    const tl = this.loadTimeline(trackId);
    if (!tl) return { ok: false, error: 'no timeline for track' };
    this.cancelEnd();
    this.clearPreset(); // a timeline show supersedes any live preset on the main room
    this.state.trackId = trackId;
    this.state.status = 'idle';
    this.state.T0 = null;
    // Distribute the WHOLE timeline once (P0-5: a phone that gets this single
    // message can run the show locally even if its socket later drops).
    this.broadcastAudience({ t: 'timeline', trackId, data: tl });
    this.broadcastState();
    return { ok: true };
  }

  go(T0) {
    if (this.state.trackId == null) return { ok: false, error: 'arm a track first' };
    // sanity: T0 must be near-future on the server clock
    const nowS = serverClock();
    if (!Number.isFinite(T0) || T0 < nowS - 2000 || T0 > nowS + 15000) {
      return { ok: false, error: 'T0 out of range' };
    }
    this.state.epoch++;
    this.state.status = 'running';
    this.state.T0 = T0;
    this.state.pausePos = 0;
    this.broadcastAudience({ t: 'start', epoch: this.state.epoch, trackId: this.state.trackId, T0 });
    this.broadcastState();
    this.scheduleEnd();
    return { ok: true };
  }

  pause() {
    if (this.state.status !== 'running') return { ok: false, error: 'not running' };
    this.cancelEnd();
    this.state.epoch++;
    this.state.pausePos = serverClock() - this.state.T0;
    this.state.status = 'paused';
    this.broadcastAudience({ t: 'pause', epoch: this.state.epoch, pos: this.state.pausePos });
    this.broadcastState();
    return { ok: true, pos: this.state.pausePos };
  }

  // Resume from where we paused (continue, not restart): pick a new T0 so the show
  // position picks up at pausePos and counts forward.
  resume() {
    if (this.state.status !== 'paused') return { ok: false, error: 'not paused' };
    this.state.epoch++;
    this.state.status = 'running';
    this.state.T0 = serverClock() - this.state.pausePos;
    this.broadcastAudience({ t: 'start', epoch: this.state.epoch, trackId: this.state.trackId, T0: this.state.T0 });
    this.broadcastState();
    this.scheduleEnd();
    return { ok: true, pos: this.state.pausePos };
  }

  stop() {
    this.cancelEnd();
    this.preset = null; // STOP also kills any live preset (it must not keep flashing)
    this.state.epoch++;
    this.state.status = 'idle';
    this.state.T0 = null;
    this.state.pausePos = 0;
    this.broadcastAudience({ t: 'stop', epoch: this.state.epoch });
    this.broadcastState();
    return { ok: true };
  }

  blackout() {
    // Immediate, all-dark, highest-priority. Separate from audience opt-out.
    this.cancelEnd();
    this.preset = null; // BLACKOUT kills the preset too (all dark, nothing renders)
    this.state.epoch++;
    this.state.status = 'blackout';
    this.state.T0 = null;
    this.broadcastAudience({ t: 'blackout', epoch: this.state.epoch });
    this.broadcastState();
    return { ok: true };
  }

  broadcastState() { this.broadcastOperators({ t: 'state', state: this.publicState() }); }
}

export const hub = new ShowHub();
