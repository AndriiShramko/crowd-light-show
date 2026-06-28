// Verifies audience-client safety/behaviour against a running server (BASE):
//  - consent gate: NO flashing before the user consents + joins
//  - Wake Lock + Fullscreen are invoked on join
//  - opt-out ("Stop") stops flashing and blackens the screen (+ releases torch on a
//    real device; the camera/torch itself needs a physical Android — operator check)
import { chromium } from 'playwright';
const BASE = process.env.BASE || 'http://localhost:3000';
const code = (await fetch(BASE + '/api/public/show').then((r) => r.json())).code;
const b = await chromium.launch();
const page = await (await b.newContext()).newPage();
await page.goto(`${BASE}/join?s=${code}`); // NO auto -> consent gate active
await page.waitForTimeout(1500);
const pre = await page.evaluate(() => ({ everLit: window.__cls.everLit, flashes: window.__cls.flashes.length, started: window.__cls.started, bg: getComputedStyle(document.getElementById('flash')).backgroundColor }));
await page.check('#agree'); await page.click('#joinScreen');
await page.waitForTimeout(1800);
const post = await page.evaluate(() => ({ wake: !!window.__cls.wakeTried, fs: !!window.__cls.fsTried, started: window.__cls.started, synced: window.__cls.synced }));
await page.click('#stopbtn'); await page.waitForTimeout(400);
const left = await page.evaluate(() => ({ started: window.__cls.started, bg: getComputedStyle(document.getElementById('flash')).backgroundColor }));
await b.close();
console.log(JSON.stringify({ pre, post, left }, null, 2));
const black = (c) => c === 'rgb(0, 0, 0)' || c === 'rgba(0, 0, 0, 0)';
const fails = [];
if (pre.everLit || pre.flashes > 0 || pre.started) fails.push('flashed/started BEFORE consent');
if (!black(pre.bg)) fails.push('screen not black before consent: ' + pre.bg);
if (!post.wake) fails.push('wakeLock not invoked on join');
if (!post.fs) fails.push('fullscreen not invoked on join');
if (!post.started || !post.synced) fails.push('did not join/sync');
if (left.started || !black(left.bg)) fails.push('opt-out did not stop/blacken');
if (fails.length) { console.error('CLIENT VERIFY FAIL:', fails.join('; ')); process.exit(1); }
console.log('CLIENT VERIFY PASS: consent gate holds (no flash pre-consent), wakeLock+fullscreen invoked on join, opt-out stops + blackens');
