// ROUND 12 — pts 1 + 5. The /try demo (/join?demo=1) must (1) OFFER the "Join + flashlight" button on
// a torch-capable device whose UA doesn't literally say "Android" (e.g. a Lenovo tablet) and (2) actually
// DRIVE the camera-LED torch channel — before, the demo only flashed the screen and the torch never fired
// (torchPreset stayed null because the demo never carried a torch preset). Headless has no real LED, so we
// verify the CHANNEL is populated + driven (gated <=3/s); real LED needs a real phone.
import { chromium, devices } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE || 'http://localhost:3060';
const PASS = process.env.OPERATOR_PASS || 'test-pass-123';
const dir = path.dirname(fileURLToPath(import.meta.url));
const j = (r) => r.json();
const H = (t, e) => ({ Authorization: 'Bearer ' + t, ...(e || {}) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
const check = (n, ok, d) => { console.log(`${ok ? 'OK  ' : 'FAIL'} [${n}] ${d || ''}`); if (!ok) fails.push(n + (d ? ': ' + d : '')); };

async function main() {
  // ensure there is a demo track so the demo has music too (not required for torch, but realistic)
  const token = (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASS }) }).then(j)).token;
  let st = await fetch(BASE + '/api/operator/state', { headers: H(token) }).then(j);
  let tr = (st.tracks || []).find((t) => t.analysis_status === 'done');
  if (!tr) { const fd = new FormData(); fd.append('audio', new Blob([fs.readFileSync(path.join(dir, '..', 'fixtures', 'tone_2hz.wav'))]), 'tone_2hz.wav'); await fetch(BASE + '/api/operator/upload', { method: 'POST', headers: H(token), body: fd }).then(j); st = await fetch(BASE + '/api/operator/state', { headers: H(token) }).then(j); tr = st.tracks.find((t) => t.analysis_status === 'done'); }
  if (tr) { await fetch(BASE + `/api/operator/track/${tr.id}/attest`, { method: 'POST', headers: H(token) }).then(j); await fetch(BASE + `/api/operator/track/${tr.id}/public`, { method: 'POST', headers: H(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ is_public: true }) }).then(j); }

  // the /api/demo response now carries a validated torch preset (pt 5)
  const demo = await fetch(BASE + '/api/demo').then(j);
  check('demo_serves_torch', !!(demo.torch && demo.torch.type && typeof demo.torch.startedAt === 'number'), 'demo.torch=' + JSON.stringify(demo.torch));

  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });

  // ---- pt 1: a NON-Android touch tablet still gets the "Join + flashlight" button ----
  const tablet = await b.newContext({ hasTouch: true, isMobile: true, userAgent: 'Mozilla/5.0 (Linux; U; Tablet; LenovoTB132FU) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36' });
  const tp = await tablet.newPage();
  await tp.goto(`${BASE}/join?demo=1`);
  await tp.waitForTimeout(500);
  const tabletBtn = await tp.evaluate(() => { const e = document.getElementById('joinTorch'); return e ? !e.classList.contains('hidden') : false; });
  check('torch_button_on_tablet', tabletBtn, 'a non-"Android"-UA touch tablet is offered the flashlight join');

  // a desktop (no touch, fine pointer) must NOT be offered it
  const desk = await b.newContext({ hasTouch: false, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36' });
  const dp = await desk.newPage();
  await dp.goto(`${BASE}/join?demo=1`);
  await dp.waitForTimeout(400);
  const deskBtn = await dp.evaluate(() => { const e = document.getElementById('joinTorch'); return e ? !e.classList.contains('hidden') : false; });
  check('torch_button_hidden_desktop', !deskBtn, 'desktop (no touch) is NOT offered the flashlight join');

  // ---- pt 5: the demo actually DRIVES the torch channel ----
  const ph = await (await b.newContext({ hasTouch: true, isMobile: true })).newPage();
  await ph.goto(`${BASE}/join?demo=1&auto=1`);
  await ph.waitForFunction(() => window.__cls && window.__cls.synced, { timeout: 15000 }).catch(() => {});
  await ph.waitForFunction(() => window.__cls && window.__cls.torch && window.__cls.torch.preset, { timeout: 8000 }).catch(() => {});
  // sample the torch channel intent over ~3s: it must actually toggle (be driven), and never exceed 3/s
  const samples = [];
  for (let i = 0; i < 36; i++) { samples.push(await ph.evaluate(() => ({ want: window.__cls.torch.want | 0, preset: window.__cls.torch.preset, t: Date.now ? 0 : 0 }))); await sleep(90); }
  const preset = samples[samples.length - 1].preset;
  let flips = 0; for (let i = 1; i < samples.length; i++) if (samples[i].want !== samples[i - 1].want) flips++;
  const onSome = samples.some((s) => s.want === 1);
  check('demo_torch_preset_set', !!preset, 'phone torch preset on demo = ' + preset);
  check('demo_torch_channel_driven', onSome && flips >= 2, `torch channel toggled (on-samples=${samples.filter((s) => s.want).length}, flips=${flips}) — the LED is actually commanded, not stuck off`);
  // safety: the gated channel never exceeds ~3 flashes/s (each flash = 2 flips). Over ~3.2s, <= ~10 on-edges.
  let onEdges = 0; for (let i = 1; i < samples.length; i++) if (samples[i].want === 1 && samples[i - 1].want === 0) onEdges++;
  check('demo_torch_gated_safe', onEdges <= 11, `torch on-edges over ~3.2s = ${onEdges} (<=3/s governor holds on the demo too)`);

  await b.close();
  fs.writeFileSync(path.join(dir, '..', 'torch_demo_report.json'), JSON.stringify({ base: BASE, demoTorch: demo.torch, preset, flips, fails }, null, 2));
  if (fails.length) { console.error('TORCH DEMO FAIL: ' + fails.join('; ')); process.exit(1); }
  console.log('TORCH DEMO PASS: /try offers the flashlight join on a non-Android touch tablet, the demo serves a validated torch preset, and the torch channel is actually driven (gated <=3/s). Real LED = needs a real phone.');
}
main().catch((e) => { console.error(e); process.exit(1); });
