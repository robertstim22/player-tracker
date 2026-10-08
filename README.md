# Player Tracker

Weekend college football stats for a custom player list, via CollegeFootballData.com.

- Edit `players.json` (name + team as CFBD spells it, e.g. "Ohio State") to change who's tracked.
- `node scripts/fetch.mjs` refreshes `data/stats.json` (needs `CFBD_API_KEY`); add `--demo` for sample data.
- Preview locally: `python3 -m http.server 8000`, open http://localhost:8000
- Deploy: push to GitHub, add repo secret `CFBD_API_KEY`, enable Pages (Settings → Pages → main / root).
  `.github/workflows/refresh.yml` refreshes every 30 min Thu–Sat (plus early Sunday UTC).
