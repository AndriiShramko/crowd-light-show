// Minimal, zero-dependency OSC 1.0 codec for the VJ bridge (UDP payloads from Resolume / TouchOSC /
// Companion / Chataigne). The wire format is dead simple: a null-terminated, 4-byte-padded OSC-string
// address; a ','-prefixed OSC-string type tag; then big-endian 4-byte args. We support the arg types a
// VJ controller actually emits — i (int32), f (float32), s (string) — plus the no-data types T/F/N/I.
// Spec: https://opensoundcontrol.stanford.edu/spec-1_0.html

const pad4 = (n) => (n + 3) & ~3;

export function decode(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  let o = 0;
  function readStr() {
    let end = o; while (end < buf.length && buf[end] !== 0) end++;
    const s = buf.toString('utf8', o, end);
    o = pad4(end + 1); // step past the null + alignment padding
    return s;
  }
  const address = readStr();
  if (address[0] !== '/') throw new Error('OSC: address must start with "/"');
  let types = '';
  if (o < buf.length && buf[o] === 0x2c /* ',' */) types = readStr().slice(1);
  const args = [];
  for (const t of types) {
    if (t === 'i') { args.push(buf.readInt32BE(o)); o += 4; }
    else if (t === 'f') { args.push(buf.readFloatBE(o)); o += 4; }
    else if (t === 's') { args.push(readStr()); }
    else if (t === 'T') args.push(true);
    else if (t === 'F') args.push(false);
    else if (t === 'N') args.push(null);
    else if (t === 'I') args.push(Infinity);
    else throw new Error('OSC: unsupported type tag "' + t + '"'); // can't know its length -> bail
  }
  return { address, types, args };
}

// encode(address, [{ type:'s'|'i'|'f', value }, ...]) -> Buffer. Types can also be inferred from the
// value if `type` is omitted (number->f, integer-with-int hint->i, string->s).
export function encode(address, args) {
  args = args || [];
  function ostr(s) { const b = Buffer.from(String(s), 'utf8'); const len = pad4(b.length + 1); const out = Buffer.alloc(len); b.copy(out); return out; }
  let tags = ',';
  const parts = [];
  for (const a of args) {
    const type = a.type || (typeof a.value === 'string' ? 's' : (Number.isInteger(a.value) && a.intHint ? 'i' : 'f'));
    if (type === 'i') { tags += 'i'; const b = Buffer.alloc(4); b.writeInt32BE(a.value | 0, 0); parts.push(b); }
    else if (type === 'f') { tags += 'f'; const b = Buffer.alloc(4); b.writeFloatBE(+a.value, 0); parts.push(b); }
    else if (type === 's') { tags += 's'; parts.push(ostr(a.value)); }
    else throw new Error('OSC encode: unsupported type ' + type);
  }
  return Buffer.concat([ostr(address), ostr(tags), ...parts]);
}
