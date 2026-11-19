# scrape-bid-documents

Multi-site Playwright document scraper (TypeScript, Node 20+, ESM, strict).

A flow-agnostic **core** downloads, validates, extracts, deduplicates, stores, and tracks documents.
Per-site **configs** (`sites/**/*.json`) and **adapters** (`src/sites/*.ts`) only handle discovery and emit `DocumentRef`s — adding a site never touches the core.

## Setup

```bash
pnpm install
pnpm exec playwright install chromium
cp .env.example .env        # fill in credentials for authenticated sites (e.g. bidlocker)
pnpm run check              # typecheck + lint + prettier + tests
```

## CLI

```bash
pnpm dev list                                    # list registered sites
pnpm dev list --tag oregon                       # filter by tag
pnpm dev run --site oregonbuys --limit 5         # run one site (or repeat --site)
pnpm dev run --tag bidlocker                     # run all sites with a tag
pnpm dev run --all --concurrency 2               # run all sites in parallel
pnpm dev run --site bidlocker-trimet --headed    # show browser window
pnpm dev stats [--site oregonbuys]               # counts by manifest status
pnpm dev retry-failed --site oregonbuys          # re-attempt failed documents
pnpm run build && pnpm start list                # compiled build
```

Exit code is `1` if any site hit a fatal error, `2` for bad arguments. `Ctrl+C` stops discovery, finishes in-flight downloads, saves the session, closes the browser, and flushes SQLite (a second `Ctrl+C` forces exit).

## Adding a New Source

### Option 1: Declarative JSON (recommended)

Drop a `.json` file anywhere under `sites/` (files/folders starting with `_`, like `_disabled/`, are ignored). See [sites/README.md](sites/README.md) for the full field reference and examples.

Available templates:

- `link-list` — direct document links on one or more pages
- `table-links` — direct document links inside table rows (`row` → `link`)
- `table-detail` — two-hop (or three-hop via `hopLink`) portals: listing → detail page → `url` or `click` download
- `bidlocker` — `bidlocker.us` agencies (`agency` slug + `.env` credentials)

Check your config with `pnpm dev list` and test it with `pnpm dev run --site <name> --limit 2`.

### Option 2: Custom TypeScript Adapter

Use a custom `.ts` adapter only when a portal needs login flows, form state, or logic that doesn't fit JSON. [registry.ts](src/sites/registry.ts) auto-discovers top-level `src/sites/*.ts` files (ignoring `_`-prefixed files).

```ts
interface SiteAdapter {
  name: string;
  config?: Partial<SiteConfig>;
  login?(ctx: SiteContext): Promise<void>;
  isLoggedIn?(ctx: SiteContext): Promise<boolean>;
  discover(ctx: SiteContext): AsyncGenerator<DocumentRef>;
}
```

`SiteContext` provides `browserContext`, `newPage()`, `logger`, `config`, `rateLimit()`, `signal`, and `dumpDebug(page, reason)`. Adapters must not write files or touch the manifest directly.

```ts
type DownloadSpec =
  | { kind: 'url'; url: string; headers?: Record<string, string> }
  | { kind: 'click'; open(page: Page): Promise<void>; trigger(page: Page): Promise<void> }
  | {
      kind: 'request';
      method: 'GET' | 'POST';
      url: string;
      body?: unknown;
      headers?: Record<string, string>;
    };

interface DocumentRef {
  externalId?: string;
  title?: string;
  sourcePageUrl: string;
  download: DownloadSpec;
  extra?: Record<string, unknown>;
}
```

Shared helpers live in `src/sites/helpers/`:

- [auth.ts](src/sites/helpers/auth.ts) — `formLogin`, `requireEnv`, `isOnLoginPage`
- [paginate.ts](src/sites/helpers/paginate.ts) — `clickNext`, `urlPattern`, `infiniteScroll`, `loadMoreButton`
- [extract.ts](src/sites/helpers/extract.ts) — `extractLinksFromTable`, `extractByLocator`, `requireSelector`, `isVisible`

## Architecture & Data Flow

```text
CLI -> Runner (per site, isolated) -> BrowserManager.openSite (sessions/<site>.json restored)
    -> adapter.isLoggedIn / login (optional)
    -> Pipeline: adapter.discover() --DocumentRef--> p-limit queue
         key = externalId | url   -> manifest skip if already done
         Downloader.execute(spec) -> <tmp>/<uuid>.part (SHA-256) -> validate -> .dl
            validate: size > 0, Content-Length, max size, magic-byte sniff, HTML => AuthError
            429/5xx/timeouts => p-retry exponential + jitter; 404/403 fail fast
         manifest.claimSha (global SHA-256 dedup)
         ZIP? archive.extractArchive (zip-slip & bomb limits)
         LocalFsStorage -> data/downloads/<site>/<yyyy-mm>/<name>[_extracted/...]
    -> summary table; browser closed; session saved
```

Failures dump a screenshot + HTML to `data/debug/<site>/<timestamp>/`. Setting `TRACE=true` writes a Playwright trace to `data/debug/<site>/trace-*.zip`.

## Config Reference

**Global (`.env` / environment):** `LOG_LEVEL` (`info`), `DATA_DIR` (`data`), `SESSIONS_DIR` (`sessions`), `DB_PATH` (`<DATA_DIR>/manifest.sqlite`), `HEADLESS` (`true`), `TRACE` (`false`), `FINGERPRINT` (`true`).

**Per-site (`config` in JSON or `adapter.config`):**

| Key                                         | Default                         | Meaning                                               |
| ------------------------------------------- | ------------------------------- | ----------------------------------------------------- |
| `concurrency`                               | `2`                             | Parallel downloads (`p-limit`)                        |
| `minDelayMs` / `maxDelayMs`                 | `500` / `1500`                  | Jittered delay between operations                     |
| `headless`                                  | `true`                          | Browser visibility (`--headed` overrides)             |
| `fingerprint`                               | `true`                          | Randomized UA/viewport + browser init spoofing        |
| `blockResources`                            | `[]`                            | Block any of `image`, `font`, `media`, `stylesheet`   |
| `retries`                                   | `3`                             | Retries for transient HTTP/network errors             |
| `retryMinTimeoutMs` / `retryMaxTimeoutMs`   | `1000` / `30000`                | Exponential backoff bounds                            |
| `navigationTimeoutMs` / `downloadTimeoutMs` | `30000` / `120000`              | Playwright timeouts                                   |
| `maxFileSizeBytes`                          | `500 MiB`                       | Per-download size cap                                 |
| `zip`                                       | `1 GiB / 5000 / 100x / depth 2` | `maxTotalBytes`, `maxEntries`, `maxRatio`, `maxDepth` |
| `trace`                                     | `false`                         | Record Playwright trace zip                           |

## Registered Sources

- [sites/bidlocker/](sites/bidlocker/README.md) — 12 Oregon agencies on `bidlocker.us` (requires `BIDLOCKER_USER` / `BIDLOCKER_PASS`)
- [sites/oregonbuys/](sites/oregonbuys/README.md) — OregonBuys open solicitations
- [sites/portland/](sites/portland/README.md) — City of Portland bids (via SAP Ariba Discovery)
- [sites/samnavigator/](sites/samnavigator/README.md) — Federal SAM.gov opportunities via `samnavigator.com`

## Tests

```bash
pnpm test
```

Uses Vitest (with `fast-check` property tests). Browser-based tests (`bidlocker.test.ts`, `e2e.test.ts`) automatically skip if Chromium is not installed.
