# Changelog

What changed in each release. The version is the `?v=N` in `index.html`. The app shows the same
entries from [`js/changelog.js`](js/changelog.js): a "What's new" card after an update, and the
full list in the footer. Every deploy that bumps `?v=N` adds an entry to both.

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
