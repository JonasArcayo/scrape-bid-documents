# BidLocker (`sites/bidlocker/`)

Each JSON file in this folder configures an Oregon agency hosted on `bidlocker.us` using `template: "bidlocker"`.

- **`agency`**: The URL slug on `https://bidlocker.us/a/<agency>/...` (for example `trimet`, `oregonmetro`, `lanecc`).
- **`tags`**: `["bidlocker", "oregon"]` so all 12 agencies can be run together with `pnpm dev run --tag bidlocker`.
- **Credentials**: Uses `BIDLOCKER_USER` / `BIDLOCKER_PASS` (or `SCRAPER_DEFAULT_USER` / `SCRAPER_DEFAULT_PASS`) from `.env` to log in and save `sessions/bidlocker-<agency>.json`.
