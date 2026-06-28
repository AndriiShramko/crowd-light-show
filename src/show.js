import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { db } from './db.js';

// Master clock: a single monotonic source. Every client syncs its offset to this,
// and T0 (show start) is always expressed in these milliseconds.
export function serverClock() { return performance.now(); }

const OPEN = 1; // ws.OPEN

export class ShowHub {
  constructor() {
    this.audience = new Set();   // { ws } audience sockets
    this.operators = new Set();  // authed operator sockets
    this.timelineCache = new Map(); // trackId -> parsed timeline
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

  send(ws, obj) {
    try { if (ws.readyState === OPEN) ws.send(JSON.stringify(obj)); } catch { /* drop */ }
  }

  broadcastAudience(obj) { for (const ws of this.audience) this.send(ws, obj); }
  broadcastOperators(obj) { for (const ws of this.operators) this.send(ws, obj); }

  addAudience(ws) {
    this.audience.add(ws);
    // Late/joining client: hand it the full picture so it can run offline & in-sync.
    this.send(ws, { t: 'welcome', state: this.publicState(), serverTime: serverClock() });
    if (this.state.trackId != null) {
      const tl = this.loadTimeline(this.state.trackId);
      if (tl) this.send(ws, { t: 'timeline', trackId: this.state.trackId, data: tl });
    }
    this.broadcastCount();
  }

  removeAudience(ws) { this.audience.delete(ws); this.broadcastCount(); }
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
    return { ok: true };
  }

  pause() {
    if (this.state.status !== 'running') return { ok: false, error: 'not running' };
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
    return { ok: true, pos: this.state.pausePos };
  }

  stop() {
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
