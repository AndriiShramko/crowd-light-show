# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0] - 2026-06-28

Landing demo plays the music, audience-form autofill, and an English-first demo.

### Added

- **The "Try it" demo now plays the music** — instead of a generic light loop, the demo
  uses the first track in the operator's playlist: its real light timeline plus its audio,
  played locally on the phone, **looped and synced** to a shared demo epoch (a new
  `AudioSync.startLoop` keeps the loop phase-locked; drift is corrected relative to the
  initial lock so the constant output-latency lead isn't fought). New public, rate-limited
  `GET /api/demo/audio`. Falls back to the synthetic light loop if the playlist is empty,
  and degrades to lights-only if a browser can't decode the track.

### Changed

- **Audience contact form is autofill-friendly** — the contact field is now `type="email"`
  (with `inputmode="email"`), so the browser recognizes the form as a contact form and
  offers saved name/email; `novalidate` keeps phone/Telegram entries valid.
- **The demo defaults to English** (`/join?demo=1`) — the on-stage audience consent stays
  Polish (a PL event needs the PL epilepsy warning), but the international "try it" flow is EN.

### Fixed

- **AudioContext anchor** — ignore a `getOutputTimestamp()` that returns zeroed values right
  after `resume()` (which skewed the audio↔show-clock mapping ~100 ms).

## [0.4.0] - 2026-06-28

Presets that react to the music, tighter per-phone audio, and audience-UX polish.

### Added

- **Music-reactive presets** — presets no longer "live on their own": each phone folds
  the song's loudness at the synced track position into the preset, so Pulse breathes on
  the beat, Color Waves / Rainbow Chase / Ocean brighten with the music — and every phone
  stays perfectly in sync because the loudness is read from the same already-governed,
  already-delivered timeline (no new data, no new clock). The operator tunes each preset's
  reaction **live** with a **Music reactivity** (and **Reactivity curve**) slider; default 0,
  so a preset is unchanged until you raise it. Reactivity engages once a track is armed + GO.
- New tests: `presets_audio` (reactivity correlates with loud/quiet sections; all phones
  agree; depth 0 == the non-reactive output) and a beat-heavy reactive **strobe-safety**
  assertion in `presets_safety`.

### Changed

- **Tighter per-phone audio sync** — the phone now compensates each device's audio
  **output latency** (`outputLatency` + `baseLatency`), scheduling the buffer so the
  **sound leaving the speaker** — not the buffer cursor — lands on the show clock. On
  phones whose browser reports latency this removes the bulk of the audible per-phone
  delay; the drift deadband was also tightened (15 ms → 5 ms). Honest limits unchanged:
  Bluetooth/iOS latency is often unreadable and the speed of sound caps a whole room — a
  small-venue / shared-moment feature, not a stadium PA.
- **Client safety governor upgraded** — the on-device backstop now enforces an explicit
  **flash-gate** (≤ 3 low→high crossings/sec) in addition to the ≥ 150 ms ramp, so *any*
  preset — at any params, any music, any reactivity — is provably ≤ 3 flashes/s on-device,
  matching the server cue compiler.
- **Stop returns to the main menu with consent pre-accepted** — leaving the show shows the
  join screen with the agreement already ticked, so rejoining is a single tap (no re-consent).
- **The flashlight (torch) button is now light-blue**, visually distinct from the screen-join button.

### Fixed

- **Stale timeline after delete + re-upload** — the per-track timeline cache was keyed by
  row id, and SQLite reuses a row id after the highest track is deleted, so a deleted-then-
  reuploaded track could serve the *previous* track's cues to new joiners. The cache is now
  evicted on delete and on upload, and deleting the armed track stops the show. Caught by a
  new `cache_evict` regression test.

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

[Unreleased]: https://github.com/AndriiShramko/crowd-light-show/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/AndriiShramko/crowd-light-show/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/AndriiShramko/crowd-light-show/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/AndriiShramko/crowd-light-show/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/AndriiShramko/crowd-light-show/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/AndriiShramko/crowd-light-show/releases/tag/v0.1.0
