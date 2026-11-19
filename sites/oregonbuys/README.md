# OregonBuys (`sites/oregonbuys/`)

Scrapes open bid solicitations from `https://oregonbuys.gov/bso/view/search/external/advancedSearchBid.xhtml?openBids=true` using `template: "table-detail"`.

- **`selectors.row` / `selectors.detailLink`**: Extracts `/bso/external/bidDetail.sda?docId=...` links from the PrimeFaces results table.
- **`selectors.nextPage` & `pageSettleMs`**: Clicks `a.ui-paginator-next:not(.ui-state-disabled)` and waits `1200ms` for PrimeFaces AJAX pagination to update the table.
- **`selectors.docLink` & `downloadMode: "click"`**: Each detail page triggers attachment downloads via `a[href^='javascript:downloadFile(']`.
- **`config`**: Kept at `concurrency: 1` with `1000–2000ms` jittered delays to avoid hammering the portal.
