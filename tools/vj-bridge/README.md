# Crowd Light Show — VJ Bridge (drive the show from professional VJ software)

Control a Crowd Light Show from **Resolume**, **TouchOSC**, **Bitfocus Companion**, **Chataigne**, **QLC+**, or anything that speaks **OSC** — over UDP, from your own laptop.

## How it works (and why it's safe)

The show server already exposes a complete, **safety-gated External Control API** (the same surface the web console uses):

- Console room (a `/studio` room): `POST /api/console/{preset,fx,blackout,manual,palette,seek,mute-all,marquee,go,pause,resume,stop}` with `Authorization: Bearer <consoleToken>`.
- Main show: the same under `/api/operator/*`, authorized by the operator password (→ token via `POST /api/login`).

Every command is **re-validated and re-governed on the server** (≤3 flashes/s, no saturated red) and is **room-scoped by the signed token**, so external control can never exceed the epilepsy-safety bounds and can only drive its own room.

**This bridge runs on _your_ laptop**, not on the show server. It opens a **local UDP socket** for OSC, holds the token locally, and forwards each mapped message **outbound over HTTPS** to the API. Nothing inbound is opened on the show host — so the locked-down container and its neighbours are untouched, and it works through NAT/TLS.

```
Resolume / TouchOSC / Companion ──OSC/UDP──▶  vj-bridge (your laptop)  ──HTTPS──▶  lightshow.flyreelstudio.eu
```

## Run it

Zero dependencies (Node ≥ 18 — OSC is parsed in ~40 lines, networking is built-in).

**Drive a `/studio` room** (get the token from the `/studio` page: it's `window.__SESSION__.token`):

```bash
node bridge.mjs \
  --api https://lightshow.flyreelstudio.eu \
  --token "$CLS_CONSOLE_TOKEN" \
  --osc-port 9000 --osc-host 0.0.0.0
```

**Drive the main show** (operator):

```bash
node bridge.mjs --api https://lightshow.flyreelstudio.eu --operator-pass "$OP_PASS" --osc-port 9000
```

Flags: `--osc-host` (default `127.0.0.1`; use `0.0.0.0` if Resolume runs on another machine), `--rate` (manual-fader Hz, default 20), `--verbose`. The token is never logged.

## OSC address map (`/cls/*`)

| OSC address | args | Effect |
|---|---|---|
| `/cls/manual/hue` | `f` 0..1 | set hue (×360), auto-enables manual |
| `/cls/manual/sat` | `f` 0..1 | set saturation |
| `/cls/manual/bri` | `f` 0..1 | set brightness |
| `/cls/manual/flash` | `f` 0..1 | set flash (torch) intensity |
| `/cls/manual/on` | `f` ≥0.5 | enable / disable the manual layer |
| `/cls/manual/mode` | `s` | `intervene` or `full` (presets off) |
| `/cls/palette` | `s` | restrict to colours, e.g. `"e30613,ffffff"` (up to 8 hex) |
| `/cls/palette/off` | — | clear the palette restriction |
| `/cls/preset` | `s` | screen preset (`pulse`,`rainbow_chase`,`color_waves`,`ocean`,`off`) |
| `/cls/torch` | `s` | flash preset (`beat`,`strobe`,`sparkle`,`off`) |
| `/cls/fx` | `s` or button | fire a firework (`salute`,`twinkle`,`ripple`,`strobe_burst`,`color_burst`) |
| `/cls/blackout` | — / `f`≥0.5 | blackout (lights only; music keeps playing) |
| `/cls/go` `/cls/pause` `/cls/resume` `/cls/stop` | — | transport |
| `/cls/seek` | `f` ms | jump the music+lights to a position |
| `/cls/mute` | `f` ≥0.5 | mute the music on every phone |
| `/cls/marquee` | `s` | scrolling text on every phone |

Faders emit `f` 0..1 (exactly Resolume/TouchOSC's native fader output); manual values are clamped server-side regardless, so a stray `/cls/manual/hue 9.9` is harmless.

## Wiring the software

**Resolume Arena/Avenue** → *Preferences → OSC → enable Output*, IP = the laptop running this bridge (`127.0.0.1` if it's the same machine), Outgoing port = `9000`. In *Shortcuts → Edit OSC*, map a fader to `/cls/manual/hue` (it sends `f` 0..1), or a clip-trigger to `/cls/fx` with value `salute`.

**Bitfocus Companion** (no bridge needed for buttons): add a **Generic HTTP** connection, base URL `https://lightshow.flyreelstudio.eu`; on a button add a **POST** action to `/api/console/fx`, header `Authorization: Bearer <token>`, header `Content-Type: application/json`, body `{"name":"salute"}`. Or use **Generic OSC** → `127.0.0.1:9000` → `/cls/blackout` to go through this bridge.

**TouchOSC / Lemur** → OSC connection, host = the bridge laptop's IP, send port `9000`, address controls `/cls/*`.

## Security

The bridge holds the token **locally only**, talks **outbound over TLS** to the show origin, redacts the token from logs, and coalesces fast fader moves to ≤20 Hz. The server's own rate limit and validators are the hard backstop. No inbound port is opened on the show host.

## Extending

Art-Net/DMX (Resolume can output a DMX universe) maps cleanly onto the same commands — parse `ArtDMX` (opcode `0x5000`) and route channels via the same `handle()` switch. Not enabled by default (OSC covers the common case); add `artnet.mjs` if you need it.
