import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import type { DetectedType } from './models.js';
import { CorruptArchiveError, ZipSafetyError } from './errors.js';
import { hasZipMagic, ooxmlType, sniffType } from '../utils/fileType.js';
import { sanitizeFilename, withHashSuffix } from '../utils/sanitize.js';
import { createHash } from 'node:crypto';

/** Safety limits shared across an archive and everything nested inside it. */
export interface ZipLimits {
  /** Max total uncompressed bytes (all nesting levels combined). */
  maxTotalBytes: number;
  /** Max total entries (all nesting levels combined). */
  maxEntries: number;
  /** Max per-entry uncompressed:compressed ratio. */
  maxRatio: number;
  /** Nested archive levels extracted beyond the top-level archive. */
  maxDepth: number;
}

export interface ExtractedFile {
  /** POSIX path relative to the extraction root. */
  relPath: string;
  absPath: string;
  size: number;
}

export interface ExtractResult {
  /** 'needs_password' when any entry was encrypted (those entries are skipped). */
  outcome: 'extracted' | 'needs_password';
  files: ExtractedFile[];
  /** Entries skipped for safety (symlinks, absolute paths). */
  skippedEntries: string[];
  encryptedEntries: string[];
  /** Nested archives left unextracted (depth limit reached or unreadable). */
  nestedSkipped: string[];
}

/** Ratio checks only apply once an entry exceeds this many bytes (avoids tiny-file false positives). */
const RATIO_MIN_BYTES = 64 * 1024;

const openZip = (p: string): Promise<yauzl.ZipFile> =>
  new Promise((resolve, reject) => {
    yauzl.open(p, { lazyEntries: true, decodeStrings: false, autoClose: false }, (err, zip) =>
      err || !zip ? reject(err ?? new Error('open failed')) : resolve(zip),
    );
  });

const nextEntry = (zip: yauzl.ZipFile): Promise<yauzl.Entry | null> =>
  new Promise((resolve, reject) => {
    const cleanup = () => {
      zip.off('entry', onEntry);
      zip.off('end', onEnd);
      zip.off('error', onErr);
    };
    const onEntry = (e: yauzl.Entry) => (cleanup(), resolve(e));
    const onEnd = () => (cleanup(), resolve(null));
    const onErr = (e: Error) => (cleanup(), reject(e));
    zip.once('entry', onEntry);
    zip.once('end', onEnd);
    zip.once('error', onErr);
    zip.readEntry();
  });

const openStream = (zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<NodeJS.ReadableStream> =>
  new Promise((resolve, reject) =>
    zip.openReadStream(entry, (err, s) =>
      err || !s ? reject(err ?? new Error('no stream')) : resolve(s),
    ),
  );

function entryName(entry: yauzl.Entry): string {
  const raw: unknown = entry.fileName;
  return Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
}

const isSymlink = (e: yauzl.Entry): boolean =>
  e.versionMadeBy >> 8 === 3 && ((e.externalFileAttributes >>> 16) & 0o170000) === 0o120000;

/**
 * Classify a ZIP container precisely using its central directory, so docx/xlsx/pptx
 * are not mistaken for archives. Falls back to a generic zip on read errors.
 */
async function classifyZip(file: string): Promise<DetectedType> {
  const generic = sniffType(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  let zip: yauzl.ZipFile | undefined;
  try {
    zip = await openZip(file);
    const names = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const e = await nextEntry(zip);
      if (!e) break;
      names.add(entryName(e));
    }
    if (names.has('[Content_Types].xml')) {
      if (names.has('word/document.xml')) return ooxmlType('docx') ?? generic;
      if (names.has('xl/workbook.xml')) return ooxmlType('xlsx') ?? generic;
      if (names.has('ppt/presentation.xml')) return ooxmlType('pptx') ?? generic;
    }
    return generic;
  } catch {
    return generic;
  } finally {
    zip?.close();
  }
}

/** Sniff a file's real type from its bytes (refining ZIP containers via the central directory). */
export async function detectFileType(file: string): Promise<DetectedType> {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const head = buf.subarray(0, bytesRead);
    return hasZipMagic(head) ? await classifyZip(file) : sniffType(head);
  } finally {
    await fh.close();
  }
}

interface Budget {
  bytes: number;
  entries: number;
}
interface Ctx {
  limits: ZipLimits;
  budget: Budget;
  root: string;
  result: ExtractResult;
}

async function extractLevel(
  zipPath: string,
  destDir: string,
  depth: number,
  ctx: Ctx,
): Promise<void> {
  const { limits, budget } = ctx;
  let zip: yauzl.ZipFile;
  try {
    zip = await openZip(zipPath);
  } catch (err) {
    throw new CorruptArchiveError(`Cannot open archive ${path.basename(zipPath)}`, { cause: err });
  }
  const written: ExtractedFile[] = [];
  try {
    if (budget.entries + zip.entryCount > limits.maxEntries) {
      throw new ZipSafetyError(
        `Archive declares ${zip.entryCount} entries; limit ${limits.maxEntries}`,
      );
    }
    await fsp.mkdir(destDir, { recursive: true });
    for (;;) {
      const entry = await nextEntry(zip);
      if (!entry) break;
      const name = entryName(entry);
      const norm = name.replace(/\\/g, '/');
      if (++budget.entries > limits.maxEntries) {
        throw new ZipSafetyError(`Entry count exceeds ${limits.maxEntries}`);
      }
      if (name.includes('\0')) throw new ZipSafetyError(`NUL byte in entry name`);
      if (norm.startsWith('/') || /^[A-Za-z]:/.test(norm)) {
        ctx.result.skippedEntries.push(name);
        continue;
      }
      const segments = norm.split('/');
      if (segments.includes('..')) throw new ZipSafetyError(`Path traversal in entry: ${name}`);
      if (isSymlink(entry)) {
        ctx.result.skippedEntries.push(name);
        continue;
      }
      const clean = segments.filter((s) => s !== '' && s !== '.').map((s) => sanitizeFilename(s));
      if (clean.length === 0) continue;
      let abs = path.resolve(destDir, ...clean);
      if (!abs.startsWith(path.resolve(destDir) + path.sep)) {
        throw new ZipSafetyError(`Entry escapes destination: ${name}`);
      }
      if (norm.endsWith('/')) {
        await fsp.mkdir(abs, { recursive: true });
        continue;
      }
      if (entry.isEncrypted()) {
        ctx.result.encryptedEntries.push(norm);
        continue;
      }
      if (budget.bytes + entry.uncompressedSize > limits.maxTotalBytes) {
        throw new ZipSafetyError(`Declared size exceeds total byte limit ${limits.maxTotalBytes}`);
      }
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      if (fs.existsSync(abs)) {
        const h = createHash('sha256').update(norm).digest('hex');
        abs = path.join(path.dirname(abs), withHashSuffix(path.basename(abs), h));
      }
      let size = 0;
      const guard = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          size += chunk.length;
          budget.bytes += chunk.length;
          if (budget.bytes > limits.maxTotalBytes) {
            return cb(new ZipSafetyError(`Total extracted bytes exceed ${limits.maxTotalBytes}`));
          }
          if (
            size > RATIO_MIN_BYTES &&
            size > limits.maxRatio * Math.max(entry.compressedSize, 1)
          ) {
            return cb(new ZipSafetyError(`Compression ratio exceeds ${limits.maxRatio}: ${name}`));
          }
          cb(null, chunk);
        },
      });
      const src = await openStream(zip, entry);
      await pipeline(src, guard, fs.createWriteStream(abs));
      written.push({
        relPath: path.relative(ctx.root, abs).split(path.sep).join('/'),
        absPath: abs,
        size,
      });
    }
  } catch (err) {
    if (err instanceof ZipSafetyError) throw err;
    throw new CorruptArchiveError(
      `Corrupt archive ${path.basename(zipPath)}: ${(err as Error).message}`,
      {
        cause: err,
      },
    );
  } finally {
    zip.close();
  }

  ctx.result.files.push(...written);
  for (const f of written) {
    const type = await detectFileType(f.absPath);
    if (!type.isZip) continue;
    if (depth >= limits.maxDepth) {
      ctx.result.nestedSkipped.push(f.relPath);
      continue;
    }
    const nestedDir = path.join(path.dirname(f.absPath), `${path.parse(f.absPath).name}_extracted`);
    try {
      await extractLevel(f.absPath, nestedDir, depth + 1, ctx);
    } catch (err) {
      if (err instanceof CorruptArchiveError) ctx.result.nestedSkipped.push(f.relPath);
      else throw err;
    }
  }
}

/**
 * Safely extract a ZIP into `destDir`. Guards: zip-slip, absolute paths and symlinks
 * skipped, entry-count / total-bytes / compression-ratio limits enforced while streaming,
 * nested archives up to `limits.maxDepth`. Encrypted entries are skipped and reported
 * (yauzl cannot decrypt). On any safety/corruption error `destDir` is removed.
 * @throws ZipSafetyError | CorruptArchiveError
 */
export async function extractArchive(
  zipPath: string,
  destDir: string,
  opts: { limits: ZipLimits },
): Promise<ExtractResult> {
  const root = path.resolve(destDir);
  const ctx: Ctx = {
    limits: opts.limits,
    budget: { bytes: 0, entries: 0 },
    root,
    result: {
      outcome: 'extracted',
      files: [],
      skippedEntries: [],
      encryptedEntries: [],
      nestedSkipped: [],
    },
  };
  try {
    await extractLevel(zipPath, root, 0, ctx);
  } catch (err) {
    await fsp.rm(root, { recursive: true, force: true });
    throw err;
  }
  if (ctx.result.encryptedEntries.length > 0) ctx.result.outcome = 'needs_password';
  return ctx.result;
}
