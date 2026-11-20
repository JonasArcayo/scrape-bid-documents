# Site Configs (`sites/`)

Every `.json` file under `sites/` (except files or folders starting with `_`, such as `_disabled/`) is automatically loaded by [`loadSiteConfigs`](../src/sites/configLoader.ts) and validated against [`JsonSiteConfigSchema`](../src/sites/configSchema.ts).

## Common Fields

| Field      | Purpose                                                                                                                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`     | Unique site identifier used with `pnpm dev run --site <name>`                                                                                                                                     |
| `enabled`  | Set `false` to skip loading without deleting the file (default `true`)                                                                                                                            |
| `tags`     | Labels for grouping runs with `pnpm dev run --tag <tag>`                                                                                                                                          |
| `template` | Discovery strategy: `link-list`, `table-links`, `table-detail`, `firecrawl`, or `bidlocker`                                                                                                       |
| `config`   | Optional per-site overrides for [`SiteConfigSchema`](../src/core/config.ts) (`concurrency`, `minDelayMs`, `maxDelayMs`, `navigationTimeoutMs`, `blockResources`, `fingerprint`, `headless`, etc.) |

## Templates

- **`link-list`** — Extracts direct document URLs from a list of links on one or more pages (optional `firecrawlFallback: true` falls back to Firecrawl on `SiteChangedError`).
- **`table-links`** — Extracts direct document URLs from matching `row` → `link` elements inside a table (optional `firecrawlFallback: true`).
- **`table-detail`** — Two-hop (or three-hop via `hopLink`) flow: collects detail URLs from a listing page (`row` + `detailLink`, or `detailLink` directly), opens each detail page, and downloads documents via `url` or `click` (`downloadMode`).
- **`firecrawl`** — Selector-free discovery via Firecrawl's `/v1/scrape` or `/v1/map` API (`mode`, `includeLinks`, `excludeLinks`; requires `FIRECRAWL_API_KEY`). See [example-firecrawl.json](./_disabled/example-firecrawl.json).
- **`bidlocker`** — Dedicated template for `bidlocker.us` agencies (`agency` slug + credentials in `.env`).

## Subfolders

- [bidlocker/](./bidlocker/README.md) — 12 Oregon agencies on `bidlocker.us`
- [oregonbuys/](./oregonbuys/README.md) — State of Oregon `oregonbuys.gov` open bids
- [portland/](./portland/README.md) — City of Portland bids (via SAP Ariba Discovery)
- [samnavigator/](./samnavigator/README.md) — Federal SAM.gov opportunities via `samnavigator.com`
