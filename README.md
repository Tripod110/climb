# Climb

A simple Deadlock tracker for any Steam account. It answers three questions: **am I improving,
which games did I carry, and what separates my hero play from the next rank?**

**Live:** https://tripod110.github.io/climb/

It replaces the old `Projects/Deadlock Tracker` (Electron, ~8.8k LOC, dormant since 2026-07).
Build-less, plain `<script>` files, localStorage, deadlock-api.com only.

## Layout

Hash-routed tabs (`#/overview`, `#/matches`, `#/match/<id>`, `#/heroes/<heroId>`, `#/play`,
`#/about`). `js/app.js` holds state, loading and routing; `js/views.js` has one render function
per page; every number comes from `js/engine.js` (tests: `node js/tests.js`).

- **First visit**: paste a Steam profile URL, SteamID64, `[U:1:n]`, `STEAM_0:x:y` or account id,
  or search a Steam name (`/v1/players/steam-search`). `Engine.parseSteamInput` handles the
  formats. Data caches are namespaced per account (`climb.<account>.<key>`); the pre-v6
  single-account cache migrates on first load.
- **Overview**: verdict plus stat tiles (win rate, rank points, carried, key player,
  dragged/passenger, MVPs) for *last session*, *last 20* or *season*, the role mix, recent
  matches, heroes and the rank chart.
- **Matches**: every game with role, tags and an impact bar, filterable. A match page shows the
  12-player scoreboard, your share vs an average teammate, and form vs your usual on that hero.
- **Heroes**: pick a hero. It shows your roles on it, then a **rank ladder**: 10 stats vs the
  average game in each rank's lobbies (Initiate–Eternus, 22 analytics calls, cached for an hour).
  For each stat it marks behind / on par / ahead of your rank and the next one, and which rank
  it "plays like".
- **Play time**: the helper-backed play tracker (below).
- **AI coach** (match page, "Coach me"): `Engine.debriefBrief` builds a ~5 KB factual brief from
  `/v1/matches/metadata` with items, death details and stat snapshots. It includes deaths with
  time, killer, coarse map zone (`mapZone`) and time-to-kill, item buys, souls vs lane opponents,
  both scoreboards, form vs your usual, and the hero's rank-ladder gaps. `js/coach.js` sends it
  to Gemini with `DEBRIEF_SYSTEM` (use only the brief's facts) and the JSON `DEBRIEF_SCHEMA`
  (summary, 3 points, focus).
  - The key is the user's own: pasted in About, stored in `climb.coach` in this browser, never in
    the repo. Results are cached per match in `climb.<account>.debriefs`.

## The model

- **Verdict**: Improving, Holding or Slipping. It's built from three signals, each compared with
  the window before:
  1. **Rank points**: the sum of the API's per-game `ranked_delta`. These are real deltas, not
     an MMR estimate.
  2. **Form**: how you played compared with your own other games **on the same hero**.
  3. **Consistency**: the share of rough games (result × form).
- **Impact and roles** (`lobbyImpact`, `gameRole`):
  - Impact = 0.3 × souls + 0.3 × damage (or 0.8 × healing) + 0.25 × kills+assists + 0.15 ×
    objectives, each relative to your own team's average, minus 0.25 × the extra deaths ratio.
  - Wins: Carried (team #1 with impact ≥ 1.3), Key player (top 2 or a Valve MVP), Solid,
    Passenger (bottom two).
  - Losses: Couldn't carry, Key player, Tough loss, Dragged down (last on the team, impact
    < 0.8, or most deaths while 4th or lower).
  - Lobby rows are compact arrays. `LOBBY_V` bumps when they grow, and older rows get
    re-fetched.
- **Rank ladder** (`rankLadder`):
  - Curve stats (`/v1/analytics/player-performance-curve`, `resolution=0`) at 15 / 20 / 30 min;
    win rate and accuracy from `/v1/analytics/hero-stats`.
  - Window: games since the last big patch, or the last 60 days if there are fewer than 8.
  - A gap is only called when it beats 2 standard errors of your mean and is at least 5%.
  - "Plays like" = the rank with the nearest average. A stat that moves under 8% from Initiate
    to Eternus is "same at every rank".

The model is documented at the top of [`js/engine.js`](js/engine.js). Two non-obvious rules:

- **Form** uses lobby-relative ratios (your souls / lobby average, etc.) z-scored against your
  other games on that hero, leave-one-out. Each stat's z is capped at ±3. A hero needs 5 games
  before its games get scored.
- **Climbing biases form downward**, because better lobbies mean lower placement. If the average
  lobby got ≥3 subranks tougher, a form or consistency dip is shown but not counted against you.

## Play time (the helper)

The **Play time** card tracks how long Deadlock is open each day. It exists to make the habit
visible, not to judge it.

- [`helper/helper.py`](helper/helper.py): stdlib Python and nothing more. Every 15s it asks Windows (`tasklist`) whether
  `deadlock.exe` is running and logs sessions to `%LOCALAPPDATA%\climb-helper\sessions.json`. It
  serves them read-only on `http://127.0.0.1:47615/sessions`. It never touches the game, so it's
  anti-cheat safe. It answers only Climb's origins and localhost Host headers.
- `helper/install-task.ps1` registers the **Climb helper** logon task (current user, no admin)
  and starts it. To remove it: `Unregister-ScheduledTask -TaskName 'Climb helper' -Confirm:$false`.
- [`js/play.js`](js/play.js) merges two sources:
  - Days from the helper's `since` onwards use helper sessions (all time in game, queue
    included).
  - Earlier days use the API's match durations (games only, which can lag or undercount).
- A play-day runs **5 AM to 5 AM**, so late-night play counts toward the evening it belongs to.
- Without a reachable helper (e.g. on a phone) the card falls back to the API data only.

## Run / test

No build step. The scripts are plain `<script>` files and the data is cached in localStorage.

```bash
node js/tests.js
node js/play-tests.js
```

```bash
python -m http.server 5179
```

There's also a `climb` entry in `D:\Claude\.claude\launch.json`.

**After any CSS/JS change, bump `?v=N` in `index.html` and `sw.js` (including `CACHE`)**, or the
service worker keeps serving the old build. That only applies over https (the SW isn't
registered on localhost).

**Every version bump gets a changelog entry** with the same `v`: at the top of
[`js/changelog.js`](js/changelog.js) (the in-app "What's new" card and footer list) and in
[`CHANGELOG.md`](CHANGELOG.md). Keep the wording user-facing: what you'll see, not which file
changed.

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
