/* changelog.js — what changed in each release, newest first. The app shows entries newer than
   the last one you dismissed as a "What's new" card, and the full list in the footer.
   Every deploy that bumps ?v=N adds an entry here with the same v, and the same text goes in
   CHANGELOG.md. */
(function (root) {
  'use strict';
  root.CHANGELOG = [
    {
      v: 20, date: '2026-10-26', title: 'Setup guide for faster match updates',
      items: [
        'A new page walks you through installing deadlock-api’s ingest tool, so new games show up in Climb within minutes. It covers a normal install, a more private one that only runs while Deadlock is open, and what the tool does with your Steam login.',
        'Find it from “Make new games show up faster” at the top of Matches, the “Missing games?” card, or Account & about. It replaces the old launch-options steps, which didn’t work on some Windows PCs.',
      ],
    },
    {
      v: 19, date: '2026-10-26', title: 'Back to the old Overview',
      items: ['The Today redesign and hero pool are rolled back; Overview and Heroes look as they did in v17.'],
    },
    {
      v: 17, date: '2026-10-26', title: 'Smoother Heroes tab',
      items: [
        'Heroes are listed A–Z, all visible at once on a wide screen. On a phone they stay a sideways strip that opens on the hero you picked.',
        'Sections you open (like “Compare with your rank and the next”) no longer snap shut while data loads, or when your phone’s address bar slides in and out as you scroll.',
        'The match id box is now always at the top of Matches: paste an id and press Add match.',
      ],
    },
    {
      v: 16, date: '2026-10-26', title: 'Squads',
      items: [
        'Friends tab: a leaderboard of who costs your squad least, ranked by the win chance each person loses to their own deaths per game in games with you. Against you it says “better”, “worse”, or “too close to call” when the gap isn’t steady.',
        'Your record solo, as a duo and as a squad (2+ friends), over the last 90 days.',
        'A weekly report of your games together: record, cleanest and most expensive player, death of the week, most improved. “Copy for Discord” copies it as text; “Copy image” as a picture.',
        'Each friend’s page has a scorecard of you vs them on early-game habits, and a catch-up plan for whoever’s behind. With a Gemini key, “Coach us” writes a plan for the two of you.',
        '“+ Add match” is now at the top of the Matches tab.',
      ],
    },
    {
      v: 15, date: '2026-10-26', title: 'Add a match by id',
      items: [
        'Valve’s match history sometimes leaves a game out, even after deadlock-api has it. At the bottom of Matches (and in the “Missing games?” card), paste the match id from Deadlock’s match history and Climb adds the game, with its lobby and rank change.',
        'Added games count everywhere your other games do, and are marked “added by id” on the match page.',
      ],
    },
    {
      v: 14, date: '2026-10-25', title: 'Missing games, explained',
      items: [
        'Under your rank: how recent your newest match on deadlock-api is. Climb refreshes every few minutes; when a game is missing, it’s deadlock-api that hasn’t collected it from Valve yet.',
        'If the Climb helper saw you play after that, a card says so and lists the ways to get your games there within minutes, safest first: a one-time cache upload, or deadlock-api’s ingest tool run from Deadlock’s launch options in cache-only mode. The same guide is under Account & about.',
      ],
    },
    {
      v: 13, date: '2026-10-23', title: 'Road to the next rank, friends, and where every number comes from',
      items: [
        'Heroes tab: “Your road to the next rank” lists up to three targets on that hero, the number to hit and the habit that trains it. The every-rank table is folded away, says which minute it shows, and no longer shades deaths, kills or win rate.',
        'New Friends tab: everyone you’ve played 10+ games with (found from your match history), your win rate with and without them, and a head-to-head on your habit in shared games.',
        'After a session, the Overview shows a recap: your record, your habit ticks and the biggest swing.',
        'Every key number has a small badge (your games, rank data, trained model, Valve, Climb rule, AI). Tap it to see how it was worked out. The Coach tab also shows how the win chance did on your own games.',
        'Carried / Dragged down are retired. Tested on 400 of your games, they didn’t predict wins, so games now show a neutral team share, and the Overview tiles use early-game numbers that do.',
      ],
    },
    {
      v: 12, date: '2026-10-23', title: 'Win chance: how each game swung',
      items: [
        'Every match page now shows your team’s win chance minute by minute, from a model Climb trained on hundreds of thousands of recent Deadlock matches (souls, kills, objectives and mid-boss).',
        'The three biggest swings are listed with what happened in each, and every death of yours shows what a death like it usually costs in win chance: more later in the game, and more when you were rich.',
        'The AI coach now gets this timeline too, so its debrief starts from measured turning points instead of guesses.',
      ],
    },
    {
      v: 11, date: '2026-10-22', title: 'Gold for 1st in the lobby',
      items: [
        'Games where Valve named you MVP (1st in the whole lobby) now stand out in gold: a ★ 1st badge and a gold edge in the Matches list and recent matches, and a gold role card on the match page.',
      ],
    },
    {
      v: 10, date: '2026-10-22', title: 'Focus loop: one habit at a time',
      items: [
        'Pick one habit in the Coach tab, or let the coach pick it. Every game after that gets a ✓ or ✗, shown on the Overview, the Coach tab and the Matches list.',
        'Only habits that actually split your wins from your losses can be picked. Each shows how often you pass it and your win rate when you do vs don’t.',
        'After 15 games Climb tells you whether your pass rate really moved. A habit is mastered at 7 of your last 10, then you pick the next. Past habits are kept with their results.',
      ],
    },
    {
      v: 9, date: '2026-10-21', title: 'Fix: “Couldn’t reach deadlock-api: 404”',
      items: [
        'Your oldest matches (mid-2024) have no lobby data on deadlock-api, and a batch of only those made Climb stop loading with a 404. They’re now marked as “No lobby data” and loading carries on.',
      ],
    },
    {
      v: 8, date: '2026-10-21', title: 'Coach tab: your last 30 games, read together',
      items: [
        'New Coach tab. Climb counts patterns across your last 30 games, wins vs losses: deaths per game and before 10:00, when and where you die and who kills you, souls vs your lane opponents at 12 and 20 minutes, the 20–30 minute swing, and when you finish your first tier-3 and tier-4 items.',
        '“Analyze my last 30 games” sends just those numbers to Gemini (one call) and returns the three patterns costing you the most games, what to keep doing, and a plan for your next sessions. It updates when you’ve played new games.',
        'Debriefs retry automatically when Gemini is busy, and fall back to another Flash model.',
      ],
    },
    {
      v: 7, date: '2026-10-21', title: 'AI coach: match debriefs',
      items: [
        'Every match page has a “Coach me” button. Gemini reads that game (your deaths and where they happened, item timings, souls vs your lane opponents, your gaps against the next rank on that hero) and gives three specific points plus one focus for your next game.',
        'Uses your own Gemini API key, added in Account & about. It stays in this browser and is only ever sent to Google.',
      ],
    },
    {
      v: 6, date: '2026-10-21', title: 'Rebuilt: tabs, any Steam account, rank ladder',
      items: [
        'Climb is now four tabs at the top (Overview, Matches, Heroes, Play time) instead of one long page.',
        'Use it for any account: paste a Steam profile link or SteamID, or search a Steam name. Click your avatar (top right) to switch.',
        'Every game now gets a role from your impact on your own team: Carried, Key player, Solid win, Passenger, Couldn’t carry, Tough loss or Dragged down. Plus tags: Valve MVPs, top farmer, top damage, most kills, objectives, healer, frontline, survivor, fed, stomp.',
        'Matches tab: every game with filters by hero, result, role and mode. Click one for the full 12-player scoreboard and how you compared with your teammates.',
        'Heroes tab: pick a hero and see 10 stats against the average player at every rank from Initiate to Eternus, what’s holding you back from the next rank, and which rank each stat plays like.',
      ],
    },
    {
      v: 5, date: '2026-10-21', title: 'What’s new + changelog',
      items: [
        'This card: after each update Climb tells you once what changed, then gets out of the way.',
        'The full changelog is at the bottom of the page, under “Changelog”.',
      ],
    },
    {
      v: 4, date: '2026-10-21', title: 'Benchmark: you vs Phantom+ on your heroes',
      items: [
        'New card below “Heroes this season”. For each of your most-played heroes it shows your average souls (lane and jungle), objective damage, hero damage and deaths at 15, 20 or 30 minutes, next to your own rank and Phantom+ lobbies over the same dates.',
        'Up to two headlines per hero name the biggest gaps. A gap only shows when it’s bigger than your normal game-to-game swing.',
        'It uses games since the last big patch. A hero with fewer than 8 of those widens to the last 60 days and says so.',
        'Play-time heatmap now labels every weekday.',
      ],
    },
    {
      v: 3, date: '2026-10-07', title: 'Play time + Ranked / All games',
      items: [
        'Play time card: today vs your usual, a 12-week heatmap and when-you-play hours. Counts real time in game when the Climb helper runs on your PC, match times otherwise.',
        'Ranked / All games switch (default All). Unranked games join form, consistency, the game list and heroes; rank points stay ranked-only.',
      ],
    },
    {
      v: 1, date: '2026-10-04', title: 'Climb v1',
      items: [
        'One verdict (Improving, Holding or Slipping) for last session, last 20 and season, from rank points, form on each hero and consistency.',
        'Games classed as Earned win, Passenger win, Unlucky loss or Rough game, plus lobby tags.',
      ],
    },
  ];
})(window);
