/* changelog.js — what changed in each release, newest first. The app shows entries newer than
   the last one you dismissed as a "What's new" card, and the full list in the footer.
   Every deploy that bumps ?v=N adds an entry here with the same v, and the same text goes in
   CHANGELOG.md. */
(function (root) {
  'use strict';
  root.CHANGELOG = [
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
