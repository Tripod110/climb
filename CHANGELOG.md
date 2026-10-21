# Changelog

What changed in each release. The version is the `?v=N` in `index.html`. The app shows the same
entries from [`js/changelog.js`](js/changelog.js): a "What's new" card after an update, and the
full list in the footer. Every deploy that bumps `?v=N` adds an entry to both.

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
