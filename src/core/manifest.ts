import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { DocStatus, ManifestInsert, ManifestRow } from './models.js';
import { ALL_STATUSES } from './models.js';

type Fields = Partial<
  Pick<
    ManifestInsert,
    'url' | 'title' | 'sourcePageUrl' | 'sha256' | 'size' | 'type' | 'storageKey'
  >
>;

interface DbRow {
  id: number;
  site: string;
  key: string;
  url: string | null;
  title: string | null;
  source_page_url: string | null;
  sha256: string | null;
  size: number | null;
  type: string | null;
  storage_key: string | null;
  status: DocStatus;
  parent_id: number | null;
  error: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
}

const toRow = (r: DbRow): ManifestRow => ({
  id: r.id,
  site: r.site,
  key: r.key,
  url: r.url,
  title: r.title,
  sourcePageUrl: r.source_page_url,
  sha256: r.sha256,
  size: r.size,
  type: r.type,
  storageKey: r.storage_key,
  status: r.status,
  parentId: r.parent_id,
  error: r.error,
  attempts: r.attempts,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** Statuses after which a document is not re-attempted on later runs. */
const TERMINAL: readonly DocStatus[] = [
  'downloaded',
  'duplicate',
  'extracted',
  'needs_password',
  'failed_extract',
];

/** SQLite-backed record of every document: namespaced per site, deduped by key and sha256. */
export class Manifest {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:')
      fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        site TEXT NOT NULL,
        key TEXT NOT NULL,
        url TEXT, title TEXT, source_page_url TEXT,
        sha256 TEXT, size INTEGER, type TEXT, storage_key TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        parent_id INTEGER REFERENCES documents(id),
        error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        UNIQUE (site, key)
      );
      CREATE INDEX IF NOT EXISTS idx_documents_sha ON documents(sha256);
      CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(site, status);
    `);
  }

  /** Insert or update a row by (site, key); null fields never overwrite existing values. */
  upsert(site: string, key: string, f: Fields): ManifestRow {
    this.db
      .prepare(
        `INSERT INTO documents (site, key, url, title, source_page_url)
         VALUES (@site, @key, @url, @title, @sourcePageUrl)
         ON CONFLICT(site, key) DO UPDATE SET
           url = COALESCE(excluded.url, url),
           title = COALESCE(excluded.title, title),
           source_page_url = COALESCE(excluded.source_page_url, source_page_url),
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
      )
      .run({
        site,
        key,
        url: f.url ?? null,
        title: f.title ?? null,
        sourcePageUrl: f.sourcePageUrl ?? null,
      });
    const row = this.find(site, key);
    if (!row) throw new Error('upsert failed');
    return row;
  }

  find(site: string, key: string): ManifestRow | undefined {
    const r = this.db
      .prepare('SELECT * FROM documents WHERE site = ? AND key = ?')
      .get(site, key) as DbRow | undefined;
    return r && toRow(r);
  }

  /** Canonical (non-duplicate) row holding this content hash, across all sites. */
  findBySha(sha256: string): ManifestRow | undefined {
    const r = this.db
      .prepare(
        "SELECT * FROM documents WHERE sha256 = ? AND status NOT IN ('duplicate','failed') ORDER BY id LIMIT 1",
      )
      .get(sha256) as DbRow | undefined;
    return r && toRow(r);
  }

  /**
   * Atomically claim a content hash for `id`. Returns the canonical row if another
   * document already holds it (caller should mark `id` a duplicate); otherwise records
   * the hash on `id` so concurrent twins see the claim. Safe across concurrent pipelines
   * because better-sqlite3 is synchronous.
   */
  claimSha(id: number, sha256: string): { duplicateOf?: ManifestRow } {
    return this.db.transaction(() => {
      const other = this.db
        .prepare(
          "SELECT * FROM documents WHERE sha256 = ? AND id != ? AND status NOT IN ('duplicate','failed') ORDER BY id LIMIT 1",
        )
        .get(sha256, id) as DbRow | undefined;
      if (other) return { duplicateOf: toRow(other) };
      this.db.prepare('UPDATE documents SET sha256 = ? WHERE id = ?').run(sha256, id);
      return {};
    })();
  }

  /** True if this document finished previously and should not be re-attempted. */
  shouldSkip(site: string, key: string): boolean {
    const row = this.find(site, key);
    return row !== undefined && TERMINAL.includes(row.status);
  }

  markStatus(id: number, status: DocStatus, error?: string): void {
    const bump = status === 'failed' || status === 'failed_extract' ? 1 : 0;
    this.db
      .prepare(
        `UPDATE documents SET status = ?, error = ?, attempts = attempts + ?,
         sha256 = CASE WHEN ? = 'failed' AND storage_key IS NULL THEN NULL ELSE sha256 END,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
      )
      .run(status, error ?? null, bump, status, id);
  }

  /** Record a finished download: sets hash/size/type/storage key and status 'downloaded'. */
  recordDownload(
    id: number,
    d: { sha256: string; size: number; type: string; storageKey: string },
  ): void {
    this.db
      .prepare(
        `UPDATE documents SET sha256 = ?, size = ?, type = ?, storage_key = ?, status = 'downloaded',
         error = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
      )
      .run(d.sha256, d.size, d.type, d.storageKey, id);
  }

  /** Insert a row for a file extracted from an archive. */
  insertChild(parentId: number, site: string, key: string, f: Fields): ManifestRow {
    this.db
      .prepare(
        `INSERT INTO documents (site, key, url, title, source_page_url, sha256, size, type, storage_key, status, parent_id)
         VALUES (@site, @key, @url, @title, @sourcePageUrl, @sha256, @size, @type, @storageKey, 'downloaded', @parentId)
         ON CONFLICT(site, key) DO UPDATE SET sha256 = excluded.sha256, size = excluded.size,
           type = excluded.type, storage_key = excluded.storage_key, status = 'downloaded',
           parent_id = excluded.parent_id, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
      )
      .run({
        site,
        key,
        url: f.url ?? null,
        title: f.title ?? null,
        sourcePageUrl: f.sourcePageUrl ?? null,
        sha256: f.sha256 ?? null,
        size: f.size ?? null,
        type: f.type ?? null,
        storageKey: f.storageKey ?? null,
        parentId,
      });
    const row = this.find(site, key);
    if (!row) throw new Error('insertChild failed');
    return row;
  }

  stats(site?: string): Record<DocStatus, number> {
    const out = Object.fromEntries(ALL_STATUSES.map((s) => [s, 0])) as Record<DocStatus, number>;
    const rows = (
      site
        ? this.db
            .prepare('SELECT status, COUNT(*) n FROM documents WHERE site = ? GROUP BY status')
            .all(site)
        : this.db.prepare('SELECT status, COUNT(*) n FROM documents GROUP BY status').all()
    ) as { status: DocStatus; n: number }[];
    for (const r of rows) out[r.status] = r.n;
    return out;
  }

  listFailed(site: string): ManifestRow[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM documents WHERE site = ? AND status IN ('failed','failed_extract') ORDER BY id",
        )
        .all(site) as DbRow[]
    ).map(toRow);
  }

  /** Flush WAL and close. */
  close(): void {
    this.db.close();
  }
}
