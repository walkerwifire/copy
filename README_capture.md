# Puppeteer Capture — Instructions

Prerequisites
- Node.js (v16+ recommended). Check with `node -v`.
- Disk space: capturing sites with many assets can use hundreds of MBs.

Install dependencies
- From your project root (where you saved tools/capture-all.mjs), run:
  npm init -y
  npm install puppeteer

Notes:
- Installing `puppeteer` will download a Chromium binary (~100MB). If you already have Chrome and want a smaller install, use `puppeteer-core` and specify the executablePath in the script.

Run the capture
- PowerShell / macOS / Linux:
  node tools/capture-all.mjs "https://example.com" ./capture-out 180 --visit "/dashboard,/map"

- Arguments:
  - startUrl: the URL to open first (e.g., https://your-site.com)
  - outDir: folder to write captured files (relative or absolute)
  - seconds: capture duration in seconds (optional, default 120)
  - --visit "/path1,/path2": optional comma-separated paths to auto-visit (useful for lazy route chunks)

Interactive capture
- The script runs Chromium in non-headless mode so you can:
  1. Log in manually (if required).
  2. Click around/visit different sections of the site to cause JS bundles and assets to load.
  3. The script saves network responses while you interact.

After capture
- The outDir will contain:
  - _responses/ (all saved responses: JS / CSS / images / fonts / JSON)
  - manifest.json (mapping of saved URLs to files)
  - page_snapshot.html (final page HTML snapshot)
  - page_console.log (console output from the page, if any)

What to do next
- Zip the outDir (e.g., capture-out.zip) and upload or attach it here.
- Once I receive the capture zip, I will:
  1. Extract assets and map the site structure (e.g., _next/static/chunks).
  2. Recreate a runnable frontend that serves the captured assets and a mock API for captured JSON responses.
  3. Provide the rebuilt project files and instructions to run locally.

Security & privacy
- The script will capture any data your browser receives while it runs, including API responses that may contain sensitive data. Do not upload or share capture outputs that include credentials or PII you don't want to share.
- If capturing pages that require login, you can log in manually in the opened Chromium instance. The script will not store your saved Chrome user profile — it runs an ephemeral Chromium instance.

Troubleshooting
- If you get `Error: Failed to launch the browser process`, ensure your environment allows Chromium to run. On some Windows servers you may need additional dependencies or to run with `--no-sandbox`.
- If too many files are saved, increase capture duration and selectively use `--visit` for only the routes you need.