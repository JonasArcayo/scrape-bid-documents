# City of Portland (`sites/portland/`)

Scrapes open bids from `https://www.portland.gov/business-opportunities/events/bids` using `template: "table-detail"`.

- **`selectors.detailLink`**: Collects event pages (`main a[href*='/business-opportunities/events/20']`) directly (no `row` container needed).
- **`selectors.hopLink`**: Follows each event page's SAP Ariba Discovery link (`a[href*='portal.us.bn.cloud.ariba.com']`).
- **`selectors.detailReady` & `selectors.docLink`**: Waits for Ariba's SPA to render (`button:has-text('Respond')`), then clicks individual `Download` buttons (`button:has-text('Download'):not(:has-text('Download All'))`).
- **`config`**: `concurrency: 1` with `1000–2000ms` delays.
