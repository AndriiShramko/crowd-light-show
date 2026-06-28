# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/AndriiShramko/crowd-light-show/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/AndriiShramko/crowd-light-show/releases/tag/v0.1.0
