/* changelog.js — what changed in each release, newest first. The app shows entries newer than
   the last one you dismissed as a "What's new" card, and the full list in the footer.
   Every deploy that bumps ?v=N adds an entry here with the same v (shown to users as 0.v), and the same text goes in
   CHANGELOG.md. */
(function (root) {
  'use strict';
  root.CHANGELOG = [
    {
      v: 46, date: '2026-11-07', title: 'Your rank on every match',
      items: [
        'Every game in Matches (and on a friend’s page) has a small badge for the rank you played it at.',
        'Unranked games show your rank at the time, dimmer. Placement games say “Placement”.',
        'A match page names it too: “you played at Ritualist 1”.',
      ],
    },
    {
      v: 45, date: '2026-11-07', title: 'Clearer numbers, at every rank',
      items: [
        'Every number says what it is: “Souls lead at 12:00”, “No deaths to 10:00”, “Rank pts”, “+340 pts”, and changes in % instead of “pts”. The ★ 1st badge is now ★ MVP.',
        'Coach shows each stat as “in wins vs in losses”, with which way is better, and only the better side lit up.',
        'Account & about has a short glossary of every term. A one-time tip on Overview points to the small ⓘ rings that explain each number.',
        'Works for every player: “Calibrating” during placement games, Heroes compares Eternus players with the Eternus average and new players with Initiate, and the match page no longer scrolls sideways on phones.',
      ],
    },
    {
      v: 44, date: '2026-11-07', title: 'A tidy-up behind the scenes',
      items: [
        'Nothing looks different: this release removes code and styles left over from Climb’s older designs, so there’s less to download.',
        'The setup notes for anyone working on Climb now describe the app as it is today.',
      ],
    },
    {
      v: 43, date: '2026-11-02', title: 'Friends: how you really stack up',
      items: [
        'The Friends board used to rank on deaths alone, so someone who played safe looked better than they were. It now ranks on souls, damage or healing, kills + assists and staying alive, each against the lobby average in the games you played together.',
        'Small samples are pulled toward average, so 12 games can’t top 200. “Ahead of you” or “behind you” only shows when the gap holds across your games together.',
        'Death cost is still there as a column, and a friend’s page shows the same four stats side by side.',
      ],
    },
    {
      v: 42, date: '2026-11-02', title: 'Your hero pool, sorted',
      items: [
        'The scrolling hero bar is gone. Heroes are now grouped by how they do for you over the last 90 days: Climb on these, Steady, and Park for now, each best first, with win rate, record and rank points on every tile.',
        'Heroes with only a few games lately, and ones you haven’t played in 90 days, sit underneath as small chips. Picking any hero jumps straight to it.',
      ],
    },
    {
      v: 41, date: '2026-11-02', title: 'Your best hero, and the one to park',
      items: [
        'Heroes now opens with a scouting row over your last 90 days: your best hero, the one to park while you climb, most rank points, biggest drain, the hero on the rise and your most played. Tap one to open it.',
        'A small sample can’t win “best”: each hero’s win rate is weighed against your overall win rate, and best or park-it need 10+ games.',
        'Every hero is now in one scrolling strip, and the folded comparison tables are gone.',
      ],
    },
    {
      v: 40, date: '2026-11-02', title: 'Heroes and Friends, redesigned',
      items: [
        'Heroes now matches the rest of Climb: your eight busiest heroes in a strip (every hero folds below), five numbers for the picked hero, and the road to the next rank as you → their average figures with a Train it button.',
        'Coach me on Heroes shows that hero’s habits as won-with-it bars with the suggested one first, and its deaths in wins vs losses.',
        'Friends shows the leaderboard as bars: win chance lost to each person’s own deaths, lower is better, you highlighted.',
        'A friend’s page is numbers first: win rate together vs without them, a side-by-side scorecard, the catch-up targets, and your recent games together as match rows.',
      ],
    },
    {
      v: 39, date: '2026-11-02', title: 'Matches, redesigned',
      items: [
        'Matches now opens with four numbers for whatever you’ve filtered: win rate, average K/D/A, souls a game and rank points.',
        'Games are grouped by day, each day with its record and rank points, and each game shows a Form number (how you played vs your usual) in place of the text chips.',
        'Wins/Losses and Ranked/Unranked are quick toggles, the list shows 60 games with a Show more button, and “Missing a game?” folds away.',
      ],
    },
    {
      v: 38, date: '2026-11-02', title: 'Coach, redesigned',
      items: [
        'Coach now matches Overview: five sections (Training, Wins vs losses, Farm, Deaths, Coach’s notes), numbers first, with the explanations behind the small i.',
        'With no habit picked, the three habits that win you the most games sit at the top with their won-with-it bars and a Pick button; the rest fold under “All habits”.',
        'Your wins and losses are side by side for each stat. Farm shows your gap to your lane opponents at 12:00 for lane creeps, camps and boxes, plus creep kill %.',
        'Gemini’s notes show the headline; each pattern and the plan open on tap. The win-model check moved to Account & about, and the heroes table is gone (it’s on Heroes).',
      ],
    },
    {
      v: 37, date: '2026-11-02', title: 'Rank-ups on the climb chart',
      items: [
        'The marks on the season chart are the games where your rank changed: ▲ when you ranked up, ▼ when you ranked down, with a key under the chart.',
        'Hover one to see the rank you moved to.',
      ],
    },
    {
      v: 36, date: '2026-11-02', title: 'What wins you games, in one bar',
      items: [
        'Each habit is now one bar. Green to the right is how often you won when it happened; a quiet grey to the left is how often you lost when it didn’t.',
      ],
    },
    {
      v: 33, date: '2026-11-02', title: 'Form now counts your farm',
      items: [
        'Form (how you played vs your usual on that hero) now includes your farm: lane, camp and box souls by 12:00 against your lane opponents, next to souls, damage, kills + assists and staying alive.',
        'It applies to your recent games that have match detail; older games still score on the other four. A match’s page shows it as “Farm by 12:00”.',
      ],
    },
    {
      v: 32, date: '2026-11-02', title: 'Rank projection',
      items: [
        'The climb now shows where your current pace takes you: your rank today, then in 20, 50 and 100 more ranked games, with the best-to-worst range under each.',
        'When you’re climbing it also says how many games until the next tier. It projects divisions, not rank points, and only shows when your last 40 ranked games agree on a direction.',
      ],
    },
    {
      v: 31, date: '2026-11-02', title: 'Overview: numbers, not sentences',
      items: [
        'The verdict’s three reasons are now figures: rank points, form (with what it was before) and rough games (with what it was before).',
        'Your focus habit, pace and last session show as numbers: pass rate and win rate before → now, games per division with the range and next rank, and your last session as record, points, early deaths and the biggest swing.',
        'The longer explanations are one tap away: the small i next to a number, or the folded “Missing games” notice.',
      ],
    },
    {
      v: 30, date: '2026-11-02', title: 'A new look for Overview',
      items: [
        'Overview is redesigned to read like a scouting report: the verdict up top, your key numbers in one row, then Training (your focus habit and pace), Scouting (what wins you games), Film room (your last 8 matches) and The climb (rank points).',
        'What wins you games now shows each habit as two markers on a win-rate line: red for when you skip it, green for when you do it. The wider the gap, the more that habit matters.',
        'A Deadlock-style brass and condensed-type finish across the app. Green and red still only ever mean good and bad.',
      ],
    },
    {
      v: 29, date: '2026-11-02', title: 'Version numbers are 0.x',
      items: [
        'Releases are now numbered 0.N (this is 0.29) instead of vN, since Climb is not 1.0 yet. Earlier releases keep their numbers: v28 is now 0.28.',
      ],
    },
    {
      v: 28, date: '2026-11-01', title: 'Lane colours',
      items: [
        'Lanes now use the in-game colours: Yellow, Blue and Green, with where each sits from your base in brackets, e.g. Yellow lane (left). The colours are fixed places on the map, so a team swap only changes left and right.',
      ],
    },
    {
      v: 27, date: '2026-11-01', title: 'Farm: tabs and named lanes',
      items: [
        'The match Farm card now says who you are compared with: your own souls against the average of the player(s) against you in the same lane as you (their heroes are named), not the whole enemy team.',
        'New tabs: Summary, Lane creeps, Jungle and Boxes. Each source tab shows you against your lane opponents at every snapshot (and lane creeps killed), plus a lane-by-lane view of that source.',
        'Lanes are named by where they are on the map, as you face the enemy base: Left, Centre or Right lane (the data’s lane ids 1, 4 and 6 are fixed places), with the heroes in each lane shown and yours marked.',
        'The summary says whether your biggest gap is usual for you or an exception, and how many times you died before 12:00. The treasure row is gone (it is almost always 0 by 12:00).',
      ],
    },
    {
      v: 26, date: '2026-11-01', title: 'Farm analyzer',
      items: [
        'Every match now has a Farm card: the souls you had from lane creeps, jungle camps, boxes & breakables and treasure at 12:00, against the average of your lane opponents, with your biggest gap named and a lane-by-lane comparison.',
        'The Coach tab has a “How you farm against your lane” card over your last 30 games. It only says you trail a source when the gap is 150+ souls and shows in both halves of your games.',
        'Two new farm habits you can focus on: more camp + box souls than your lane opponents at 12:00, and killing 80%+ of the lane creeps by 12:00. Unlike “tier 3 by 14:00”, they don’t depend on already being rich.',
        'deadlock-api only records souls by source a few times a match, not which camp or box you took or when, so Climb says what you got, never which spawn you missed.',
        'Your recent games reload once in the background to read the new data. Lane souls in the AI debrief also stop being double counted.',
      ],
    },
    {
      v: 25, date: '2026-10-28', title: 'Proof your habit works, and your climb pace',
      items: [
        'Your focus card now shows your win rate before you started the habit against every game since, with your win rate when you passed it vs when you didn’t. It only calls a change when it clears normal swing, and warns when the pass rate is up in only one half of your games (a streak).',
        'Overview has a new “Your climb” card: how many ranked games each division has taken you over your last 40, with a range, or “holding” / “sliding” when that’s what both halves of those games say. It measures divisions you actually moved through, not a rank-point prediction, because Valve’s points don’t convert to divisions at a fixed rate.',
      ],
    },
    {
      v: 24, date: '2026-10-28', title: 'Coaching first',
      items: [
        'Friends is now just the leaderboard: who costs the squad least, and the per-friend catch-up plan. The weekly Discord report and the solo / duo / squad record are gone from the page.',
        'The Play time tab is hidden from the menu. Your hours still feed the session recap on Overview.',
        'Overview is leaner: the MVP awards tile and the “Heroes in this window” card are removed (Heroes has all of it).',
        'The match page no longer shows the role-tag chips; your share, the comparison with your usual, win chance and the coach card stay.',
      ],
    },
    {
      v: 23, date: '2026-10-28', title: 'Clearer matches, tidier Friends',
      items: [
        'Street Brawl games are left out everywhere (they’re a different game, so their numbers only muddied yours).',
        'Matches: the “Top / Mid / Low share” chip is gone. A game now shows “Above your usual” or “Below your usual” when you clearly played better or worse than your other games on that hero, plus up to two chips with the number, like “Only 2 deaths”, “+54% souls” or “11 deaths”. The gold ★ 1st for Valve’s MVP stays.',
        'The Matches filter follows: Any performance, ★ 1st in the lobby, Above your usual, Below your usual.',
        'Friends: “Everyone you queue with” is removed.',
      ],
    },
    {
      v: 22, date: '2026-10-28', title: 'Coach me on Heroes',
      items: [
        'Heroes has a new “Coach me” view next to “Rank road”. For the hero you picked it shows the habit that most separates that hero’s wins from its losses, with your win rate when you pass it and when you miss it, deaths per game in wins vs losses, who kills you most, and the stats that trail the next rank.',
        'It reads your last 30 games on the hero and says when the sample is thin. “Make this my focus” turns the suggested habit into your focus habit.',
      ],
    },
    {
      v: 21, date: '2026-10-28', title: 'Bug fixes',
      items: [
        'Games you add by match id no longer count as new games on a focus habit.',
        'A game whose lobby deadlock-api didn’t have yet is retried the next time you open Climb (for games under 3 days old), instead of staying “no lobby data”.',
        'If the profile, rank or patch lookup fails, your games and lobbies still load.',
        'A long focus habit keeps match details for every game since you started, so its pass rate no longer drops early games after 60.',
      ],
    },
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
