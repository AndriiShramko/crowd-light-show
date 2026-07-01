# Crowd Light Show — your crowd is the light show (open-source, no app, no wristbands)

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)
[![Made with Node.js](https://img.shields.io/badge/Made%20with-Node.js-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Live demo](https://img.shields.io/badge/Live-demo-5aa0ff.svg)](https://lightshow.flyreelstudio.eu/try)
[![Docker](https://img.shields.io/badge/Self--host-Docker-2496ED.svg?logo=docker&logoColor=white)](#self-host-quickstart)

**Crowd Light Show** turns a crowd's phones into **one synchronized, music-reactive light show**. The audience scans a **QR code** — **no app to install** — and every phone's screen (and the Android camera flash) flashes together, driven live from a browser console. It's **epilepsy-safe by design** (hard-capped ≤ 3 flashes/s, no red strobe), gives you **VJ-grade live control**, and you can **self-host** it. Free and open source.

> Wristbands cost $5–10 a head. Your crowd already has the hardware.

<p align="center"><img src="https://lightshow.flyreelstudio.eu/static/shots/pult.png" alt="The VJ pult — faders, colour wheel and flag palettes driving a crowd's phones" width="720"></p>

**▶ Try it now:** [lightshow.flyreelstudio.eu/try](https://lightshow.flyreelstudio.eu/try) — open the demo, scan the QR with your phone, and watch your own screen join the show.

---

## 20-second demo (self-hosted)

```bash
git clone https://github.com/AndriiShramko/crowd-light-show
cd crowd-light-show
npm install
OPERATOR_PASS=changeme npm start
# open http://localhost:3000/studio  → press Start → scan the QR on your phone → it flashes
```

Requires Node.js 20+ and `ffmpeg` on the host. Prefer Docker? `docker build -t lightshow . && docker run -p 3000:3000 -e OPERATOR_PASS=changeme -e PUBLIC_BASE_URL=http://localhost:3000 lightshow`. (The camera flash / torch needs a **secure context** — `localhost` or HTTPS.)

---

## What it does

**The show**
- **One crowd, one light show** — every phone flashes together, in time with the music, off an NTP-like WebSocket clock. Scales to a stadium; the timeline runs locally on each phone so it survives congested venue networks and reconnects automatically.
- **No app, no wristbands** — the audience scans a QR and joins in the browser. Screen light on every phone (iOS + Android); the real LED flash also fires on Android.
- **Music-reactive** — upload a track; every phone plays it in sync and the lights follow the music (auto-gain so quiet and loud both look good).

**The control room** ([screenshots](https://lightshow.flyreelstudio.eu/#control))
- **Live presets** — Pulse · Colour Waves · Rainbow Chase · Ocean, plus a *spatial* wave that reads across the crowd. A separate **flash (torch)** channel with its own patterns.
- **The VJ pult** — drive the crowd by hand: **saturation, colour, brightness, flash**, in four touch layouts (faders / colour wheel / XY pad / big momentary pads), fullscreen, "intervene in a preset" or "manual only".
- **Palette lock** — restrict the whole show to a flag's or a brand's colours (pick on the wheel, or one-tap a flag).
- **Big moments** — one-tap synchronized **fireworks**, a scrolling **marquee** on every phone, **global mute**, **seek**, and **BLACKOUT** (which keeps the music playing).

**For pros**
- **Drive it from Resolume / TouchOSC / Bitfocus Companion over OSC**, or map a USB fader/pad box with **WebMIDI**. See the [VJ & OSC guide](https://lightshow.flyreelstudio.eu/vj) and [`tools/vj-bridge/`](tools/vj-bridge/).

**Safe & private**
- **Epilepsy-safe governor** enforced on every phone AND the server: ≤ 3 flashes/s, no large saturated-red strobe, ≥ 150 ms brightness ramps (WCAG 2.3.1 / 2.3.2 — *below* UK HSE strobe guidance). Photosensitivity warning + consent gate + always-visible Stop.
- **Anonymous & ephemeral** — no accounts, no personal data; audience phones join and leave.

<p align="center">
  <img src="https://lightshow.flyreelstudio.eu/static/shots/presets.png" alt="Presets, flash channel, one-tap fireworks and a scrolling marquee" width="440">
  <img src="https://lightshow.flyreelstudio.eu/static/shots/phone.png" alt="An audience phone turned into one glowing light" width="180">
</p>

---

## Self-host quickstart

Runs as a single container (Node.js + `ffmpeg`). Apache-2.0 — self-host with **no limits**.

```bash
docker build -t lightshow .
docker run -p 3000:3000 \
  -e OPERATOR_PASS=changeme \
  -e PUBLIC_BASE_URL=https://your-host \
  -e STUDIO_ENABLED=1 \
  lightshow
```

| Env var | Purpose |
| --- | --- |
| `OPERATOR_PASS` | Password for the main operator console (`/operator`). |
| `PUBLIC_BASE_URL` | Public base URL baked into the join QR (e.g. `https://your-host`). |
| `STUDIO_ENABLED` | `1` (default) enables the no-login guest console at `/studio`. |
| `PUBLIC_UPLOAD_ENABLED` | `1` lets guests upload their own music (off by default). |

The included `docker-compose.yml` is a **production** example wired for an [nginx-proxy](https://github.com/nginx-proxy/nginx-proxy) + Let's Encrypt TLS stack (it reads secrets from a `config.env` — copy `config.env.example`). For a plain local run, use the `docker run` above or the `npm start` path. The **flashlight/torch needs a secure context** (HTTPS in production); put it behind a reverse proxy that terminates TLS and forwards WebSockets. Pages: `/` landing · `/studio` guest console · `/operator` main console · `/join` audience · `/vj` integration guide.

---

## Drive it from professional VJ software

The existing token-scoped `/api/console/*` + WebSocket surface **is** the external-control API. A tiny zero-dependency **bridge** ([`tools/vj-bridge/`](tools/vj-bridge/)) runs on the VJ's own laptop, listens for **OSC** over UDP, and forwards it to the show over HTTPS — so nothing new is opened on the show server.

```bash
node tools/vj-bridge/bridge.mjs --api https://your-host --token "$CLS_CONSOLE_TOKEN" --osc-port 9000
```

OSC address map (`/cls/manual/hue`, `/cls/preset`, `/cls/fx`, `/cls/palette`, `/cls/blackout`, …), Resolume / TouchOSC / Companion setup, and the WebMIDI mapping are in the **[VJ & OSC guide](https://lightshow.flyreelstudio.eu/vj)** and [`tools/vj-bridge/README.md`](tools/vj-bridge/README.md). Every command is re-validated + re-governed server-side, so external control can't exceed the safety limits or drive another room.

---

## How it works

1. **The console is the source.** Upload audio; the server analyses it and builds a light **timeline** (a cue list) that passes the safety governor.
2. **Clock sync.** On join, each phone runs an **NTP-like offset handshake over WebSocket** so every device agrees on one show time.
3. **Local playback.** The full timeline is sent **once, on join**; each phone renders the show **locally** off its synced clock — so the crowd stays in step on bad Wi-Fi and finishes the show even if its connection drops. Live presets / manual / palette are tiny broadcasts each phone renders locally.
4. **Screen + torch.** The **screen** is the cross-platform light (iOS + Android); on Android the **LED flash** fires too (camera permission). iOS can't drive the flashlight from the web, so the screen is the light there.

---

## Tech stack

Node.js + **Fastify**, **ws** (WebSocket), **better-sqlite3**, **qrcode**, **ffmpeg**; vanilla-JS clients (no framework, no build step). Ships as one **Docker** container. Parity- and safety-tested (`npm run test:safety`, `node test/sync_harness.mjs`, and the `test/` suite).

## Safety (photosensitive epilepsy / WCAG)

Flashing light can trigger seizures. A safety governor is the **last, unchangeable stage on every phone and on the server**: it hard-caps flashing to **≤ 3 flashes/second**, blocks large saturated-red strobing (**WCAG 2.3.1 / 2.3.2**), and ramps big brightness changes over **≥ 150 ms**. The audience sees a photosensitivity warning + consent gate and an always-visible Stop. A show cannot be configured — or externally driven — past these limits.

## Privacy

Anonymous and ephemeral: no accounts, no personal data, no tracking cookies (the hosted site uses consent-gated, IP-anonymised analytics only). Audience phones join a live show and leave.

## Roadmap

- ✅ Everyone flashes together, music-reactive, live presets, VJ pult, palette lock, effects, OSC/MIDI integration.
- Next: zones & richer spatial patterns; per-seat mapping → "draw with light" across a stadium (research-grade).

---

## License & author

Licensed under the **Apache License 2.0** — see [LICENSE](LICENSE) and [NOTICE](NOTICE). Contributions welcome ([CONTRIBUTING.md](CONTRIBUTING.md), [Code of Conduct](CODE_OF_CONDUCT.md)).

**Andrii Shramko** — [LinkedIn](https://www.linkedin.com/in/andrii-shramko/)

**Free for any use.** Prefer not to self-host, or want it customized / operated for your event? A hosted, done-for-you service is available — [pricing](https://lightshow.flyreelstudio.eu/#pricing) · email `zmei116@gmail.com` · [book a call](https://calendar.app.google/Ff729HqGk4RpzPNDA).

*Music note:* clearing public-performance rights (e.g. ZAiKS in Poland) is the organizer's responsibility; the app provides the lighting, not the music licence.
