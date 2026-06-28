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
  // normalize to 95th percentile so quiet tracks still drive the lights
  const sortedR = [...rmsRaw].sort((a, b) => a - b);
  const p95 = sortedR[Math.floor(sortedR.length * 0.95)] || 1e-6;
  const norm = rmsRaw.map((v) => Math.min(1, v / (p95 || 1e-6)));
  // attack/release smoothing
  const env = []; let prev = 0;
  for (let i = 0; i < norm.length; i++) {
    const target = norm[i];
    const a = target > prev ? 0.6 : 0.15; // fast attack, slow release
    prev = prev + (target - prev) * a;
    env.push({ t: Math.round((i * hop / sampleRate) * 1000), rms: prev });
  }
  // energy-onset beats: local rises in normalized rms above a threshold
  const beats = [];
  let lastBeat = -1e9;
  for (let i = 2; i < norm.length - 1; i++) {
    const rise = norm[i] - norm[i - 2];
    const t = (i * hop / sampleRate) * 1000;
    if (rise > 0.18 && norm[i] > 0.45 && norm[i] >= norm[i + 1] && t - lastBeat > 180) {
      beats.push(Math.round(t)); lastBeat = t;
    }
  }
  return { durationMs, envelope: env, beats };
}
