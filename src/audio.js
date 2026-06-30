import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { config } from './config.js';

// Decode an audio file to mono Float32 PCM.
// WAV is parsed natively (no external dependency, so tests run without ffmpeg);
// everything else is decoded via ffmpeg (present in the production container).
export async function decodePcm(filePath) {
  // Route by actual content, not filename: WAV (RIFF/WAVE) is parsed natively,
  // everything else goes through ffmpeg (which is format-agnostic).
  const fd = fs.openSync(filePath, 'r');
  const head = Buffer.alloc(12);
  try { fs.readSync(fd, head, 0, 12, 0); } finally { fs.closeSync(fd); }
  const isWav = head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WAVE';
  return isWav ? decodeWav(filePath) : decodeFfmpeg(filePath);
}

function decodeWav(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a WAV file');
  }
  let pos = 12, fmt = null, dataOff = -1, dataLen = 0;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') {
      fmt = {
        audioFormat: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      dataOff = body; dataLen = size;
    }
    pos = body + size + (size % 2);
  }
  if (!fmt || dataOff < 0) throw new Error('WAV missing fmt/data');
  const { channels, sampleRate, bits, audioFormat } = fmt;
  const frames = Math.floor(dataLen / (channels * (bits / 8)));
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < channels; c++) {
      const o = dataOff + (i * channels + c) * (bits / 8);
      let s;
      if (audioFormat === 3 && bits === 32) s = buf.readFloatLE(o);
      else if (bits === 16) s = buf.readInt16LE(o) / 32768;
      else if (bits === 8) s = (buf.readUInt8(o) - 128) / 128;
      else if (bits === 32) s = buf.readInt32LE(o) / 2147483648;
      else throw new Error('unsupported WAV bit depth ' + bits);
      acc += s;
    }
    out[i] = acc / channels;
  }
  return { samples: out, sampleRate };
}

function decodeFfmpeg(filePath) {
  return new Promise((resolve, reject) => {
    const sampleRate = 22050;
    const args = ['-v', 'error', '-i', filePath, '-ac', '1', '-ar', String(sampleRate), '-f', 'f32le', '-'];
    const ff = spawn(config.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = []; let err = '';
    ff.stdout.on('data', (d) => chunks.push(d));
    ff.stderr.on('data', (d) => { err += d.toString(); });
    ff.on('error', (e) => reject(new Error('ffmpeg spawn failed: ' + e.message)));
    ff.on('close', (code) => {
      if (code !== 0) return reject(new Error('ffmpeg exit ' + code + ': ' + err.slice(0, 300)));
      const buf = Buffer.concat(chunks);
      const samples = new Float32Array(buf.length / 4);
      for (let i = 0; i < samples.length; i++) samples[i] = buf.readFloatLE(i * 4);
      resolve({ samples, sampleRate });
    });
  });
}

// Produce an RMS loudness envelope + simple energy-onset beats.
export async function analyze(filePath) {
  const { samples, sampleRate } = await decodePcm(filePath);
  const durationMs = Math.round((samples.length / sampleRate) * 1000);
  const hop = Math.max(1, Math.round(sampleRate * 0.02)); // ~20ms hop
  const win = hop * 2;
  const rmsRaw = [];
  for (let start = 0; start < samples.length; start += hop) {
    let sum = 0; let n = 0;
    for (let i = start; i < Math.min(start + win, samples.length); i++) { sum += samples[i] * samples[i]; n++; }
    rmsRaw.push(n ? Math.sqrt(sum / n) : 0);
  }
  // ---- ROUND 11 (pt 18): rolling AGC + envelope-follower + transient (flux) emphasis, instead of
  // ONE global p95. Pro light/visualizer systems (Resolume / MadMapper / SoundSwitch) re-level the
  // CURRENT loudness between a slow-adapting floor and ceiling, so a quiet intro and a loud drop
  // drive the lights with SIMILAR amplitude — even reactivity regardless of absolute level — while a
  // min-span guard keeps true silence dark. The evened 0..1 "excitement" is baked into the cue
  // envelope at COMPILE time, so every phone still samples the same governed value (determinism +
  // sync preserved). The flash-rate safety cap (clampSafety + on-device makeBackstop) is the
  // UNTOUCHED last stage — agc_safety.mjs proves the cap holds on this amplified signal.
  const dtHop = hop / sampleRate;                      // seconds per hop (~0.02s)
  const alpha = (tau) => 1 - Math.exp(-dtHop / tau);   // one-pole coefficient for a time constant
  const aFloorUp = alpha(3.0), aFloorDn = alpha(0.15); // floor: rises SLOWLY, falls fast (tracks the quiet baseline)
  const aCeilUp = alpha(0.10), aCeilDn = alpha(1.5);   // ceiling: rises FAST (catch a hit), falls slowly
  const aAtt = alpha(0.04), aRel = alpha(0.30);        // envelope follower: fast attack, slow release ("punch then fall")
  const MIN_SPAN = 0.02;                               // guard: don't amplify near-silence to full -> silence stays dark
  let F = rmsRaw[0] || 0, C = Math.max(rmsRaw[0] || 0, 1e-4), eFollow = 0, xPrev = 0;
  const env = [], xs = [];
  for (let i = 0; i < rmsRaw.length; i++) {
    const r = rmsRaw[i];
    F += (r > F ? aFloorUp : aFloorDn) * (r - F);
    C += (r > C ? aCeilUp : aCeilDn) * (r - C);
    const span = Math.max(MIN_SPAN, C - F);
    const x = Math.min(1, Math.max(0, (r - F) / span));            // AGC-normalized loudness (even across the song)
    eFollow += (x > eFollow ? aAtt : aRel) * (x - eFollow);
    const flux = Math.min(1, Math.max(0, (x - xPrev) * 2.5));      // positive transient rise (reacts to CHANGE, not absolute level)
    const excitement = Math.min(1, Math.max(0, 0.7 * eFollow + 0.3 * flux));
    env.push({ t: Math.round((i * hop / sampleRate) * 1000), rms: excitement });
    xs.push(x); xPrev = x;
  }
  // onsets on the AGC-normalized signal so colour steps land on musical events EVENLY (not only
  // where the track is absolutely loud).
  const beats = [];
  let lastBeat = -1e9;
  for (let i = 2; i < xs.length - 1; i++) {
    const rise = xs[i] - xs[i - 2];
    if (rise > 0.18 && xs[i] > 0.45 && xs[i] >= xs[i + 1] && env[i].t - lastBeat > 180) {
      beats.push(env[i].t); lastBeat = env[i].t;
    }
  }
  return { durationMs, envelope: env, beats };
}
