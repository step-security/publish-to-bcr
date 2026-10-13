import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { extractZipEntry, ZipEntryNotRegularFileError } from './unzip';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (const byte of data) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
  name: string;
  content: string;
  /** Unix file mode, e.g. 0o120777 for a symlink */
  mode: number;
}

/** Builds a zip archive (stored, no compression) made on a unix host. */
function buildZip(entries: ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const { name, content, mode } of entries) {
    const nameBuf = Buffer.from(name);
    const data = Buffer.from(content);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    localParts.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...localParts, centralDir, end]);
}

const FILE = 0o100644;
const SYMLINK = 0o120777;

let workDir: string;
let zipPath: string;
let outDir: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unzip-spec-'));
  zipPath = path.join(workDir, 'test.zip');
  outDir = path.join(workDir, 'out');
  fs.mkdirSync(outDir);
});

afterEach(() => {
  fs.rmSync(workDir, { force: true, recursive: true });
});

describe('extractZipEntry', () => {
  test('extracts the requested entry and nothing else', async () => {
    fs.writeFileSync(
      zipPath,
      buildZip([
        { name: 'rules-foo/README.md', content: 'readme', mode: FILE },
        { name: 'rules-foo/MODULE.bazel', content: 'module()', mode: FILE },
        { name: 'rules-foo/BUILD', content: 'build', mode: FILE },
      ])
    );
    const dest = path.join(outDir, 'rules-foo', 'MODULE.bazel');

    const found = await extractZipEntry(
      zipPath,
      'rules-foo/MODULE.bazel',
      dest
    );

    expect(found).toBe(true);
    expect(fs.readFileSync(dest, 'utf8')).toEqual('module()');
    expect(fs.readdirSync(path.join(outDir, 'rules-foo'))).toEqual([
      'MODULE.bazel',
    ]);
  });

  test('matches entries that are prefixed with ./', async () => {
    fs.writeFileSync(
      zipPath,
      buildZip([{ name: './MODULE.bazel', content: 'module()', mode: FILE }])
    );
    const dest = path.join(outDir, 'MODULE.bazel');

    expect(await extractZipEntry(zipPath, 'MODULE.bazel', dest)).toBe(true);
    expect(fs.readFileSync(dest, 'utf8')).toEqual('module()');
  });

  test('returns false when the entry is not in the archive', async () => {
    fs.writeFileSync(
      zipPath,
      buildZip([{ name: 'other/MODULE.bazel', content: 'x', mode: FILE }])
    );
    const dest = path.join(outDir, 'MODULE.bazel');

    expect(await extractZipEntry(zipPath, 'MODULE.bazel', dest)).toBe(false);
    expect(fs.existsSync(dest)).toBe(false);
  });

  test('rejects a symlink entry without writing anything', async () => {
    fs.writeFileSync(
      zipPath,
      buildZip([
        { name: 'MODULE.bazel', content: '/etc/passwd', mode: SYMLINK },
      ])
    );
    const dest = path.join(outDir, 'MODULE.bazel');

    await expect(
      extractZipEntry(zipPath, 'MODULE.bazel', dest)
    ).rejects.toThrow(ZipEntryNotRegularFileError);
    expect(fs.existsSync(dest)).toBe(false);
  });

  test('ignores symlink entries that are not the requested one', async () => {
    fs.writeFileSync(
      zipPath,
      buildZip([
        { name: 'link', content: '../../etc', mode: SYMLINK },
        { name: 'MODULE.bazel', content: 'module()', mode: FILE },
      ])
    );
    const dest = path.join(outDir, 'MODULE.bazel');

    expect(await extractZipEntry(zipPath, 'MODULE.bazel', dest)).toBe(true);
    expect(fs.existsSync(path.join(outDir, 'link'))).toBe(false);
  });

  test('does not write through an existing symlink at the destination', async () => {
    fs.writeFileSync(
      zipPath,
      buildZip([{ name: 'MODULE.bazel', content: 'module()', mode: FILE }])
    );
    const target = path.join(workDir, 'outside');
    const dest = path.join(outDir, 'MODULE.bazel');
    fs.symlinkSync(target, dest);

    await expect(
      extractZipEntry(zipPath, 'MODULE.bazel', dest)
    ).rejects.toThrow();
    expect(fs.existsSync(target)).toBe(false);
  });
});
