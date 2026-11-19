import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Where finished files live. The pipeline depends only on this interface, so another
 * backend (e.g. object storage) can be added without pipeline changes.
 */
export interface StorageBackend {
  /** Store the local file under `key` (relative, forward-slash). Returns its URI. */
  put(localPath: string, key: string): Promise<string>;
  exists(key: string): Promise<boolean>;
  getUri(key: string): string;
}

/** Filesystem storage rooted at a directory. */
export class LocalFsStorage implements StorageBackend {
  private readonly root: string;
  constructor(root: string) {
    this.root = path.resolve(root);
  }

  private resolveKey(key: string): string {
    if (path.isAbsolute(key)) throw new Error(`Storage key must be relative: ${key}`);
    const full = path.resolve(this.root, key);
    if (full !== this.root && !full.startsWith(this.root + path.sep)) {
      throw new Error(`Storage key escapes root: ${key}`);
    }
    return full;
  }

  async put(localPath: string, key: string): Promise<string> {
    const dest = this.resolveKey(key);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    try {
      await fs.rename(localPath, dest);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
      const part = `${dest}.part`;
      await fs.copyFile(localPath, part);
      await fs.rename(part, dest);
      await fs.unlink(localPath);
    }
    return this.getUri(key);
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fs.access(this.resolveKey(key));
      return true;
    } catch {
      return false;
    }
  }

  getUri(key: string): string {
    return pathToFileURL(this.resolveKey(key)).href;
  }

  /** Absolute filesystem path for a key (local backend only; used for extraction). */
  localPath(key: string): string {
    return this.resolveKey(key);
  }
}
