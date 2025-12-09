fetch_all_safe.ps1

Purpose:
- Run authenticated fetches for all techs in `techs.json` and save parsed results into a pending directory.
- By default the script is a dry-run: it does NOT overwrite existing `cache/live/<tech>/<date>.json` files.
- When invoked with `-Promote`, the script will:
  1. Back up current `cache/live/*/<date>.json` and `data/stops-<date>.json` into `tmp/backup_live_<date>_<ts>`
  2. Move pending results into `cache/live/...` and call `/api/refresh` to regenerate the aggregated file

Usage examples:

# Dry run (fetch only; do not change existing caches)
powershell -ExecutionPolicy Bypass -File .\scripts\fetch_all_safe.ps1 -Date 2025-12-08

# Promote results (backup existing caches first, then overwrite and refresh aggregation)
powershell -ExecutionPolicy Bypass -File .\scripts\fetch_all_safe.ps1 -Date 2025-12-08 -Promote

Notes:
- The script expects the server to be running at `http://localhost:3000` and the admin endpoint `/api/technet/live` to accept `{ user, pass }` and return parsed JSON.
- Pending data is saved under `tmp/pending_live_<date>_<ts>/cache/live/<tech>/<date>.json` so you can inspect before promoting.
- Backups are saved under `tmp/backup_live_<date>_<ts>`.
- Adjust `-TimeoutSec` if your network or server is slow.
