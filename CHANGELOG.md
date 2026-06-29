# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.10.0] - 2026-06-29

Round 9 — the **public operator console**: one landing CTA opens a full operator console (everything `/operator` has except the leads) on its own ephemeral room, plus sharing with GEO/SEO, default music, and a fix for the operator-console audio desync.

### Added

- **Public console at `/studio`.** One primary landing CTA now opens a full operator console — playlist, transport (play/pause/stop/blackout), screen presets, the autonomous torch channel, live preview, join QR and share — on its own private, ephemeral room, with no sign-up. It is the SAME `operator.html`/`operator.js` component as `/operator`, parameterized by a server-injected `__SESSION__` (so new features land in both consoles automatically); the public mode simply has no leads. `studio.js` retired.
- **Console session model.** A signed console token carries a `room` claim read server-side (never from the request body); a public console can only ever drive its own room. New `/api/console/*` router (presets/torch re-validated through the same safety governor, transport, playlist, QR, curated audio).
- **Public defaults you control.** `public_config` singleton + a `Public console defaults` card in your own authed console: brand, welcome text, default screen/torch preset (validated on write), default track, allow-torch. A `track.is_public` flag curates tracks into the public playlist (requires analyzed + licence-attested). Your personal shows stay separate; the public side reads the defaults read-only and re-validates on read.
- **Default music.** The public console auto-arms the default curated track so the lights roll instantly; sound is one tap (browser autoplay policy — honest: lights immediately, sound on tap).
- **Sharing (both consoles + `/join`).** A share block to invite people by link/code to WhatsApp, Telegram, X, Facebook, email, the native share sheet, or copy — carrying the JOIN url + invite text, plus a separate static "start your own" so people see they can become operators too. Honest copy: "a synced light show", never "perfectly synced".
- **GEO/SEO.** `robots.txt` now disallows `/studio`; `sitemap.xml` lists `/privacy`; landing gains `og:image` + `twitter:summary_large_image` + hreflang + a HowTo JSON-LD; `llms.txt` gains "Run your own" / "Share" sections. **Fix:** `robots.txt`/`sitemap.xml`/`llms.txt`/`og-cover.png` now serve at the ROOT (they 404'd there before — only `/static/*` worked — so `robots.txt` was never effective for crawlers).
- **Own-music upload — DARK (off by default, `PUBLIC_UPLOAD_ENABLED=0`).** When enabled, a visitor's audio is decode-then-discard: analyzed into a safety-governed light timeline (held in memory, keyed to the room) and the file deleted immediately — the sound is never stored, re-served or published (lights only). Consent is server-mandatory; size/duration/rate/concurrency are bounded by a new decode semaphore. A `/privacy` clause (EN + PL) describes it.

### Fixed

- **Operator-console audio desync.** The console's lights were always synced, but the monitor audio was started by a bare `setTimeout` that ignored the clock offset + nudge, so it drifted from the on-air audio. The console now plays through `AudioSync.start(T0)` on the same show clock as the phones (the visible `<audio>` is muted during live). Honest: the scheduled instant matches the phones (≤50 ms in headless), not the acoustics — the operator still hears their own speaker.

### Changed

- **Room-scoped run-state.** Every room (the main show + each ephemeral public room) now owns its own run-state, screen/torch presets and auto-stop timer, so a public console drives its room with zero cross-room leakage and the main show is unaffected. A per-room cap and per-IP mint cap bound the ephemeral rooms.

## [0.9.0] - 2026-06-29

Round 8C — the public site: a managed-service pricing section, a redesigned mobile lead form, the same lead/contact block on every page, a four-language UI, and a RODO privacy + imprint page.

### Added

- **Pricing (managed service).** Four honest tiers on the landing — Spark (up to 100 phones, from €1,900), Surge (up to 1,000, from €9,900), Stadium (up to 10,000, from €50,000, subject to infrastructure provisioning) and Beyond ("let's talk"). Framed as a service (people + production + tuning), not a guarantee; "from / subject to venue, audience size and network conditions"; every tier routes to the contact form — no payment here. A copy-guard test fails the build on over-promise wording (`test/site_8c.mjs`).
- **Shared lead/contact block on all 5 pages** (`/`, `/try`, `/studio`, `/join`, `/about`) plus `/privacy`, injected via a single server-side renderer. Before, only `/` did token replacement, so the other pages were served raw — a server `renderPage()` now drives every public page.
- **`/privacy`** — RODO privacy notice (controller, lawful basis 6(1)(b), storage, 12-month retention, rights, UODO) + EU imprint (provider, NIP). EN + PL authoritative; ES/FR marked pending native review.
- **Four-language UI (EN / PL / ES / FR)** via a site-wide i18n layer with a floating switcher, `?lang=` / navigator-language detection, and localStorage persistence across navigation. The in-show epilepsy consent (PL-default) is unchanged and not weakened.

### Changed

- **Redesigned lead form.** Root cause of the mobile overflow fixed (the form CSS only styled `input[type=text]`). Fields are now Name + Email (required) and Phone + Company (optional), all with proper `type`/`autocomplete` for browser autofill; no horizontal overflow at 360px or 320px. After submit it does **not** echo the submitted details — it thanks you and offers to share the live demo with friends ("a synced light show you can share").
- **Lead data + privacy.** The `application` table gains email/phone/company/source/tier (idempotent migration on the live DB). The Telegram owner notification no longer carries the lead's personal data — it only says "a new lead arrived, open the admin panel".

## [0.8.0] - 2026-06-29

Round 8B — the torch (camera-LED flash) becomes a fully AUTONOMOUS channel, independent of the screen: its own patterns, its own reactivity sliders, its own safety-governed preview. Honest about iPhone.

### Added

- **Autonomous torch channel.** A second preset channel (`{t:'preset', channel:'torch'}`) with its own presets — **off / strobe / sparkle / beat (reactive)** — and its own reactivity knobs (**Flash reactivity / strength / floor / curve**), completely independent of the screen presets. Changing the torch never moves the screen and vice-versa. The torch is driven by this channel (no longer a mirror of the screen luminance).
- **Live flash preview in the operator console** — a safety-governed on/off filmstrip of the camera-LED as you tune the torch pattern.
- **Flash-reach split in the operator console** — how many connected phones are Android (camera-LED capable) vs iPhone/other (screen-only).

### Changed

- **Honest about iPhone.** iOS has no web torch API (WebKit), so on iPhone the torch channel is a **no-op** — the LED is never driven and the **screen** is the light instead, with a clear in-app note. The app never claims the flashlight works on iPhone.

### Safety

- The torch is an independent flashing surface, so it is **independently capped to ≤3 flashes/s** (rate cap ≤2.8 Hz in the schema + an on-device `makeTorchGate` + server `validateTorchPreset`). Screen and torch are proven ≤3/s **independently and together** at max strength on a beat-heavy track (`test/presets_safety.test.mjs`). STOP and BLACKOUT kill **both** channels. `TORCH_PRESETS` live in `presets.js` so the byte-parity test (`test/presets_parity.mjs`) covers them.

## [0.7.0] - 2026-06-29

Round 8A — screen engine: waveform-restart bug fixed, much stronger (operator-tunable) music reactivity, and a live preset preview in the operator console. Screen channel only; the separate torch channel is a later round.

### Fixed

- **Waveform vanished after a restart.** After the music ended and the operator pressed GO again on the same armed track, the loudness waveform disappeared on every phone and never returned until the app was restarted. Root cause (`public/audience.js`): a track-end calls `hideWave()`, and a fresh GO broadcasts only `{t:'start'}` (no new `{t:'timeline'}`, so `buildEnvelope()` — which un-hid the canvas — never ran). Fix: show/hide are decoupled from `buildEnvelope`, and `{t:'start'}` now calls `showWave()`. Proven by `test/waveform_restart.mjs` (stop→GO ×3 and a natural track-end→GO, no JS errors).

### Changed

- **Much stronger, operator-tunable music reactivity.** New `audioDrive()` conditions the governed loudness — floor-gate → normalize → **Reactivity strength (audioGain 1–6, def 2.5)** → **Reactivity curve (audioGamma)** — with a new **Reactivity floor (audioFloor)**, so the sliders have real range (measured ≥1.5× luminance-swing span from min→max strength on every hero preset, up to ~4.8× on Pulse; `test/reactivity_swing.mjs`). `audioDepth=0` stays byte-identical to the autonomous look for any params (parity invariant). The on-device safety governor still bounds every preset to ≤3 flashes/s at max strength (`test/presets_safety.test.mjs`).

### Added

- **Live preset preview in the operator console.** A safety-governed filmstrip (`CLS_PRESETS` + `clampColor` + `makeBackstop`, driven by a synthetic loudness) shows what the crowd's screen does — colour, brightness, flash — as the operator turns each value. The console now loads `presets.js`. Proven by `test/preview_op.mjs` (preview renders, changes per preset, reacts to sliders, ≤3 flashes/s — not a bypass).

## [0.6.0] - 2026-06-29

Two audio fixes: restore tight same-model phone sync, and let the operator actually change the track.

### Fixed

- **Per-phone audio sync regression (same-model nearby phones).** v0.4.0's per-device
  output-latency compensation made identical nearby phones *worse*: their true speaker
  latency is the same (so cursor-alignment already aligns the sound), but subtracting each
  device's *reported* `outputLatency` — which is noisy, quantized, device-variable, and `0`
  on Safari — pushed them apart by tens of ms. And the tightened 5 ms drift deadband made
  each phone chase its own clock noise with independent `playbackRate` nudges (wobble).
  Now: **latency compensation is OFF by default** (cursor aligns to the synced show clock,
  so identical devices lock; it's an opt-in for known mixed fleets), and the **drift
  corrector is reseat-only** (no continuous `playbackRate` nudging). This restores the
  v0.3.0 "in sync" behavior and removes the noise. Mixed-device/Bluetooth still can't be
  perfect (genuinely different speaker latency) — that's stated plainly and unchanged.
- **Changing the armed track now changes the music on phones.** The `/api/audience/audio`
  URL is the same for every track (it serves the *armed* track) but carried a 1-hour
  `Cache-Control`, so a phone replayed the *previous* track's cached audio after the
  operator armed a different one. Audio fetches are now cache-busted per track id.

### Tests

- `audio_samemodel` (identical phones lock the cursor, independent of reported latency, no
  wobble), `track_switch` (arming a different track re-fetches the new audio); the existing
  `audio_sync` harness now validates the **opt-in** compensation path.

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

[Unreleased]: https://github.com/AndriiShramko/crowd-light-show/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/AndriiShramko/crowd-light-show/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/AndriiShramko/crowd-light-show/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/AndriiShramko/crowd-light-show/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/AndriiShramko/crowd-light-show/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/AndriiShramko/crowd-light-show/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/AndriiShramko/crowd-light-show/releases/tag/v0.1.0
