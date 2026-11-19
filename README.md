# scrape-bid-documents

Multi-site Playwright document scraper (TypeScript, Node 20+, ESM, strict).

A flow-agnostic **core** downloads, validates, extracts, dedups, stores and tracks documents.
Per-site **adapters** only implement navigation (login, search, pagination...) and emit
`DocumentRef`s. Adding a site never touches the core.

## Setup

```bash
npm install
npx playwright install chromium
cp .env.example .env        # fill in credentials for the sites you run
npm run check               # typecheck + lint + tests
```

## CLI

```bash
npm run dev -- list                                  # registered sites
npm run dev -- run --site bidlocker --limit 50       # one or many (--site a --site b)
npm run dev -- run --all --headed
npm run dev -- stats [--site bidlocker]              # counts by status
npm run dev -- retry-failed --site bidlocker         # re-attempt failed documents
npm run build && npm start -- list                   # compiled
```

Exit code is 1 if any site hit a fatal error, 2 for bad arguments. `Ctrl+C` stops discovery,
finishes in-flight downloads, saves the session, closes the browser and flushes the DB
(a second `Ctrl+C` forces exit).

## Add a site in 5 steps

1. Copy `src/sites/_template/adapter.ts` to `src/sites/<yourSite>.ts`.
2. Set a unique `name` (and optional `config` overrides).
3. Implement `login` / `isLoggedIn` if the site needs auth (credentials from env vars).
4. Implement `discover`: navigate, and `yield` a `DocumentRef` per document with a stable
   `externalId` and a `download` spec (`url`, `click` or `request`).
5. Done. The registry auto-discovers top-level files in `src/sites/` (files starting with
   `_` are ignored, `example*` files only load with `INCLUDE_EXAMPLES=1`). Check with
   `npm run dev -- list`.

## Adapter contract

```ts
interface SiteAdapter {
  name: string;
  config?: Partial<SiteConfig>;
  login?(ctx: SiteContext): Promise<void>;
  isLoggedIn?(ctx: SiteContext): Promise<boolean>;
  discover(ctx: SiteContext): AsyncGenerator<DocumentRef>;
}
```

`SiteContext`: `browserContext`, `newPage()`, `logger`, `config`, `rateLimit()`, `signal`,
`dumpDebug(page, reason)`. Adapters must not write files or touch the manifest.

```ts
type DownloadSpec =
  | { kind: 'url'; url; headers? } // via context.request (shares cookies)
  | { kind: 'click'; open(page); trigger(page) } // core wraps trigger in waitForEvent('download')
  | { kind: 'request'; method; url; body?; headers? }; // POST/API style

interface DocumentRef {
  externalId?: string; // stable identity; else derived from the url (or source page + title for clicks)
  title?: string; // used for the stored filename
  sourcePageUrl: string;
  download: DownloadSpec;
  extra?: Record<string, unknown>;
}
```

Rules of thumb:

- Make `externalId` unique per **document** (not per page that lists several).
- Required selector missing: `requireSelector(...)` (throws `SiteChangedError`, dumps debug).
  Optional step: `isVisible()` / `locator.count()` and skip.
- Throw nothing for "no results": just return. Throw `SiteChangedError` when the layout is not
  what you expect (see `extractListing` in `bidlocker.ts` for empty vs changed).
- `click` downloads re-run `open` on every retry, so keep `open` idempotent.

Helpers (optional): `helpers/auth.ts` (`formLogin`, `requireEnv`, `isOnLoginPage`),
`helpers/paginate.ts` (`clickNext`, `urlPattern`, `infiniteScroll`, `loadMoreButton`),
`helpers/extract.ts` (`extractLinksFromTable`, `extractByLocator`, `requireSelector`, `isVisible`).

## Data flow

```
CLI -> Runner (per site, isolated) -> BrowserManager.openSite (storageState restored)
    -> adapter.isLoggedIn / login (session saved to sessions/<site>.json)
    -> Pipeline: adapter.discover() --DocumentRef--> p-limit queue
         key = externalId | url   -> manifest skip if already done
         Downloader.execute(spec) -> <tmp>/<uuid>.part (streamed, SHA-256) -> validate -> .dl
            validate: size>0, Content-Length, max size, magic-byte sniff, HTML => AuthError
            AuthError => adapter.login once (shared across docs) => retry
            429/5xx/timeouts => p-retry exponential + jitter (honors Retry-After); 404/403 never
         manifest.claimSha (atomic, global) => duplicate? mark + discard
         ZIP? archive.extractArchive (zip-slip, bomb limits, nesting) from tmp
         StorageBackend.put: data/downloads/<site>/<yyyy-mm>/<name>[_extracted/...]
         manifest rows: original + one row per extracted file (parent_id)
    -> summary per site; browser closed; session saved
```

Failures: screenshot + HTML to `data/debug/<site>/<timestamp>/`. `TRACE=true` writes a
Playwright trace to `data/debug/<site>/trace-*.zip`.

## Storage

`StorageBackend { put(localPath, key), exists(key), getUri(key) }`. Only `LocalFsStorage` is
implemented (no cloud dependencies). The pipeline depends only on the interface.

## ZIP handling

Detected by magic bytes (docx/xlsx/pptx are recognised from the central directory and are
**not** extracted). Limits (enforced while streaming, shared across nested archives):
`maxTotalBytes`, `maxEntries`, `maxRatio`, `maxDepth`. `../` traversal aborts extraction with
`ZipSafetyError` (nothing is left on disk); absolute paths and symlinks are skipped. Corrupt or
unsafe archives keep the original and are marked `failed_extract`. Encrypted entries are skipped
and the archive is marked `needs_password`.

> Limitation: yauzl cannot decrypt, so `zipPassword` is currently reserved (encrypted entries
> are always reported as `needs_password`). A decrypting extractor can be added behind
> `extractArchive` without touching the pipeline.

> Limitation: `kind: 'url' | 'request'` downloads use `context.request`, which buffers the body in
> memory before it is streamed to disk (bounded by `maxFileSizeBytes`). `click` downloads are
> streamed from the browser.

## Config reference

Global (env / `.env`): `LOG_LEVEL`, `DATA_DIR` (default `data`), `SESSIONS_DIR` (`sessions`),
`DB_PATH` (`<DATA_DIR>/manifest.sqlite`), `HEADLESS`, `TRACE`, `RESPECT_ROBOTS`, `INCLUDE_EXAMPLES`.

Per site (defaults, override in `adapter.config`; `--headed` overrides `headless`):

| key                                                    | default                | meaning                                        |
| ------------------------------------------------------ | ---------------------- | ---------------------------------------------- |
| `concurrency`                                          | 2                      | parallel documents (p-limit)                   |
| `minDelayMs` / `maxDelayMs`                            | 500 / 1500             | jittered gap between operations (rate limiter) |
| `headless`                                             | true                   | browser visibility                             |
| `blockResources`                                       | []                     | any of `image`, `font`, `media`, `stylesheet`  |
| `retries`                                              | 3                      | retries for transient errors                   |
| `retryMinTimeoutMs` / `retryMaxTimeoutMs`              | 1000 / 30000           | backoff bounds                                 |
| `navigationTimeoutMs` / `downloadTimeoutMs`            | 30000 / 120000         | Playwright timeouts                            |
| `maxFileSizeBytes`                                     | 500 MiB                | per-download cap                               |
| `zip.maxTotalBytes / maxEntries / maxRatio / maxDepth` | 1 GiB / 5000 / 100 / 2 | extraction limits (`maxDepth` = nested levels) |
| `zipPassword`                                          | -                      | reserved (see limitation)                      |
| `respectRobots`                                        | false                  | check robots.txt for `url`/`request` downloads |
| `trace`                                                | false                  | Playwright tracing                             |

## Manifest statuses

`pending`, `downloaded`, `duplicate`, `extracted`, `failed`, `failed_extract`, `needs_password`.
Dedup: per-site key (`externalId`/url) **and** global SHA-256. `retry-failed` re-attempts
`failed` and `failed_extract` rows.

## Sites

### bidlocker (`src/sites/bidlocker.ts`)

12 Oregon agencies behind one adapter and one login (Keycloak SSO). Needs a one-time signup,
then `BIDLOCKER_USER` / `BIDLOCKER_PASS`. `BIDLOCKER_AGENCIES=trimet,lanecc` restricts agencies.
Flow: `/a/<agency>/ShowAll` (skip if `0 RESULTS`) -> detail page -> express interest (only when
it is not already expressed: the control is a toggle) -> vendor registration link if shown ->
`#download-attachment-bundle` click -> ZIP extracted by the core.

## Tests

`npm test` (vitest, property-based with fast-check where possible). Browser-based tests
(`bidlocker.test.ts`, `e2e.test.ts`) skip themselves if Chromium is not installed.
