Technet Dashboard (Lightweight)

Overview
- Server-side fetches the Altice Technet page and extracts tables/text into a simple dashboard UI.
- Offline mode uses captured HTML from `../_responses/dashboard.html` if present.
- Live mode uses Playwright to automate login (requires credentials in `.env`).

Setup
1) Install Node.js 18+.
2) In PowerShell, run:
   npm install
   npm run playwright:install
3) Copy `.env.example` to `.env` and fill `TECHNET_USER` and `TECHNET_PASS`.
   - Optional: set `OFFLINE_HTML` to a local HTML file path (absolute or relative to repo) to use as offline source.
   - Alternatively, you can use `TECHNET_USERNAME` and `TECHNET_PASSWORD` — the server recognizes both naming styles.
   - You can override the target URL with `TECHNET_URL`. Headless mode can be set with `HEADLESS` (set to `false` to see the browser), and `SLOWMO` adds delay between operations.

Run
- Start the server:
   npm start
- Open: http://localhost:3000
 - Force live fetch (ignores offline file): http://localhost:3000/api/technet?mode=live
 - Download CSV of parsed tables: http://localhost:3000/api/technet.csv
 - POST live fetch without .env:
   curl -X POST http://localhost:3000/api/technet/live -H "Content-Type: application/json" -d '{"user":"TECHNET_USER","pass":"TECHNET_PASS"}'
   PowerShell example using env vars:
   $body = @{ user=$env:TECHNET_USER; pass=$env:TECHNET_PASS } | ConvertTo-Json
   Invoke-RestMethod http://localhost:3000/api/technet/live -Method POST -Body $body -ContentType 'application/json'

Notes
- If credentials are missing, the app attempts offline mode via `../_responses/dashboard.html`.
 - You can override offline source using `OFFLINE_HTML` env or by placing `page_snapshot.html` in the repo root.
- If parsing fails, raw HTML is shown for manual inspection.
- For production, consider adding explicit selectors for known Technet tables.
 - Latest fetch results are cached under `technet-dashboard/cache/`.
 - The CSV route only includes table data; if the offline HTML contains no `<table>`, the file will be empty.
