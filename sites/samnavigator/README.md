# SAM Navigator (`sites/samnavigator/`)

Scrapes federal solicitations listed on `https://samnavigator.com/sam_preview.aspx` using `template: "table-detail"`.

- **`selectors.row` & `selectors.detailLink`**: Reads the hidden `<input type="hidden">` inside each `#main_GridView1 tr` row, which holds the direct `https://sam.gov/workspace/contract/opp/<id>/view` URL.
- **`selectors.detailReady` & `selectors.docLink`**: Waits for `sam.gov` to render `button:has-text('Download All')` and clicks the first one (`>> nth=0`) to download the solicitation's `.zip` bundle (automatically extracted by the pipeline).
- **`config`**: `concurrency: 1`, `1000–2000ms` delays, and `navigationTimeoutMs: 45000` for the `sam.gov` Angular SPA.
