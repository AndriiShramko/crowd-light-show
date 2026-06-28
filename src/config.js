import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// Operator password is provided hashed (scrypt) via OPERATOR_PASS_HASH = "salt:hash".
// For local dev a plaintext OPERATOR_PASS may be given and is hashed on boot.
function deriveHashFromPlain(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(plain, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

const plain = process.env.OPERATOR_PASS;
let passHash = process.env.OPERATOR_PASS_HASH || '';
if (!passHash && plain) passHash = deriveHashFromPlain(plain);
if (!passHash) {
  // Dev fallback so the app boots; logged loudly. Never use in production.
  passHash = deriveHashFromPlain('changeme-dev');
}

export const config = {
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '0.0.0.0',
  dataDir: process.env.DATA_DIR || path.join(root, 'data'),
  publicDir: path.join(root, 'public'),
  // Public base URL used to build the join/QR URL (no trailing slash).
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, ''),
  operatorPassHash: passHash,
  operatorPassIsDev: !process.env.OPERATOR_PASS_HASH && !process.env.OPERATOR_PASS,
  // HMAC secret for operator session tokens.
  sessionSecret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
  // Optional Telegram notification for new lead/applications (owner DM).
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES || 50 * 1024 * 1024),
  maxTracksPerShow: Number(process.env.MAX_TRACKS || 10),
  uploadsBudgetBytes: Number(process.env.UPLOADS_BUDGET || 2 * 1024 * 1024 * 1024),
  diskGuardMinBytes: Number(process.env.DISK_GUARD_MIN || 2 * 1024 * 1024 * 1024),
  // Timeline / safety governor parameters.
  cueFps: 25,
  maxFlashesPerSec: 3, // WCAG 2.3.2 hard cap
  minRampMs: 150, // minimum ramp for large luminance changes
  startLeadMs: 900, // T0 scheduled this far in the future
  // Studio (live presets + landing demo). Master kill-switch for the new code path
  // (red-team "?next" dormancy): set STUDIO_ENABLED=0 to put it fully to sleep on
  // prod without a redeploy — endpoints 503, landing CTA hidden, audience unaffected.
  studioEnabled: process.env.STUDIO_ENABLED !== '0',
  // Per-phone synchronized audio (opt-in "play the music on my phone too"). Gated on
  // the armed track being license-attested (bigger public-performance footprint than
  // one PA). Set CROWD_AUDIO_ENABLED=0 to disable. Honest scope: small/medium venue.
  crowdAudioEnabled: process.env.CROWD_AUDIO_ENABLED !== '0',
  // Capacity guard: refuse new audience past this with a graceful "venue full" so the
  // single process degrades instead of OOM-killing the container at stadium scale.
  maxAudience: Number(process.env.MAX_AUDIENCE || 1500),
};

export function scryptVerify(plainPass, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const cand = crypto.scryptSync(plainPass, salt, 32).toString('hex');
  // constant-time compare
  const a = Buffer.from(cand, 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
