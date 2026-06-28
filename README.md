# Crowd Light Show — synchronized phone light show for crowds, concerts & stadiums (open-source web app)

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)
[![Made with Node.js](https://img.shields.io/badge/Made%20with-Node.js-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org/)

**Crowd Light Show** is an open-source web app that turns a crowd's phones into **one synchronized light show** in time with the music. Instead of buying expensive LED wristbands, you can **turn phones into synchronized lights**: an operator builds a playlist, projects a **QR code**, and the audience **scans the QR to join** — **no app install**, just the phone browser. Every connected phone then flashes together in time with the music, creating a wave of light across the venue. It works as a **phone screen light show** on every device (iOS + Android), with an optional **phone flashlight** mode on Android. Sync is kept tight with an **NTP-style WebSocket clock-sync** handshake and a pre-computed light timeline that each phone runs locally — perfect for **concert lights, stadium light shows, club nights, parties, and live events**.

---

## Features

- **One crowd, one light show** — every connected phone flashes together, in time with the music.
- **No app install** — the audience just scans a QR code and opens a web page.
- **Screen-as-light, cross-platform** — the phone screen is the light source on both iOS and Android.
- **Optional Android torch** — on Android the real LED flashlight can also be used (with camera permission).
- **Tight sync even on bad networks** — clock-offset handshake + a pre-baked timeline that runs locally on each phone, so the crowd stays together even when the venue Wi-Fi is congested.
- **Resilient** — the whole show timeline is delivered on join, so a phone keeps running the show even if its connection drops.
- **Operator console** — upload audio, build a playlist, project the QR, and drive the show with a master transport.
- **Live presets (studio)** — switch the whole crowd between parametric presets (Pulse, Color Waves, Rainbow Chase, Ocean) in real time; spatial presets split across the crowd by each phone's place. No track required.
- **Try it live** — a guest can mint a private room at `/studio`, point a few phones at a QR, and switch presets themselves with no login (degrades gracefully to a single device).
- **Safety first** — a server-side safety governor caps flashing and blocks dangerous strobe patterns (see Safety). Presets are validated and clamped on the server too.
- **Anonymous & ephemeral** — no accounts, no personal data, no tracking cookies.

---

## How it works

1. **Operator console is the audio source.** The operator uploads audio files into a playlist. The server analyzes the audio and builds a light **timeline** (a cue list) for the show.
2. **Clock sync.** When a phone joins, it runs an **NTP-like clock-offset handshake over WebSocket** to learn how far its clock is from the server's. This lets every device agree on a shared show time.
3. **Pre-baked timeline runs locally.** The entire light timeline is sent to each phone **once, on join**. Each phone then runs the show **locally** off its synced clock — so the crowd stays in step even if the network is busy, and a phone can finish the show even if its connection drops.
4. **Screen as light.** On every phone the **screen** is the light source (works on iOS + Android). On **Android**, the real **LED flashlight** can optionally be used too (this needs camera permission). iOS cannot control the flashlight from the web, so the screen is the cross-platform light by design.
5. **Start alignment (T0).** The operator console derives the show start (T0) from the **real audio start**, with a manual **nudge** slider to fine-align the lights with the PA / house sound.

---

## Safety (photosensitive epilepsy / WCAG)

Flashing light can trigger seizures in people with photosensitive epilepsy. Crowd Light Show takes this seriously:

- A **server-side cue compiler acts as a safety governor**. It **hard-caps flashing to ≤ 3 flashes per second** and **blocks large, saturated-red strobing**, in line with **WCAG 2.3.1 / 2.3.2** (three-flash and red-flash thresholds).
- Large brightness changes are **ramped over ≥ 150 ms** rather than snapped, to avoid harsh strobe edges.
- The audience sees a **photosensitivity warning and a consent gate** before joining, and an **always-visible Stop** control to opt out at any time.

These limits are enforced on the server, so a show cannot be configured to exceed them.

---

## Quick start

Requirements: Node.js and `ffmpeg` available on the host (used for audio decoding).

```bash
npm install
npm start
```

Environment variables:

| Variable | Purpose |
| --- | --- |
| `OPERATOR_PASS` | Password for the operator console (`/operator`). |
| `PUBLIC_BASE_URL` | The public base URL encoded into the join QR code (e.g. `https://your-host`). |

**Docker:** the app runs in a single Docker container (Node.js + ffmpeg). Build the image and run it with the same environment variables; expose the app's port and point `PUBLIC_BASE_URL` at the public address the audience will reach.

---

## Usage

1. **Operator:** open `/operator`, enter the `OPERATOR_PASS`, upload audio into a playlist, and display the generated **QR code** on the big screen.
2. **Audience:** people **scan the QR code** with their phone camera, open the page at **`/join`**, accept the photosensitivity warning, and join. Their phones become part of the light show.
3. **Landing:** the project's landing page is at **`/`**.

The operator drives the show with a master transport: **ARM → GO → PAUSE → STOP → BLACKOUT**, plus the **nudge** slider to align the lights with the live audio.

---

## Roadmap

- **P1 (now): Everyone flashes together.** The whole crowd flashes as one, in time with the music.
- **P2: Zones & patterns.** Split the crowd into zones to run patterns and **waves** of light.
- **P3 (research-grade / future): Per-seat codes → seat map → "draw with light".** Assign each phone a seat, map the venue, and treat the crowd as a low-resolution pixel display to **draw images and animations with light across a stadium**. This is forward-looking / research-grade and not part of the current release.

---

## Privacy

Crowd Light Show is **anonymous and ephemeral**: there are **no accounts**, **no personal data**, and **no tracking cookies**. Audience phones join a live show and leave — nothing about them is stored.

---

## Tech stack

- **Node.js** + **Fastify** — HTTP server, audio upload, and API.
- **ws** — WebSocket transport for clock sync and live control.
- **better-sqlite3** — local storage for playlists and show data.
- **qrcode** — server-side QR generation for the join link.
- **ffmpeg** — audio decoding / analysis.
- **Vanilla JS** clients (operator console + audience page) — no framework, no app install.
- Ships as a single **Docker** container.

---

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and how to propose changes, and please follow our [Code of Conduct](CODE_OF_CONDUCT.md). By contributing you agree your contributions are licensed under Apache-2.0.

---

## License

Licensed under the **Apache License 2.0**. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

---

## Author

**Andrii Shramko** — [LinkedIn](https://www.linkedin.com/in/andrii-shramko/)

---

## Commercial use & custom work

**Free for any use.** Need it **customized, integrated, supported, or extended** for your event, venue, tour, or product? **Get in touch — let's talk.**

- LinkedIn: https://www.linkedin.com/in/andrii-shramko/
- Email: zmei116@gmail.com
- Book a call: https://calendar.app.google/Ff729HqGk4RpzPNDA

---

## Music licensing note

Public performance of copyrighted music is the **organizer's responsibility**. In Poland this means clearing rights with **ZAiKS** and related collecting societies. Crowd Light Show provides the synchronized lighting; it does not grant any music performance rights.

---

## FAQ

**Does it work on iPhone?**
Yes. On both iPhone (iOS) and Android the phone **screen** is the light source, so it works on every modern phone. The real LED flashlight can only be used on Android (with camera permission); iOS does not let web pages control the flashlight, which is why the cross-platform light is the screen.

**Do users need to install an app?**
No. Audience members just **scan the QR code** and open a web page in their phone browser. There is nothing to download or install.

**Is it safe? What about epilepsy?**
A server-side safety governor **hard-caps flashing to ≤ 3 flashes/second**, blocks large saturated-red strobing (per WCAG 2.3.1 / 2.3.2), and ramps big brightness changes over ≥ 150 ms. The audience also sees a **photosensitivity warning and consent gate** with an always-visible Stop. People sensitive to flashing light should still exercise their own judgment.

**Can I use it commercially?**
Yes — it's **free for any use** under Apache-2.0, including commercial events. If you want it customized, integrated, supported, or extended for your venue or product, [get in touch](#commercial-use--custom-work). Note that clearing music performance rights (e.g. ZAiKS in Poland) is the organizer's responsibility.

**How many phones can it handle?**
The design scales to a crowd because the heavy lifting happens **on each phone**: the full light timeline is sent once on join and each phone runs the show **locally** off its synced clock, so the server doesn't have to push frame-by-frame updates to thousands of devices. Real-world capacity depends on your server and venue network.

**Does it need internet at the venue?**
Phones need network access to **join** the show (scan the QR, sync the clock, and download the timeline). After that, because the timeline runs locally on each phone, a device can keep running the show even if its connection drops mid-show.

**What controls does the operator have?**
The operator builds a playlist (uploads audio), projects the QR, and drives a master transport: **ARM → GO → PAUSE → STOP → BLACKOUT**, plus a **nudge** slider to align the lights with the live PA sound.
