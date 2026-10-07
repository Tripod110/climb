# Climb

A personal Deadlock progress tracker that answers one question: **am I improving?**

**Live:** https://tripod110.github.io/climb/

It replaces the old `Projects/Deadlock Tracker` (Electron, ~8.8k LOC, dormant since 2026-07).
That app's coaching and debrief side now lives in POSTMORTEM. Climb only covers rank and progress.

## What it shows

- **Verdict**: Improving, Holding or Slipping, for *last session*, *last 20* or *season*. It's
  built from three signals, each compared with the window before:
  1. **Rank points**: the sum of the API's per-game `ranked_delta`. These are real deltas, not
     an MMR estimate.
  2. **Form**: how you played compared with your own other games **on the same hero**.
  3. **Consistency**: the share of rough games.
- **Match classes**: Earned win, Passenger win, Unlucky loss and Rough game, from result × form.
- **Lobby tags** (Farmer, Damage, Playmaker, Survivor, Support): you placed top in that one lobby.
  They're for bragging only and never feed the verdict.

The model is documented at the top of [`js/engine.js`](js/engine.js). Two non-obvious rules:

- **Form** uses lobby-relative ratios (your souls / lobby average, etc.) z-scored against your
  other games on that hero, leave-one-out. Each stat's z is capped at ±3. A hero needs 5 games
  before its games get scored.
- **Climbing biases form downward**, because better lobbies mean lower placement. If the average
  lobby got ≥3 subranks tougher, a form or consistency dip is shown but not counted against you.

## Run / test

No build step. The scripts are plain `<script>` files and the data is cached in localStorage.

```bash
node js/tests.js
```

```bash
python -m http.server 5179
```

There's also a `climb` entry in `D:\Claude\.claude\launch.json`.

**After any CSS/JS change, bump `?v=N` in `index.html` and `sw.js` (including `CACHE`)**, or the
service worker keeps serving the old build. That only applies over https (the SW isn't
registered on localhost).

## Data

- Sources, all from deadlock-api.com (CORS `*`, no server needed):
  - `/v1/players/{id}/match-history` for your own stats, `ranked_delta` and badge
  - `/v1/matches/metadata?match_ids=…&include_player_final_stats=true` for the whole lobby, 30
    matches per request
  - `/v1/assets/heroes`
  - `/v1/assets/ranks`
- Rate limits are tight and shared:
  - The bulk metadata endpoint allows 30 requests/min per IP.
  - Lobbies are fetched once, compacted to about 400 bytes each, and stored forever.
  - The history is refetched at most every 3 minutes.
- The account is hard-coded (`Engine.ACCOUNT_ID`, 186993885). This is a single-user app by design.
- Rank badge encoding: `tier*10 + subrank` (42 = Sentinel 2). `Engine.ladder()` converts that to
  a linear subrank index.
