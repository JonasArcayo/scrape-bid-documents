import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright';
import type { Logger } from './logger.js';
import { sanitizeFilename } from '../utils/sanitize.js';

/** Writes screenshot + HTML + reason to data/debug/<site>/<timestamp>/ on failures. */
export class DebugDumper {
  constructor(
    private readonly debugDir: string,
    private readonly logger: Logger,
  ) {}

  /** Best-effort: never throws (the page may already be closed). Returns the directory. */
  async dump(site: string, page: Page, reason: string): Promise<string | undefined> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = path.join(this.debugDir, sanitizeFilename(site), stamp);
    try {
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, 'reason.txt'), `${reason}\n${page.url()}\n`);
      await page
        .screenshot({ path: path.join(dir, 'page.png'), fullPage: true })
        .catch(() => undefined);
      await fsp.writeFile(path.join(dir, 'page.html'), await page.content()).catch(() => undefined);
      this.logger.warn({ site, dir }, 'saved debug dump');
      return dir;
    } catch (err) {
      this.logger.warn({ site, err }, 'could not write debug dump');
      return undefined;
    }
  }
}
