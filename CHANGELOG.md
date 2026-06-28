# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-06-28

Reliability + scale + per-phone audio. Hardens time-sync toward "never out of step,"
prepares the single process for stadium-scale crowds, lets each phone optionally play
the music in sync, and fixes live bugs around stopping/ending a show.

### Added

- **Per-phone synchronized music** (opt-in) — a phone can tap "play the music on my
  phone too" and the track plays locally, scheduled off the synced show clock via the
  Web Audio API so every phone sounds the same sample at the same instant (`audio-sync.js`).
  A 1 Hz drift loop keeps it aligned (inaudible `playbackRate` nudge, reseat on a big
  jump). Served by a new public, rate-limited, **licence-gated** `/api/audience/audio`
  endpoint (only the armed track). Honest scope: a small/medium-venue and "shared moment"
  feature — the speed of sound, not the code, caps true stadium-wide audio.
- **"Set your brightness to max" ask** — web pages cannot set screen brightness (no API
  on iOS/Android) and auto-brightness *dims* phones in a dark room, so the audience is
  asked, clearly, to max brightness and turn auto off (consent-card note + a non-blocking
  reminder on join), in PL/EN.
- New live tests: `round4_harness` (STOP kills an active preset; track-end auto-stop;
  sync quality gate) and `audio_sync_harness` (every phone schedules audio at the same
  show-clock instant).

### Changed

- **Bulletproof clock sync** — `ready` is now quality-gated (enough clean samples, bounded
  best-RTT, stable offset) so a phone never paints off an untrustworthy estimate; the
  applied offset **slews** toward new estimates so a re-sync is an invisible drift, never a
  jump; a backgrounded tab re-converges on resume; a degraded fallback still lights up on a
  bad network rather than staying dark. The operator's **GO is gated until its own clock
  has converged** (the root cause of a first-run light-vs-music offset), and the start lead
  comes from config (single source of truth).
- **Scale toward thousands** — each broadcast is serialized **once** and reused for every
  socket (was once per socket); per-join index updates are **coalesced** (kills an O(N²)
  message storm during a join rush); WebSocket **permessage-deflate** compresses the big
  timeline; steady clock-sync pings backed off (3 s → 20 s) and the join burst trimmed; a
  **backpressure guard** drops frames to a stalled phone (it runs locally anyway); a
  graceful **"venue full"** cap and a join-time **jitter** spread the connection herd.

### Fixed

- **STOP / BLACKOUT now also end a live preset** — the screen no longer keeps flashing a
  preset after the operator stops.
- **The show auto-stops when the track ends** — phones go dark and the waveform hides
  instead of flashing on after the music has finished (server auto-stop + a local fallback).

## [0.2.0] - 2026-06-28

Studio Slice 1 — live parametric presets + an instant, guest-controlled landing demo.
Layered on top of the existing show engine (same clock sync + safety governor); the
timeline show is unchanged.

### Added

- **Live parametric presets** — instead of streaming frames, the server broadcasts a
  tiny descriptor `{ type, params, epoch, startedAt }` and every phone computes its own
  colour each frame off the synced clock: `rgb = preset(position, params, index, N)`.
  Switching is one small message (epoch++ → instant flip, all phones in sync); a single
  parameter tweak morphs **without** restarting (phase preserved).
- **Four hero presets** — **Pulse** (global breathing), **Color Waves** and
  **Rainbow Chase** (spatial — they split across the crowd by each phone's place),
  and **Ocean** (calm). Operator console gets a live preset panel with parameter sliders.
- **Sticky crowd index** — each phone is handed a stable `index` (0…N-1) on join,
  reused on leave, so spatial presets place it in the room.
- **Server-authoritative preset safety** — `validatePreset()` clamps every parameter to
  a safe range and **simulates** the result; an out-of-envelope preset (strobe, saturated
  red) is structurally unrepresentable. A client-side slew backstop mirrors it.
- **"Try it live" studio demo** (`/studio`) — a guest mints a private, ephemeral room,
  points their own phones at a QR, and switches presets live with **no login**. Switches
  reach only that room (a guest can never touch the real show). Degrades gracefully to a
  single device with a synced on-page crowd preview.
- **Studio kill-switch** — `STUDIO_ENABLED=0` puts the whole new path dormant on prod.
- New tests: `presets_parity` (browser↔server engine identical), `presets_safety`
  (preset governor), and a live `presets_harness` (switch convergence, spatial index
  proof, param morph, safety, guest demo, consent-scroll).

## [0.1.0] - 2026-06-28

Initial MVP release.

### Added

- **Synchronized crowd phone light show** — the whole crowd's phones flash
  together in time with the music, using the phone **screen** as the light
  source on every device (iOS + Android) plus an optional **Android LED torch**
  mode (with camera permission).
- **Clock sync + pre-baked timeline** — an NTP-like clock-offset handshake over
  WebSocket gives every phone a shared show clock, and the full light timeline
  (cue list) is delivered once on join and runs **locally** on each phone, so
  the crowd stays together on congested networks and keeps running if a phone's
  connection drops.
- **Operator console** with playlist upload, server-side audio analysis,
  QR-code generation for the join link, a master transport
  (**ARM / GO / PAUSE / STOP / BLACKOUT**), and a **nudge** slider to align the
  lights with the live PA sound.
- **Audience experience** — a photosensitivity **consent gate**, synchronized
  **screen flashing**, a **wake lock** to keep the screen on during the show,
  and an always-available **opt-out / Stop**.
- **Server-side safety governor** — a cue compiler that hard-caps flashing to
  **≤ 3 flashes/second**, blocks large **saturated-red strobing**, and **ramps**
  large brightness changes (per WCAG 2.3.1 / 2.3.2 for photosensitive epilepsy).
- **Automated safety tests** and a **multi-client sync harness** to verify the
  flash-rate / strobe limits and the clock-sync + timeline alignment.
- **Dockerized deploy** — runs in a single container (Node.js + ffmpeg).

[Unreleased]: https://github.com/AndriiShramko/crowd-light-show/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/AndriiShramko/crowd-light-show/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/AndriiShramko/crowd-light-show/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/AndriiShramko/crowd-light-show/releases/tag/v0.1.0
