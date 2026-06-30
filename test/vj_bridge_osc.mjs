// ROUND 14 — the hand-rolled OSC codec the VJ bridge depends on. Round-trip encode->decode for the
// message shapes a VJ controller emits, check 4-byte padding edge cases, and assert the exact big-endian
// float bytes for a known value (so the wire format matches the OSC 1.0 spec, not just itself).
import test from 'node:test';
import assert from 'node:assert/strict';
import { encode, decode } from '../tools/vj-bridge/osc.mjs';

test('round-trips /cls/* messages (s, f, i, multi-arg)', () => {
  const cases = [
    { a: '/cls/preset', args: [{ type: 's', value: 'rainbow_chase' }] },
    { a: '/cls/manual/hue', args: [{ type: 'f', value: 0.5 }] },
    { a: '/cls/seek', args: [{ type: 'f', value: 12345 }] },
    { a: '/cls/blackout', args: [] },
    { a: '/cls/palette', args: [{ type: 's', value: 'e30613,ffffff,0000ff' }] },
    { a: '/cls/fx', args: [{ type: 's', value: 'salute' }, { type: 'f', value: 1 }] },
  ];
  for (const c of cases) {
    const d = decode(encode(c.a, c.args));
    assert.equal(d.address, c.a);
    assert.equal(d.args.length, c.args.length);
    for (let i = 0; i < c.args.length; i++) {
      if (c.args[i].type === 'f') assert.ok(Math.abs(d.args[i] - c.args[i].value) < 1e-3, `${c.a} float arg`);
      else assert.equal(d.args[i], c.args[i].value, `${c.a} arg ${i}`);
    }
  }
});

test('4-byte alignment holds for 1-, 4-, 5-, 8-char addresses', () => {
  for (const a of ['/a', '/abc', '/abcd', '/abcde', '/cls/mute', '/12345678']) {
    const buf = encode(a, [{ type: 'f', value: 0.25 }]);
    assert.equal(buf.length % 4, 0, `${a} not 4-aligned (len ${buf.length})`);
    const d = decode(buf);
    assert.equal(d.address, a);
    assert.ok(Math.abs(d.args[0] - 0.25) < 1e-6);
  }
});

test('float is encoded big-endian per the OSC 1.0 spec (440.0 -> 43 dc 00 00)', () => {
  const buf = encode('/x', [{ type: 'f', value: 440.0 }]);
  // address '/x\0\0' (4) + tags ',f\0\0' (4) + float (4) = 12 bytes; the float is the last 4
  const f = buf.slice(buf.length - 4);
  assert.equal(f.toString('hex'), '43dc0000', 'big-endian float32 of 440.0');
});

test('rejects a malformed (non-/) address', () => {
  assert.throws(() => decode(Buffer.from('nope\0\0\0\0', 'utf8')));
});

console.log('VJ OSC codec: round-trip + alignment + big-endian float + malformed-reject all asserted.');
