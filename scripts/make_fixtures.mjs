// Generate small WAV test fixtures (no ffmpeg needed). 16-bit PCM mono @ 22050.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
fs.mkdirSync(dir, { recursive: true });
const SR = 22050;

function writeWav(name, seconds, ampFn) {
  const n = Math.floor(SR * seconds);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const carrier = Math.sin(2 * Math.PI * 440 * t);
    let s = carrier * ampFn(t);
    s = Math.max(-1, Math.min(1, s));
    data.writeInt16LE((s * 32767) | 0, i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(SR, 24); header.writeUInt32LE(SR * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(path.join(dir, name), Buffer.concat([header, data]));
  console.log('wrote', name, (data.length / 1024).toFixed(0) + 'KB');
}

const pulse = (t, hz) => Math.pow(Math.max(0, Math.sin(2 * Math.PI * hz * t)), 6);
writeWav('tone_flat.wav', 6, () => 0.6);                    // steady -> few cues
writeWav('tone_2hz.wav', 6, (t) => 0.05 + 0.95 * pulse(t, 2));  // beats 2/s -> many cues
writeWav('strobe_10hz.wav', 4, (t) => 0.05 + 0.95 * pulse(t, 10)); // 10/s -> must be clamped to <=3/s
