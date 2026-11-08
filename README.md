# Climb

A coaching-first Deadlock tracker for any Steam account. It answers three questions: **am I
improving, what wins me games, and what separates my hero play from the next rank?**

**Live:** https://tripod110.github.io/climb/

Build-less, plain `<script>` files, localStorage, deadlock-api.com only. Rules for changing any of
it are in [AGENTS.md](AGENTS.md).

## Layout

Hash-routed tabs: `#/overview`, `#/coach`, `#/matches`, `#/match/<id>`, `#/heroes/<heroId>`,
`#/friends`, `#/friend/<account>`, `#/about` (and `#/play`, which works but is off the menu).
`js/app.js` holds state, loading and routing; `js/views.js` has one render function per page;
every number comes from `js/engine.js` (tests: `node js/tests.js`).

The style since 0.30 is "numbers, not sentences": small-caps section kickers between gilded
rules (`sh()`), `.ledger` rows of figures, and every explanation behind a small source badge
(`src()`: Your games, Trained model, Rank data, Valve, Climb rule, AI) that opens on tap.

- **First visit**: paste a Steam profile URL, SteamID64, `[U:1:n]`, `STEAM_0:x:y` or account id,
  or search a Steam name (`/v1/players/steam-search`). `Engine.parseSteamInput` handles the
  formats. Any public account works; caches are namespaced per account (`climb.<account>.<key>`).
- **Overview**: the verdict (Improving / Holding / Slipping) with its three signals; a ledger of
  win rate, ahead at 12:00, clean to 10:00 and deaths a game for *last session*, *last 20* or
  *season*; **Training** (your focus habit and the pace of your climb); **Scouting** (the habits
  that split your wins from losses, `splitBar`); **Film room** (last 8 games); **The climb**
  (`rankOutlook`: your rank after 20/50/100 more ranked games from your win rate, backtested; and the
  season rank-points chart). A last-session recap and a
  missing-games notice appear on top when they apply.
- **Coach** (last 30 games): pick one habit to train (a ✓/✗ every game, called after a few
  games, mastered at a set pass rate); wins vs losses figures; farm at 12:00 vs your lane; deaths
  by phase, zone and killer; Gemini's notes on the whole set; past habits.
- **Matches**: totals for the filtered games, then games grouped by day with each day's record
  and rank points (`matchTotals`, `matchDays`). Each row: the rank you played at (`matchRanks`), K/D/A, souls, damage, Form, rank
  points. A missing game can be added by match id.
- **Match page**: your share of your team, you vs an average teammate, form vs your usual on
  that hero, the win-chance chart with turning points and what each death usually costs, farm
  by source vs your lane opponents, a Gemini debrief, and the 12-player scoreboard with the lobby and
  team average rank, each player's rank (`playerRankAt`), games and win rate on their hero, and tags
  (`heroTags`).
- **Heroes**: a scouting row (best hero, one to park, most and least rank points, on the rise,
  most played) and the hero pool grouped by how each hero does for you (`heroInsights`, win rates
  shrunk toward your overall). Per hero: a ledger, then **Rank road** (your gaps vs the next
  rank's average, `rankLadder` + `nextRankPlan`) or **Coach me** (`heroCoach`).
- **Friends**: people you've queued with 10+ times, ranked on lobby-relative souls, damage or
  healing, K+A and staying alive in your shared games (`stackBoard`). A friend's page adds the
  head-to-head, an early-game scorecard with a catch-up plan (`scorecard`), and "Coach us".
- **About** (the avatar button): account switch, Gemini key, whether the win model holds up on
  your games (`calibration`), how to get missing games, data, and the changelog.
- **AI coach**: Gemini, with the user's own key (pasted in About, stored in `climb.coach` in this
  browser, never in the repo). Climb builds a compact factual brief (`debriefBrief`,
  `analysisBrief`, `duoBrief`) and `js/coach.js` sends it with a system prompt that says to use
  only those facts, plus a JSON schema for the reply. Results are cached per account.

## The model

- **Verdict**: Improving, Holding or Slipping. It's built from three signals, each compared with
  the window before:
  1. **Rank points**: the sum of the API's per-game `ranked_delta`. Real deltas, not an MMR
     estimate.
  2. **Form**: how you played compared with your own other games **on the same hero**.
  3. **Rough games**: the share of games that were a loss and below your usual.
- **Impact** (`lobbyImpact`, `gameRole`): 0.3 × souls + 0.3 × damage (or 0.8 × healing) +
  0.25 × kills+assists + 0.15 × objectives, each relative to your own team's average, minus
  0.25 × the extra deaths ratio. It gives the match page's "#2 of 6" team share, shown neutral:
  on 400 games it didn't predict wins. Lobby rows are compact arrays; `LOBBY_V` bumps when they
  grow, and older rows get re-fetched.
- **Habits** (`HABITS`, `habitCatalog`, `focusProgress`): per-game checks measured before the
  game is decided (ahead at 12:00, no deaths before 10:00, …). Only habits that split your wins
  from your losses can be picked.
- **Rank comparison** (`rankLadder`):
  - Curve stats (`/v1/analytics/player-performance-curve`, `resolution=0`) at 15 / 20 / 30 min;
    win rate and accuracy from `/v1/analytics/hero-stats`, for every rank (22 calls, cached).
  - Window: games since the last big patch, or the last 60 days if there are fewer than 8.
  - A gap is only called when it beats 2 standard errors of your mean and is at least 5%.
- **Small samples**: anything that ranks heroes or people shrinks toward an average
  (`heroInsights`, `stackBoard`), and "ahead / behind" calls must hold in both halves.

The model is documented at the top of [`js/engine.js`](js/engine.js). Two non-obvious rules:

- **Form** uses lobby-relative ratios (your souls / lobby average, etc.), plus farm by 12:00 vs
  your lane when the match has detail, z-scored against your other games on that hero,
  leave-one-out. Each stat's z is capped at ±3. A hero needs 5 games before its games get scored.
- **Climbing biases form downward**, because better lobbies mean lower placement. If the average
  lobby got ≥3 subranks tougher, a form or consistency dip is shown but not counted against you.

## Win-chance model (`model/`)

`model/train.py` trains the win-chance model and death-cost table from deadlock-api's public data
lake (`data.deadlock-api.com`, hourly Parquet files, read with DuckDB over HTTPS; only the needed
columns are fetched). The old `/v1/sql` endpoint is deprecated and limited to 20 queries/hour, so
don't use it. Output is `js/wpmodel.js` (`window.WPMODEL`, a few KB). It's a script rather than
JSON because the CSP allows scripts from `'self'` but no fetches.

```bash
python -m venv model/.venv
model/.venv/Scripts/python -m pip install -r model/requirements.txt
model/.venv/Scripts/python -I model/train.py
```

Re-run after each big patch (it only uses matches since the last one), check the printed
accuracy/calibration table, bump `?v=N` and commit `js/wpmodel.js`. What it found
(2026-10-23):
- Souls gap does almost all the predicting; kills, objectives and mid-boss add a little.
- A death's cost is the team-souls swing around it: about the kill bounty early, and roughly
  twice the bounty after 20 min, when long respawns cost farm too.
- Your team is ~10 points more likely to lose an objective in the 90s after a death.

## Play time (the helper)

The **Play time** page (`#/play`, off the menu since 0.24; its hours still feed the Overview's
last-session recap) tracks how long Deadlock is open each day. It exists to make the habit
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
- Without a reachable helper (e.g. on a phone) the page falls back to the API data only.

## Run / test

No build step. The scripts are plain `<script>` files and the data is cached in localStorage.

```bash
node js/tests.js
node js/play-tests.js
```

```bash
python -m http.server 8765 --bind 127.0.0.1
```

The same server is the `climb` entry in [`.claude/launch.json`](.claude/launch.json).

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
- Any public account works. `Engine.ACCOUNT_ID` (the owner's, 186993885) is only the fallback for
  caches from before accounts could be switched.
- Rank badge encoding: `tier*10 + subrank` (42 = Sentinel 2). `Engine.ladder()` converts that to
  a linear subrank index.
