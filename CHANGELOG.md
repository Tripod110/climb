# Changelog

What changed in each release. The version is the `?v=N` in `index.html`. The app shows the same
entries from [`js/changelog.js`](js/changelog.js): a "What's new" card after an update, and the
full list in the footer. Every deploy that bumps `?v=N` adds an entry to both.

## v17 (2026-10-26): Smoother Heroes tab
- The hero picker is sorted A–Z: a wrapping grid on wide screens, and a sideways strip on phones
  (≤640px) that scrolls the picked hero into view. With no hero in the URL, it still opens your
  most-played hero of the last 60 days.
- `render()` now keeps open `<details>` (matched by summary text) and `[data-keep-x]` sideways
  scroll when redrawing the same page. Pages redraw as data arrives, which used to close them.
- Resize only redraws when the width changes. Phones fire resize whenever the address bar slides
  in or out, so scrolling used to close sections.
- The match id field sits at the top of Matches, always visible, replacing v16's "+ Add match"
  toggle.

## v16 (2026-10-26): Squads
- Scoped with proper-plan against 266 games (90 days). What the data said:
  - A friend's early deaths and caught-outs barely move your result, but yours do. So there are
    no shared "squad rules".
  - Caught-out deaths over the whole game mostly follow the result (55/36 overall, 48/52 before
    15:00). Only habits measured before the game is decided are used: no deaths before 10:00,
    ahead at 12:00, not caught out before 15:00.
  - "Who's better" on win chance lost to deaths flipped between halves for 2 of 4 regular
    friends, so the leaderboard only calls it when the gap is 2+ points and holds in both halves.
  - There are too few games per lineup to rank lineups.
- `Engine.squadRow`: one ~300-byte row per shared game (every teammate's early deaths, ahead at
  12:00, caught out before 15:00, win chance lost to deaths, and their worst death). Rows are
  cached under `squad` for 90 days, so full match detail isn't kept.
- `friendBoard` / `versus`, `squadRecord`, `scorecard` (with a catch-up plan), `weeklyReport`, and
  "Coach us" (`DUO_SYSTEM` / `DUO_SCHEMA`).
- The weekly report copies as Discord markdown or as a PNG made with canvas (no avatars, since
  cross-origin images would block the export).
- "+ Add match" moved to the top of the Matches tab.

## v15 (2026-10-26): Add a match by id
- Valve's match history (`/v1/players/{id}/match-history`, even with `force_refetch`) can leave
  out a game that deadlock-api has full metadata for. Found with match 125201309.
- An "Add a match by id" form at the bottom of Matches and in the "Missing games?" card. It
  fetches the bulk metadata, builds the match with `Engine.matchFromMeta`, and stores it per
  account under `added`. The rank change is `player_rank_final_flat_progress −
  player_rank_initial_flat_progress`.
- `Engine.mergeAdded` merges these into the history everywhere. Once Valve's history lists a game,
  its row wins. Added games are marked "added by id" on the match page.

## v14 (2026-10-25): Missing games, explained
- A freshness line under your rank: when your newest match on deadlock-api ended
  (`Engine.freshness`).
- With the Climb helper, Climb knows if you played after that (it allows a 10-minute grace
  window). If you did for 20+ minutes, a "Missing games?" card says how long, and lists the fixes,
  safest first:
  1. a one-time upload of Steam's `httpcache` at deadlock-api.com/ingest-cache;
  2. deadlock-api-ingest started from Deadlock's launch options with `--no-memory`. Started that
     way it never uses the Steam login, and with the flag it only watches the cache.
  3. Deadlock Mod Manager's match sync (uses the saved Steam login);
  4. deadlock-api's supporter tier.
  The guide is also under Account & about.
- Climb will not read Steam login tokens or game memory itself. Those were the "gold standard"
  ideas in a friend's write-up; checked against the ingest tool's README 2026-10-25.

## v13 (2026-10-23): Road to the next rank, friends, receipts
- **Roles retired as verdicts.** On the user's last 400 games, Climb's impact score had AUC
  0.49 against winning, and being team #1 won only 49%. A share of your own team's stats can't
  predict a result the whole team shares. Games now show a neutral **team share** (Top / Mid /
  Low). The Overview tiles use early-game numbers that do predict wins: ahead of lane opponents
  at 12:00, no deaths before 10:00, deaths per game. The Overview also shows "what separates
  your wins from your losses".
- **Road to the next rank** (Heroes tab): `nextRankPlan` turns ladder gaps vs the next rank
  into up to three targets. Each shows the number to hit and, where it can be checked game by
  game, a one-click focus habit.
  - The full ladder is folded away, names the minute it shows, and no longer shades deaths,
    kills, assists or win rate (higher ranks fight more, and win rate is ~50% everywhere).
- **Friends tab.** Steam's friends list isn't reachable from a browser, so friends come from
  deadlock-api's teammate history: anyone with 10+ games together. For each friend: win rate
  together vs without them, rank, last played. A friend page adds a head-to-head on your habit
  and who died first in losses, using the same match detail.
  - Match details now keep every player's deaths (`DETAIL_V` 3). This also fixes the
    turning-point death counts, which only ever counted yours.
- **Session recap** on the Overview after you play: record, rank points, habit ticks, deaths
  before 10:00 and the biggest swing.
- **Receipts.** Source badges on key numbers (your games / rank data / trained model / Valve /
  Climb rule / AI) open a short explanation. The Coach tab checks the win model on your own
  games: when the side it favoured at 20:00 won.

## v12 (2026-10-23): Win chance, how each game swung
- `model/train.py` reads recent matches from deadlock-api's public data lake (DuckDB over HTTPS,
  only the needed Parquet columns) and writes `js/wpmodel.js`. It contains:
  - a per-minute logistic win model on the souls, kills, objectives-destroyed and mid-boss gaps;
  - a death-cost table: the median team-souls swing around deaths where nobody else in the lobby
    died, by minute and by how rich the victim was;
  - the extra chance of losing an objective in the 90s after a death.
  Re-run it after big patches.
- Match page: a win-chance chart (your deaths marked, biggest swings shaded), the three turning
  points with what happened in each window, and each death's typical cost in win-chance points.
  Costs are described as typical, not measured for that exact death: snapshots are 3–5 minutes
  apart, so one death can't be isolated in most games.
- Match details now keep objectives and mid-boss (`DETAIL_V` 2), and older cached details are
  re-fetched. The coach's debrief brief gets the timeline, swings and death costs.

## v11 (2026-10-22): Gold for 1st in the lobby
- Valve's post-game MVP #1 (`mvp_rank` 1, i.e. 1st of all 12) is marked gold everywhere a game
  appears: a ★ 1st chip, a gold left edge in the Matches list, a gold match-page role card, and
  ★ MVP on the scoreboard. `gameRole().lobbyFirst` carries it.
- Why Valve's MVP and not Climb's impact: impact is team-relative, so it doesn't rank across the
  lobby. On 60 real games the two "#1"s never agreed (6 Valve MVPs, 3 impact #1s, 0 overlap).
  Gold is the only place that colour is used.

## v10 (2026-10-22): Focus loop
- One habit at a time, chosen from a fixed catalog (`Engine.HABITS`) of things Climb can check per
  game. Examples: no deaths before 10:00, never caught out, ahead of lane opponents at 12:00,
  25 CS by 12:00, tier 4 by 24:00. Habits that partly follow the result (late deaths, death rate)
  are tagged.
- A habit is only offered if passing it split your own wins from losses by 10+ points over your
  last 30 games (`habitCatalog`). "Tier 3 by 13:00" made no difference for the user, so it isn't
  offered.
- "Let the coach pick": Gemini chooses from the eligible ids (an enum, so it can't invent a
  habit) and says why and how. Without a key, Climb picks the habit with the biggest split
  (`suggestHabit`).
- Every game since the start gets a ✓ or ✗ (Overview card, Coach tab, Matches list). After 15
  games the pass rate is compared with your baseline, with a 2-SE threshold (`focusProgress`). A
  habit is mastered at 7 of your last 10. Past habits are kept.
- Why habits and not averaged targets: on 60 real games, a 1-death change in late deaths needed
  ~60 games to detect. A pass-rate change shows in ~15.

## v9 (2026-10-21): Fix for the deadlock-api 404
- deadlock-api answers 404 "No matches found" when none of a batch's matches exist on its side.
  That happens for the oldest 2024 matches. Since v6 fetches lobbies for every match, this stopped
  loading with "Couldn't reach deadlock-api: deadlock-api 404 on /v1/matches/metadata". Bulk and
  single metadata calls now treat that 404 as empty, so those matches are recorded as having no
  lobby data.

## v8 (2026-10-21): Coach tab, your last 30 games read together
- New **Coach** tab. Climb counts patterns across your last 30 games, wins vs losses, using
  `Engine.aggregateGames`:
  - deaths per game, deaths before 10:00, deaths per phase, and caught-out deaths (died within 5s);
  - death zones and the heroes that kill you most;
  - souls vs your lane opponents at 6, 12 and 20 min, and the 20–30 min swing;
  - when you finish your first tier-3 and tier-4 items;
  - per-hero deaths.
- "Analyze my last 30 games" sends only those counts (~3 KB, `analysisBrief`) to Gemini in one
  call. It also includes your two most-played heroes' gaps against the next rank. Gemini returns
  the three patterns costing you the most games, what to keep doing, and a plan for your next
  sessions. The result is cached until you play a new game.
- Match details for the last 30 games are fetched 10 at a time (~15 MB once) and kept compact
  (~6 KB each, last 60 games).
- Debriefs retry when Gemini is busy (3 tries, 45s limit each), then fall back to another Flash
  model.

## v7 (2026-10-21): AI coach, match debriefs
- Each match page has a "Coach me" button. Gemini gets a ~5 KB brief of that game and returns three
  specific points (strengths and mistakes, each tied to a number) plus one focus for your next game.
  The brief covers:
  - your deaths, with time, killer, map zone and how fast you died;
  - your item buys in order;
  - souls vs your lane opponents at 6, 9, 12, 15, 20, 25 and 30 min;
  - both scoreboards;
  - your gaps against the next rank on that hero.
- Uses your own Gemini key, set in Account & about. It's stored in this browser only and sent only
  to Google. Debriefs are cached per match.
- The coach is told to use only facts in the brief and never to invent hero, item or patch details.

## v6 (2026-10-21): Rebuilt with tabs, any Steam account, and a rank ladder
- The single long page is replaced by four tabs: Overview, Matches, Heroes and Play time. Account
  and About open from the avatar.
- Works for any account: paste a Steam profile link, SteamID64, [U:1:n] or STEAM_0 id, or search
  a Steam name. Each account keeps its own cache. The old single-account cache moves over
  automatically.
- Game roles, from your impact on your own team:
  - wins: Carried, Key player, Solid win, Passenger;
  - losses: Couldn't carry, Key player, Tough loss, Dragged down.
- Game tags: Valve MVPs, top farmer, top damage, most kills, playmaker, objectives, healer,
  frontline, survivor, fed, stomp, marathon.
- Matches tab: every game, filterable. Each match page has the full 12-player scoreboard, your
  share vs an average teammate, and form vs your usual on that hero.
- Heroes tab: pick a hero to see 10 stats vs the average game at all 11 ranks.
  - Stats: win rate, accuracy, souls, lane, jungle, hero damage, objectives, kills, assists,
    deaths.
  - Shows what's holding you back from the next rank, what's already above yours, and which rank
    each stat plays like.
- Lobby data is now kept for every match, not just this season's.

## v5 (2026-10-21): What's new + changelog
- After each update, a "What's new" card says once what changed. Dismiss it with "Got it".
- The full changelog is at the bottom of the page, under "Changelog".

## v4 (2026-10-21): Benchmark, you vs Phantom+ on your heroes
- New card below "Heroes this season". For each of your most-played heroes it shows:
  - your average souls (lane and jungle), objective damage, hero damage and deaths at 15, 20 or
    30 min;
  - the same numbers for your own rank and for Phantom+ lobbies, over the same dates.
- Up to two headlines per hero name the biggest gaps. A gap only shows when it's bigger than your
  normal game-to-game swing.
- It uses games since the last big patch. A hero with fewer than 8 of those widens to the last 60
  days and says so.
- The play-time heatmap now labels every weekday.
- Under the hood: the pre-queue briefing engine and its tests. Nothing shows it yet.

## v3 (2026-10-07): Play time + Ranked / All games
- Play time card: today vs your usual, a 12-week heatmap, and the hours you usually play. It counts
  real time in game when the Climb helper runs on your PC, and match times otherwise.
- Ranked / All games switch (default All). Unranked games join form, consistency, the game list and
  heroes. Rank points stay ranked-only.

## v1 (2026-10-04): Climb v1
- One verdict (Improving, Holding or Slipping) for last session, last 20 and season, built from rank
  points, form on each hero and consistency.
- Games are classed as Earned win, Passenger win, Unlucky loss or Rough game, with lobby tags on
  top.
