import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { db } from './db.js';
import { config } from './config.js';

// Master clock: a single monotonic source. Every client syncs its offset to this,
// and T0 (show start) is always expressed in these milliseconds.
export function serverClock() { return performance.now(); }

const OPEN = 1; // ws.OPEN
export const MAIN_ROOM = 'main';

// Fresh per-room run-state. ROUND 9: every room (main + each ephemeral public/guest
// room) owns its OWN run object, so arm/go/pause/stop/blackout never cross rooms.
function newRun() { return { epoch: 0, status: 'idle', trackId: null, T0: null, pausePos: 0 }; }

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
    this.torchPreset = null;     // main-room autonomous torch preset | null
    this._endTimer = null;       // MAIN auto-stop timer: ends the show when the track finishes
    this._indexDirty = new Set(); // rooms whose phones need a fresh index broadcast (coalesced)
    this._indexTimer = null;
    // Ephemeral rooms (round 9): id -> {members, preset, torch, alloc, run, _endTimer, createdAt}.
    // A guest/public room is now a FULL run-state context (its own arm/go/stop/torch/end-timer),
    // not just a screen-preset slot — the public operator console drives one of these.
    this.rooms = new Map();
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
  // Evict a cached timeline so a deleted-then-reuploaded track id (SQLite reuses the max
  // rowid after a delete) can never serve the OLD track's cues to new joiners.
  evictTimeline(trackId) { this.timelineCache.delete(Number(trackId)); }

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

  // ---- rooms (main + ephemeral guest/public rooms) ----
  getRoom(roomId, create) {
    if (!roomId || roomId === MAIN_ROOM) return null; // main is special (this.audience)
    let r = this.rooms.get(roomId);
    if (!r && create) {
      // Hard ceiling: refuse to mint beyond the cap (memory guard for the 512 MB box).
      if (this.rooms.size >= config.publicMaxRooms) return null;
      r = { members: new Set(), preset: null, torch: null, alloc: new IndexAllocator(), run: newRun(), _endTimer: null, createdAt: serverClock() };
      this.rooms.set(roomId, r);
    }
    if (r && !r.run) r.run = newRun();   // defensive: older rooms always get a run slot
    return r || null;
  }

  // Reap orphan rooms (a preset/run set but no phones ever joined / all left). Clears
  // any pending per-room auto-stop timer so a reaped room can't fire stop() later.
  sweepRooms(ttlMs = 60000) {
    const cutoff = serverClock() - ttlMs;
    for (const [id, r] of this.rooms) {
      if (r.members.size === 0 && (r.createdAt || 0) < cutoff) {
        if (r._endTimer) { clearTimeout(r._endTimer); r._endTimer = null; }
        this.rooms.delete(id);
      }
    }
  }

  // Uniform run-state handle for a room. MAIN is backed by this.state/this.audience/
  // this.preset/this.torchPreset/this._endTimer (back-compat — MAIN behavior is byte-
  // identical); a guest/public room is backed by its OWN per-room slots. Transport
  // methods operate through this so they are room-scoped with ZERO cross-room leakage.
  _rt(roomId, create) {
    const self = this;
    if (!roomId || roomId === MAIN_ROOM) {
      return {
        id: MAIN_ROOM, isMain: true,
        run: this.state, members: this.audience, alloc: this.alloc,
        getPreset: (ch) => ch === 'torch' ? self.torchPreset : self.preset,
        setPreset: (ch, v) => { if (ch === 'torch') self.torchPreset = v; else self.preset = v; },
        getEnd: () => self._endTimer, setEnd: (t) => { self._endTimer = t; },
        broadcast: (obj) => self.broadcastAudience(obj),
        announceState: () => self.broadcastState(),
      };
    }
    const r = this.getRoom(roomId, create);
    if (!r) return null;
    return {
      id: roomId, isMain: false, room: r,
      run: r.run, members: r.members, alloc: r.alloc,
      getPreset: (ch) => ch === 'torch' ? r.torch : r.preset,
      setPreset: (ch, v) => { if (ch === 'torch') r.torch = v; else r.preset = v; },
      getEnd: () => r._endTimer, setEnd: (t) => { r._endTimer = t; },
      broadcast: (obj) => { const s = JSON.stringify(obj); for (const ws of r.members) self.sendStr(ws, s); },
      announceState: () => {}, // a guest/public room has no operator-state channel; the console reads state from room messages
    };
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
      if (this.torchPreset) this.send(ws, { t: 'preset', ...this.torchPreset }); // autonomous torch channel
      if (this.state.trackId != null) {
        const tl = this.loadTimeline(this.state.trackId);
        if (tl) this.send(ws, { t: 'timeline', trackId: this.state.trackId, data: tl });
      }
      this.send(ws, { t: 'index', index: this.alloc.indexOf(ws), total: this.alloc.total() }); // joiner gets its index now
      this.markIndexDirty(MAIN_ROOM);   // others refresh total on the coalesced flush
      this.broadcastCount();
    } else {
      const r = this.getRoom(roomId, true);
      if (!r) { this.send(ws, { t: 'full' }); try { ws.close(); } catch { /* ignore */ } return; } // room cap reached
      r.members.add(ws); r.alloc.alloc(ws);
      // Round 9: a phone joining a public room gets that room's OWN run-state, presets,
      // torch + armed timeline (NOT the main show's) — so a late joiner catches up to a
      // console-driven show, and isolation holds (it can never see the main timeline).
      this.send(ws, { t: 'welcome', state: this.roomPublicState(r), serverTime: serverClock() });
      if (r.preset) this.send(ws, { t: 'preset', ...r.preset });
      if (r.torch) this.send(ws, { t: 'preset', ...r.torch });
      if (r.run && r.run.trackId != null) {
        const tl = this.loadTimeline(r.run.trackId);
        if (tl) this.send(ws, { t: 'timeline', trackId: r.run.trackId, data: tl });
      }
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
        if (r.members.size === 0) {
          if (r._endTimer) { clearTimeout(r._endTimer); r._endTimer = null; } // no dangling auto-stop on a dead room
          this.rooms.delete(roomId); // ephemeral: clean up empty rooms
        } else this.markIndexDirty(roomId);
      }
    }
  }

  // ---- live parametric presets — TWO autonomous channels: 'screen' and 'torch' (round 8B) ----
  // Round 9: room-scoped. `valid` must already have passed validatePreset/validateTorchPreset
  // (server-authoritative safety). Per-room torch is allowed now (the public console drives it)
  // and is validated the same way on the console router (safety is never bypassed).
  setPreset(roomId, valid, channel) {
    channel = channel === 'torch' ? 'torch' : 'screen';
    const h = this._rt(roomId, true);
    if (!h) return { ok: false, error: 'room unavailable' };
    const cur = h.getPreset(channel);
    const epoch = (cur ? cur.epoch : 0) + 1;
    const next = { channel, type: valid.type, params: valid.params, epoch, startedAt: serverClock() };
    h.setPreset(channel, next);
    h.broadcast({ t: 'preset', ...next });
    if (h.isMain) this.broadcastState();
    return h.isMain ? { ok: true, epoch } : { ok: true, epoch, members: h.members.size };
  }

  // A single param tweak: morph WITHOUT bumping epoch/startedAt (phase preserved).
  setParam(roomId, key, value, channel) {
    channel = channel === 'torch' ? 'torch' : 'screen';
    const h = this._rt(roomId, false);
    if (!h) return { ok: false, error: 'no active preset' };
    const preset = h.getPreset(channel);
    if (!preset) return { ok: false, error: 'no active preset' };
    preset.params[key] = value;
    h.broadcast({ t: 'paramUpdate', channel, epoch: preset.epoch, key, value });
    return { ok: true, epoch: preset.epoch };
  }

  // Drop a channel's preset (back to timeline/idle). Used when a timeline is armed (screen).
  clearPreset(channel, roomId) {
    channel = channel === 'torch' ? 'torch' : 'screen';
    const h = this._rt(roomId, false);
    if (!h) return;
    const cur = h.getPreset(channel);
    if (!cur) return;
    const epoch = cur.epoch + 1;
    h.setPreset(channel, null);
    h.broadcast({ t: 'preset', channel, type: 'off', params: {}, epoch, startedAt: serverClock() });
  }

  // Auto-stop the show when the track finishes, so phones don't keep flashing after
  // the music ends (the timeline runs locally; without this, each phone only goes
  // dark at durationMs but the operator must remember to STOP). One PER-ROOM server
  // timer ends that room together — round 9: a per-room Map, NOT one global timer, or
  // STOP of one room would cancel another room's auto-stop (phones flashing after end).
  cancelEnd(roomId) { const h = this._rt(roomId, false); if (!h) return; const t = h.getEnd(); if (t) { clearTimeout(t); h.setEnd(null); } }
  scheduleEnd(roomId) {
    const h = this._rt(roomId, false);
    if (!h) return;
    this.cancelEnd(roomId);
    if (h.run.status !== 'running' || h.run.T0 == null) return;
    const tl = this.loadTimeline(h.run.trackId);
    const dur = tl && tl.durationMs;
    if (!dur) return;
    const remaining = (h.run.T0 + dur) - serverClock() + 300; // +tail
    const timer = setTimeout(() => {
      const hh = this._rt(roomId, false);
      if (hh && hh.run.status === 'running') this.stop(roomId);
    }, Math.max(0, remaining));
    if (timer.unref) timer.unref();
    h.setEnd(timer);
  }

  addOperator(ws) { this.operators.add(ws); this.send(ws, { t: 'state', state: this.publicState() }); this.broadcastCount(); }
  removeOperator(ws) { this.operators.delete(ws); }

  broadcastCount() {
    // Torch capability split (round 8B): Android phones can drive the camera LED; iOS/other are
    // screen-only (no web torch API). Lets the operator see how many torches will actually fire.
    let torchCapable = 0, screenOnly = 0;
    for (const ws of this.audience) { if (ws.platform === 'android') torchCapable++; else screenOnly++; }
    this.broadcastOperators({ t: 'count', audience: this.audience.size, operators: this.operators.size, torchCapable, screenOnly });
  }

  publicState() {
    return {
      epoch: this.state.epoch, status: this.state.status,
      trackId: this.state.trackId, T0: this.state.T0, pausePos: this.state.pausePos,
    };
  }
  // A guest/public room's run-state for the welcome frame. `demo:true` marks it as a
  // non-main room (isolation seam) so a phone/console can never confuse it with the
  // real show; trackId is the ROOM's own (never the main show's).
  roomPublicState(r) {
    const run = r.run || newRun();
    return { epoch: run.epoch || 0, status: run.status || 'idle', trackId: run.trackId == null ? null : run.trackId, T0: run.T0 == null ? null : run.T0, pausePos: run.pausePos || 0, demo: true };
  }

  // ---- transport actions — room-scoped (roomId omitted => MAIN, back-compat) ----
  arm(trackId, opts = {}, roomId) {
    const h = this._rt(roomId, true);
    if (!h) return { ok: false, error: 'room unavailable' };
    const tl = this.loadTimeline(trackId);
    if (!tl) return { ok: false, error: 'no timeline for track' };
    this.cancelEnd(roomId);
    // Default: a timeline show supersedes any live preset. For AUDIO-REACTIVE presets the
    // operator passes keepPreset:true so the preset keeps rendering and reads the running
    // track's loudness envelope (the timeline stays armed/running underneath).
    if (!opts.keepPreset) this.clearPreset('screen', roomId);
    h.run.trackId = trackId;
    h.run.status = 'idle';
    h.run.T0 = null;
    // Distribute the WHOLE timeline once (P0-5: a phone that gets this single
    // message can run the show locally even if its socket later drops).
    h.broadcast({ t: 'timeline', trackId, data: tl });
    h.announceState();
    return { ok: true };
  }

  go(T0, roomId) {
    const h = this._rt(roomId, false);
    if (!h || h.run.trackId == null) return { ok: false, error: 'arm a track first' };
    // sanity: T0 must be near-future on the server clock
    const nowS = serverClock();
    if (!Number.isFinite(T0) || T0 < nowS - 2000 || T0 > nowS + 15000) {
      return { ok: false, error: 'T0 out of range' };
    }
    h.run.epoch++;
    h.run.status = 'running';
    h.run.T0 = T0;
    h.run.pausePos = 0;
    h.broadcast({ t: 'start', epoch: h.run.epoch, trackId: h.run.trackId, T0 });
    h.announceState();
    this.scheduleEnd(roomId);
    return { ok: true };
  }

  pause(roomId) {
    const h = this._rt(roomId, false);
    if (!h || h.run.status !== 'running') return { ok: false, error: 'not running' };
    this.cancelEnd(roomId);
    h.run.epoch++;
    h.run.pausePos = serverClock() - h.run.T0;
    h.run.status = 'paused';
    h.broadcast({ t: 'pause', epoch: h.run.epoch, pos: h.run.pausePos });
    h.announceState();
    return { ok: true, pos: h.run.pausePos };
  }

  // Resume from where we paused (continue, not restart): pick a new T0 so the show
  // position picks up at pausePos and counts forward.
  resume(roomId) {
    const h = this._rt(roomId, false);
    if (!h || h.run.status !== 'paused') return { ok: false, error: 'not paused' };
    h.run.epoch++;
    h.run.status = 'running';
    h.run.T0 = serverClock() - h.run.pausePos;
    h.broadcast({ t: 'start', epoch: h.run.epoch, trackId: h.run.trackId, T0: h.run.T0 });
    h.announceState();
    this.scheduleEnd(roomId);
    return { ok: true, pos: h.run.pausePos };
  }

  stop(roomId) {
    const h = this._rt(roomId, false);
    if (!h) return { ok: false, error: 'no room' };
    this.cancelEnd(roomId);
    h.setPreset('screen', null); h.setPreset('torch', null); // STOP kills BOTH channels (no screen or torch flashing)
    h.run.epoch++;
    h.run.status = 'idle';
    h.run.T0 = null;
    h.run.pausePos = 0;
    h.broadcast({ t: 'stop', epoch: h.run.epoch });
    h.announceState();
    return { ok: true };
  }

  blackout(roomId) {
    // Immediate, all-dark, highest-priority. Separate from audience opt-out.
    const h = this._rt(roomId, false);
    if (!h) return { ok: false, error: 'no room' };
    this.cancelEnd(roomId);
    h.setPreset('screen', null); h.setPreset('torch', null); // BLACKOUT kills screen AND torch (all dark)
    h.run.epoch++;
    h.run.status = 'blackout';
    h.run.T0 = null;
    h.broadcast({ t: 'blackout', epoch: h.run.epoch });
    h.announceState();
    return { ok: true };
  }

  broadcastState() { this.broadcastOperators({ t: 'state', state: this.publicState() }); }
}

export const hub = new ShowHub();
