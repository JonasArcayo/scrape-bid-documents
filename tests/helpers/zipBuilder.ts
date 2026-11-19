import zlib from 'node:zlib';

export interface TestEntry {
  name: string;
  data?: Buffer;
  method?: 'store' | 'deflate';
  symlink?: boolean;
  encrypted?: boolean;
}

const TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = (TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Build a ZIP archive in memory, allowing deliberately malicious entry names/attrs. */
export function buildZip(entries: TestEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = e.data ?? Buffer.alloc(0);
    const deflate = (e.method ?? 'deflate') === 'deflate' && raw.length > 0;
    const body = deflate ? zlib.deflateRawSync(raw) : raw;
    const name = Buffer.from(e.name);
    const flags = e.encrypted ? 1 : 0;
    const method = deflate ? 8 : 0;
    const crc = crc32(raw);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(flags, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(name.length, 26);
    const local = Buffer.concat([lh, name, body]);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE((3 << 8) | 20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(flags, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(name.length, 28);
    const mode = e.name.endsWith('/') ? 0o040755 : e.symlink ? 0o120777 : 0o100644;
    ch.writeUInt32LE((mode << 16) >>> 0, 38);
    ch.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([ch, name]));
    locals.push(local);
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
