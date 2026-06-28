// Smoke-tests the operator console against a running server (BASE): the page loads
// behind Basic auth, the WebSocket comes online, the join QR + URL load, and there
// are no JS errors.
import { chromium } from 'playwright';
const BASE = process.env.BASE; const PASS = process.env.OPERATOR_PASS;
const b = await chromium.launch();
const ctx = await b.newContext({ httpCredentials: { username: 'operator', password: PASS } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/status of 401/.test(m.text())) errors.push('CONSOLE: ' + m.text()); });
await page.goto(BASE + '/operator');
await page.waitForTimeout(3500);
const st = await page.evaluate(() => ({
  conn: document.getElementById('conn').textContent,
  qrSet: !!document.getElementById('qr').src && document.getElementById('qr').src.length > 0,
  joinurl: document.getElementById('joinurl').textContent,
  trackRows: document.querySelectorAll('#tracks tbody tr').length,
}));
await b.close();
console.log(JSON.stringify({ st, errors }, null, 2));
const fails = [];
if (st.conn !== 'online') fails.push('WS not online (' + st.conn + ')');
if (!st.qrSet) fails.push('QR not loaded');
if (!/\/join\?s=/.test(st.joinurl)) fails.push('join url missing: ' + st.joinurl);
if (errors.length) fails.push('JS errors: ' + errors.join(' | '));
if (fails.length) { console.error('OPERATOR VERIFY FAIL:', fails.join('; ')); process.exit(1); }
console.log('OPERATOR VERIFY PASS: console loads behind auth, WS online, QR + join url loaded, no JS errors, ' + st.trackRows + ' tracks');
