import type { Page } from 'playwright';

/** How the core should obtain a document. Chosen per document by the adapter. */
export type DownloadSpec =
  | { kind: 'url'; url: string; headers?: Record<string, string> }
  | {
      kind: 'click';
      /** Navigate/prepare the page (e.g. open the detail page). */
      open: (page: Page) => Promise<void>;
      /** Perform the click that starts the download; wrapped in waitForEvent('download'). */
      trigger: (page: Page) => Promise<void>;
    }
  | {
      kind: 'request';
      method: 'GET' | 'POST' | 'PUT';
      url: string;
      body?: string | Record<string, unknown>;
      headers?: Record<string, string>;
    };

/** A document discovered by an adapter and handed to the core. */
export interface DocumentRef {
  /** Stable site-specific id. If omitted, core derives a key from site + url. */
  externalId?: string;
  title?: string;
  sourcePageUrl: string;
  download: DownloadSpec;
  extra?: Record<string, unknown>;
}

export type DocStatus =
  | 'pending'
  | 'downloaded'
  | 'duplicate'
  | 'extracted'
  | 'failed'
  | 'failed_extract'
  | 'needs_password';

export const ALL_STATUSES: readonly DocStatus[] = [
  'pending',
  'downloaded',
  'duplicate',
  'extracted',
  'failed',
  'failed_extract',
  'needs_password',
];

/** Result of the downloader before post-processing. */
export interface DownloadResult {
  /** Temp file path (fully written, `.part` already renamed to final tmp name). */
  tmpPath: string;
  sha256: string;
  size: number;
  /** Type sniffed from magic bytes. */
  detectedType: DetectedType;
  /** Filename suggested by the server, if any. */
  suggestedName?: string;
  finalUrl?: string;
}

export interface DetectedType {
  /** Canonical extension without dot, e.g. 'pdf', 'zip', 'docx'. */
  ext: string;
  mime: string;
  isZip: boolean;
  isHtml: boolean;
}

export interface ManifestRow {
  id: number;
  site: string;
  key: string;
  url: string | null;
  title: string | null;
  sourcePageUrl: string | null;
  sha256: string | null;
  size: number | null;
  type: string | null;
  storageKey: string | null;
  status: DocStatus;
  parentId: number | null;
  error: string | null;
  attempts: number;
  createdAt: string;
  updatedAt: string;
}

export type ManifestInsert = Omit<ManifestRow, 'id' | 'createdAt' | 'updatedAt' | 'attempts'>;

export interface SiteSummary {
  site: string;
  discovered: number;
  downloaded: number;
  duplicates: number;
  skipped: number;
  extractedFiles: number;
  failed: number;
  /** Original stored, but ZIP extraction failed (corrupt/unsafe). */
  failedExtract: number;
  needsPassword: number;
  fatal?: string;
}
