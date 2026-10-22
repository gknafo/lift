# Lift

Workout log for Gav and Bethany. Static site on GitHub Pages; data lives in a separate **private** repo (`gknafo/lift-data`), one file per person (`gav.json`, `bethany.json`). Every save is a commit there, so the data repo's history doubles as an undo log.

## Files
- `index.html` — the app (UI + GitHub sync)
- `core.js` — data logic: merge, history lookup, beat-the-reps comparison
- `sw.js` — offline cache for the app shell (network-first)
- `tests/` — `python3 -m pytest tests` (node unit suite + Playwright two-phone run against a fake GitHub API)

## Phone setup
1. Open the Pages URL in Safari → Share → Add to Home Screen.
2. ⚙︎ → paste the token → Save & test. Same token on both phones.

## Token
Fine-grained personal access token, **Only select repositories: lift-data**, permission **Contents: Read and write**. Nothing else.

## Sync model
Each routine and workout is a record with an id and `updatedAt`. On every save the app pulls the file, merges record-by-record (newest wins, deletions kept as tombstones), and writes back; if the other phone wrote in between, GitHub rejects the write and the app re-merges and retries. Offline edits stay on the phone and sync when signal returns. An in-progress workout lives only on the phone until Finish.
