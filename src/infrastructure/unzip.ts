import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import yauzl from 'yauzl';

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const UNIX_HOST = 3;

export class ZipEntryNotRegularFileError extends Error {
  constructor(public readonly entryName: string) {
    super(`Zip entry ${entryName} is not a regular file`);
  }
}

/**
 * Extract a single file from a zip archive to `destPath`.
 *
 * Only the requested entry is read; nothing else in the archive is written to
 * disk. Symlink entries are rejected.
 *
 * @returns false if the archive has no such entry, true once it is written.
 */
export async function extractZipEntry(
  zipPath: string,
  entryName: string,
  destPath: string
): Promise<boolean> {
  const wanted = normalizeEntryName(entryName);

  const zipFile = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zf) => {
      if (err) reject(err);
      else resolve(zf);
    });
  });

  try {
    const entry = await findEntry(zipFile, wanted);
    if (!entry) {
      return false;
    }

    if (isSymlink(entry)) {
      throw new ZipEntryNotRegularFileError(entry.fileName);
    }

    const readStream = await new Promise<Readable>((resolve, reject) => {
      zipFile.openReadStream(entry, (err, stream) => {
        if (err) reject(err);
        else resolve(stream);
      });
    });

    await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
    // The 'wx' flag refuses to write through an existing file or symlink
    await pipeline(readStream, fs.createWriteStream(destPath, { flags: 'wx' }));
    return true;
  } finally {
    zipFile.close();
  }
}

function findEntry(
  zipFile: yauzl.ZipFile,
  wanted: string
): Promise<yauzl.Entry | undefined> {
  return new Promise((resolve, reject) => {
    zipFile.on('error', reject);
    zipFile.on('end', () => resolve(undefined));
    zipFile.on('entry', (entry: yauzl.Entry) => {
      if (normalizeEntryName(entry.fileName) === wanted) {
        resolve(entry);
      } else {
        zipFile.readEntry();
      }
    });
    zipFile.readEntry();
  });
}

function normalizeEntryName(name: string): string {
  return path.posix.normalize(name);
}

function isSymlink(entry: yauzl.Entry): boolean {
  const madeOnUnix = entry.versionMadeBy >> 8 === UNIX_HOST;
  const mode = entry.externalFileAttributes >>> 16;
  return madeOnUnix && (mode & S_IFMT) === S_IFLNK;
}
