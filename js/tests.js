/* tests.js — engine tests. Run:  node js/tests.js   (exits 1 on any failure)
   Synthetic data only, so the expected numbers can be worked out by hand. */
(function (root) {
  'use strict';
  if (typeof require === 'function' && !root.Engine) require('./engine.js');
  const E = root.Engine;
  const results = [];
  const eq = (name, got, want) => results.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });
  const ok = (name, cond, got) => results.push({ name, ok: !!cond, got, want: true });
  const near = (name, got, want, tol) => results.push({ name, ok: Math.abs(got - want) <= (tol || 1e-9), got, want });

  // ---------------------------------------------------------------- normalise
  const row = (o) => Object.assign({
    match_id: 1, start_time: 1000, match_mode: 4, hero_id: 7, match_result: 1, player_team: 1,
    ranked_delta: 300, ranked_display_badge: 41, ranked_calibration_match: 0, match_duration_s: 1800,
    player_kills: 5, player_deaths: 3, player_assists: 10, net_worth: 40000, last_hits: 200,
  }, o);
  const n = E.normalizeMatch(row({}));
  eq('win = match_result === player_team', n.won, true);
  eq('loss when teams differ', E.normalizeMatch(row({ match_result: 0 })).won, false);
  eq('mode 4 = ranked', n.mode, 'ranked');
  eq('mode 1 = unranked', E.normalizeMatch(row({ match_mode: 1 })).mode, 'unranked');
  eq('null delta stays null', E.normalizeMatch(row({ ranked_delta: null })).delta, null);
  eq('zero delta stays zero', E.normalizeMatch(row({ ranked_delta: 0 })).delta, 0);
  eq('history drops other modes + sorts asc',
    E.normalizeHistory([row({ match_id: 2, start_time: 20 }), row({ match_id: 3, match_mode: 3 }), row({ match_id: 1, start_time: 10 })]).map(m => m.id), [1, 2]);

  // ---------------------------------------------------------------- compact lobby
  const meta = {
    average_badge: 40,
    players: Array.from({ length: 12 }, (_, i) => ({
      account_id: i === 4 ? E.ACCOUNT_ID : 1000 + i, team: i % 2 ? 'Team1' : 'Team0',
      net_worth: 30000 + i * 1000, kills: i, deaths: 11 - i, assists: 5,
      final_stats: { player_damage: 10000 + i * 500, player_healing: i === 4 ? 9000 : 100 },
    })),
  };
  const L = E.compactLobby(meta);
  eq('lobby finds me', L.me, 4);
  eq('lobby team parsed from "Team0"', L.p[4][0], 0);
  eq('lobby row shape', L.p[4].slice(0, 7), [0, 34000, 4, 7, 5, 12000, 9000]);
  eq('lobby v2 keeps account id + version', [L.p[4][15], L.v], [E.ACCOUNT_ID, E.LOBBY_V]);
  eq('lobby without me is null', E.compactLobby({ players: meta.players.slice(5) }), null);

  // ---------------------------------------------------------------- lobby stats
  const S = E.lobbyStats(L);
  eq('souls rank (8th of 12)', S.ranks.souls, 8);
  eq('deaths rank (fewest = 1)', S.ranks.deaths, 8);
  eq('heal rank 1', S.ranks.heal, 1);
  eq('tags: only support', S.tags, ['support']);
  const top = E.lobbyStats(Object.assign({}, L, { me: 11 }));
  eq('top player gets farmer/damage/playmaker/survivor', top.tags, ['farmer', 'damage', 'playmaker', 'survivor']);
  eq('ties share the better rank', E.lobbyStats({ me: 0, p: [[0, 5, 0, 1, 0, 0, 0], [1, 5, 0, 1, 0, 0, 0]] }).ranks.souls, 1);
  near('deaths ratio inverted (fewer deaths > 1)', top.ratio.deaths, (5.5 + 1) / (0 + 1));

  // ---------------------------------------------------------------- perf scores & classes
  // Hero 7: five games. Souls ratio is the only thing that varies between them.
  function mkLobby(mySouls) {
    const p = Array.from({ length: 12 }, () => [0, 30000, 5, 5, 5, 20000, 0]);
    p[0] = [0, mySouls, 5, 5, 5, 20000, 0];
    return { me: 0, p };
  }
  const games = [30000, 30000, 30000, 30000, 60000].map((s, i) => ({ id: 100 + i, t: 1000 + i * 4000, hero: 7, won: i % 2 === 0, mode: 'ranked', delta: i % 2 ? -300 : 300, dur: 1800 }));
  const lobbies = {};
  games.forEach((g, i) => { lobbies[g.id] = mkLobby([30000, 30000, 30000, 30000, 60000][i]); });
  const perf = E.perfScores(games, lobbies, games);
  ok('big souls game scores above usual', perf.get(104).score > 0, perf.get(104).score);
  ok('ordinary games score at/below usual', perf.get(100).score <= 0, perf.get(100).score);
  ok('per-stat z is capped at 3', Object.values(perf.get(104).z).every(z => z == null || Math.abs(z) <= 3), perf.get(104).z);
  eq('leave-one-out base size', perf.get(104).base, 4);
  eq('earned win', E.classify(games[4], perf.get(104)), 'earned');
  eq('rough game (loss, below usual)', E.classify(games[1], perf.get(101)), 'rough');
  eq('passenger win (win, below usual)', E.classify(games[0], perf.get(100)), 'passenger');
  eq('unlucky loss', E.classify({ won: false }, { score: 0.5 }), 'unlucky');
  eq('no perf -> unclassified', E.classify(games[0], undefined), null);
  const four = E.perfScores(games.slice(0, 4), lobbies, games.slice(0, 4));
  eq('hero with < 5 games has no baseline', four.size, 0);
  eq('a game with no lobby is skipped', E.perfScores(games, { 100: lobbies[100] }, games).size, 0);

  // ---------------------------------------------------------------- windows
  const H = 3600, D = 86400;
  const ranked = [];
  for (let i = 0; i < 5; i++) ranked.push({ id: i, t: 0 + i * D, dur: 1800, delta: 300 });          // old season
  for (let i = 0; i < 30; i++) ranked.push({ id: 10 + i, t: 100 * D + i * D, dur: 1800, delta: 300 }); // new season, daily
  for (let i = 0; i < 4; i++) ranked.push({ id: 50 + i, t: 140 * D + i * H, dur: 1800, delta: 300 }); // tonight, back to back
  eq('season starts after 45-day hole', E.seasonOf(ranked)[0].id, 10);
  eq('session = back-to-back games', E.sessionOf(ranked).map(m => m.id), [50, 51, 52, 53]);
  const w = E.windowsFor('session', ranked);
  eq('session prev = 20 games before', w.prev.length, 20);
  eq('last20 window', E.windowsFor('last20', ranked).cur.length, 20);
  const ws = E.windowsFor('season', ranked);
  eq('season split in halves', [ws.prev.length, ws.cur.length], [17, 17]);

  // ---------------------------------------------------------------- verdict
  const P = new Map();
  const mk = (id, won, score, delta) => { P.set(id, { score }); return { id, won, delta }; };
  const good = [mk(1, true, 0.8, 400), mk(2, true, 0.5, 400), mk(3, false, 0.3, -300), mk(4, true, 0.6, 400)];
  const bad = [mk(5, false, -0.6, -300), mk(6, false, -0.4, -300), mk(7, true, -0.5, 300), mk(8, false, 0.1, -300)];
  const sg = E.summarize(good, P), sb = E.summarize(bad, P);
  eq('summary quadrants', sg.q, { earned: 3, unlucky: 1, passenger: 0, rough: 0 });
  eq('summary net', sg.net, 900);
  eq('rank unit = median swing', E.rankUnit([{ delta: 300 }, { delta: -300 }, { delta: 410 }, { delta: 0 }]), 300);
  eq('good after bad = improving', E.verdict(sg, sb, 300).call, 'improving');
  eq('bad after good = slipping', E.verdict(sb, sg, 300).call, 'slipping');
  eq('rank up alone, form/consistency flat = holding', E.verdict(sg, sg, 300).call, 'holding');
  const flat = E.summarize([mk(9, true, 0, 300), mk(10, false, 0, -300), mk(11, true, 0.1, 300), mk(12, false, -0.1, -300)], P);
  eq('flat everything = holding', E.verdict(flat, flat, 300).call, 'holding');
  eq('nothing = unknown', E.verdict(E.summarize([], P), null, 300).call, 'unknown');
  eq('small sample = low confidence', E.verdict(sg, sb, 300).confidence, 'low');
  eq('rank signal never claims a reason (just numbers)', Object.keys(E.verdict(sg, sb, 300).signals[0].detail), ['net', 'wins', 'losses']);

  // Climbing into tougher lobbies: a form dip is not counted against you.
  const Lb = { 1: { avgBadge: 24 }, 2: { avgBadge: 24 }, 3: { avgBadge: 24 }, 4: { avgBadge: 24 }, 5: { avgBadge: 42 }, 6: { avgBadge: 42 }, 7: { avgBadge: 42 }, 8: { avgBadge: 42 } };
  const climbing = E.summarize([mk(5, true, -0.6, 400), mk(6, true, -0.4, 400), mk(7, true, -0.5, 300), mk(8, false, -0.6, -300)], P, Lb);
  const before = E.summarize(good, P, Lb);
  eq('ladder: Seeker 4 -> 16, Sentinel 2 -> 26', [E.ladder(24), E.ladder(42)], [16, 26]);
  const vc = E.verdict(climbing, before, 300);
  eq('tougher lobbies flagged', vc.tougher, true);
  eq('form dip neutralised in tougher lobbies', vc.signals[1].dir, 0);
  eq('climbing + keeping pace in tougher lobbies = improving', vc.call, 'improving');

  // ---------------------------------------------------------------- briefing
  {
    const now = 200 * D;
    const g = [];
    let id = 1;
    const add = (hero, won, delta, extra) => g.push(Object.assign({ id: id++, t: now - 20 * D + id * H, dur: 1800, hero, won, delta, badge: 42, souls: 36000, d: 5 }, extra));
    for (let i = 0; i < 10; i++) add(1, i < 8, i < 8 ? 400 : -300);                      // hot: 8-2
    for (let i = 0; i < 8; i++) add(2, i < 2, i < 2 ? 300 : -300, { d: i < 3 ? 4 : 8 }); // cold: 2-6, dying more lately
    for (let i = 0; i < 3; i++) add(3, true, 300);                                        // too few games to name
    const names = { 1: 'Pocket', 2: 'Paradox', 3: 'Shiv' };
    const lob = {};
    g.forEach(m => { lob[m.id] = { me: 0, p: Array.from({ length: 12 }, (_, j) => [0, j === 0 ? (m.won ? 50000 : 20000) : 30000, 5, 5, 5, 1, 0]) }; });
    const b = E.briefing(g, lob, { now, heroName: h => names[h] });
    eq('briefing title', b.title, 'Sentinel 2 · last 20: 12–8, +1,900');
    eq('briefing hot hero', b.hot, 'Pocket is gaining you rank: 8–2, +2,600 over its last 10');
    eq('briefing cold hero + stat shift', b.cold, 'Paradox is costing you rank: 2–6, −1,200 over its last 8, dying more (8.0 vs 4.0)');
    ok('briefing lever names souls split', /top 3 in souls/.test(b.lever), b.lever);
    eq('briefing ignores heroes not played in 30 days', E.briefing(g, lob, { now: now + 60 * D, heroName: h => names[h] }).hot, null);
    eq('briefing on no games', E.briefing([], {}, {}), null);
    eq('stat shift needs 8 games', E.heroStatShift(g.slice(0, 5)), null);
  }

  // ---------------------------------------------------------------- benchmark
  {
    const now = 100 * D, patch = now - 10 * D;
    eq('last big patch = latest one not in the future',
      E.lastBigPatch([new Date((now + D) * 1000).toISOString(), new Date(patch * 1000).toISOString(), '2020-01-01T00:00:00Z'], now), patch);
    eq('no patch days', E.lastBigPatch([], now), null);

    const g = [];
    const add = (hero, daysAgo) => g.push({ hero, t: now - daysAgo * D });
    for (let i = 0; i < 9; i++) add(1, 2);                          // 9 since patch: patch window
    for (let i = 0; i < 3; i++) add(2, 2); for (let i = 0; i < 4; i++) add(2, 30);  // 3 since, 7 in 60d: widened
    for (let i = 0; i < 2; i++) add(3, 2); for (let i = 0; i < 2; i++) add(3, 40);  // 4 in 60d: dropped
    for (let i = 0; i < 6; i++) add(4, 80);                         // nothing in 60d: dropped
    const w1 = E.benchWindow(g, 1, patch, now);
    eq('enough games since patch: patch window', [w1.from, w1.n, w1.widened], [patch, 9, false]);
    const w2 = E.benchWindow(g, 2, patch, now);
    eq('too few since patch: widened to 60 days, spans patch', [w2.from, w2.n, w2.widened, w2.spansPatch], [now - 60 * D, 7, true, true]);
    eq('too few even in 60 days: not benchmarked', E.benchWindow(g, 3, patch, now), null);
    eq('patch older than 60 days widens back to the patch', E.benchWindow(g, 4, now - 90 * D, now).from, now - 90 * D);
    eq('bench heroes: qualifying ones, most games first', E.benchHeroes(g, patch, now).map(w => w.hero), [1, 2]);

    eq('Sentinel bracket vs Phantom+', E.benchBrackets(43), { bracket: { min: 41, max: 46, tier: 4 }, ref: { min: 91, tier: 9 } });
    eq('Phantom compares with Eternus', E.benchBrackets(95).ref, { min: 111, tier: 11 });
    eq('Eternus has no reference', E.benchBrackets(114).ref, null);

    const row = (t, n, o) => Object.assign({ game_time: t, samples: n }, ...E.BENCH_STATS.flatMap(s => s.f).map(f => ({ [f + '_avg']: 0, [f + '_std']: 0 })), o);
    const cc = E.compactCurve([row(600, 9, {}), row(1200, 10, { gold_lane_creep_avg: 4000, gold_lane_creep_orbs_avg: 1000, gold_lane_creep_std: 300, gold_lane_creep_orbs_std: 100 })]);
    eq('curve keeps bench times only', Object.keys(cc), ['1200']);
    eq('lane souls = creeps + orbs, SDs added', cc[1200].lane, [5000, 400]);

    // You: 10 games, jungle 1400±800 vs ref 2100 → gap −700, SE 253, called. Lane 4700±800 vs
    // 4900 → −4%, under the floor. Deaths 2 vs 3 → ahead.
    const curve = o => ({ 1200: Object.assign({ n: 10 }, ...E.BENCH_STATS.map(s => ({ [s.key]: [100, 0] })), o) });
    const cmp = E.benchCompare(
      curve({ jungle: [1400, 800], lane: [4700, 800], deaths: [2, 0.5] }),
      curve({ jungle: [2000, 0] }),
      curve({ jungle: [2100, 0], lane: [4900, 0], deaths: [3, 0] }));
    const at = k => cmp.times[1200].rows.find(r => r.key === k);
    eq('jungle gap called', [at('jungle').gap, at('jungle').sig, at('jungle').good], [-700, true, false]);
    eq('bracket shown alongside', at('jungle').bracket, 2000);
    eq('small gap not called', at('lane').sig, false);
    eq('fewer deaths = good', [at('deaths').sig, at('deaths').good], [true, true]);
    eq('headlines: behind first', cmp.headlines.map(h => h.key), ['jungle', 'deaths']);
    eq('no reference: nothing called', E.benchCompare(curve({}), null, null).headlines, []);
  }

  // ---------------------------------------------------------------- steam id
  eq('steam64 -> account', E.parseSteamInput('76561198147259613'), { account: 186993885 });
  eq('profile url -> account', E.parseSteamInput('https://steamcommunity.com/profiles/76561198147259613/'), { account: 186993885 });
  eq('[U:1:n]', E.parseSteamInput('[U:1:186993885]'), { account: 186993885 });
  eq('STEAM_0:x:y', E.parseSteamInput('STEAM_0:1:93496942'), { account: 186993885 });
  eq('bare account id', E.parseSteamInput(' 186993885 '), { account: 186993885 });
  eq('vanity url -> search', E.parseSteamInput('https://steamcommunity.com/id/tripod/'), { search: 'tripod' });
  eq('name -> search', E.parseSteamInput('Tripod'), { search: 'Tripod' });
  eq('empty', E.parseSteamInput('  '), null);

  // ---------------------------------------------------------------- roles
  {
    // row: [team, souls, k, d, a, dmg, heal, hero, obj, taken, lh, denies, mvp, lane, acc, acct]
    const pl = (team, souls, k, d, a, dmg, o) => Object.assign([team, souls, k, d, a, dmg, 0, 1, 1000, 10000, 100, 5, 0, 1, 50, 0], o || {});
    const lobby = (meRow, won, dur) => {
      const p = [meRow];
      for (let j = 0; j < 5; j++) p.push(pl(0, 30000, 5, 5, 8, 25000));
      for (let j = 0; j < 6; j++) p.push(pl(1, 30000, 5, 5, 8, 25000));
      return { v: E.LOBBY_V, me: 0, p, dur: dur || 1800, win: won ? 0 : 1 };
    };
    const carry = E.gameRole(lobby(pl(0, 50000, 14, 2, 10, 50000), true), true);
    eq('carried: won as team #1 by a distance', [carry.role, carry.teamRank], ['carried', 1]);
    ok('carry tags', ['farm', 'dmg', 'kills', 'survivor'].every(t => carry.tags.includes(t)), carry.tags);
    eq('lonewolf: same game lost', E.gameRole(lobby(pl(0, 50000, 14, 2, 10, 50000), false), false).role, 'lonewolf');
    const drag = E.gameRole(lobby(pl(0, 18000, 1, 12, 3, 9000), false), false);
    eq('dragged: lost at the bottom of the team', [drag.role, drag.teamRank], ['dragged', 6]);
    ok('fed tag', drag.tags.includes('fed'), drag.tags);
    eq('passenger: won at the bottom', E.gameRole(lobby(pl(0, 18000, 1, 12, 3, 9000), true), true).role, 'passenger');
    eq('Valve MVP counts as key player', E.gameRole(lobby(pl(0, 30000, 5, 5, 8, 25000, { 12: 2 }), true), true).role, 'key');
    {
      const spread = lobby(pl(0, 30000, 5, 5, 8, 25000), true);
      [40000, 36000, 26000, 22000, 20000].forEach((souls, j) => { spread.p[j + 1][1] = souls; });
      eq('middle of the team, won: solid', E.gameRole(spread, true).role, 'solid');
    }
    ok('short win = stomp', E.gameRole(lobby(pl(0, 29000, 5, 5, 7, 24000), true, 1000), true).tags.includes('stomp'));
    eq('old lobby shape: no role', E.gameRole({ me: 0, p: [[0, 1, 1, 1, 1, 1, 1]] }, true), null);
    const sum = E.roleSummary([{ id: 1, won: true }, { id: 2, won: false }, { id: 3, won: true }],
      { 1: lobby(pl(0, 50000, 14, 2, 10, 50000), true), 2: lobby(pl(0, 18000, 1, 12, 3, 9000), false) });
    eq('role summary counts only v2 lobbies', [sum.n, sum.counts.carried, sum.counts.dragged, sum.carry, sum.dragged], [2, 1, 1, 0.5, 0.5]);
  }

  // ---------------------------------------------------------------- rank ladder
  {
    eq('hero stats compacted', E.compactHeroStats([{ hero_id: 7, matches: 10, wins: 6, total_shots_hit: 30, total_shots_missed: 70 }]),
      { 7: { n: 10, wr: 0.6, acc: 0.3 } });
    const curveAt = (vals, n) => ({ 1200: Object.assign({ n }, ...E.BENCH_STATS.map(s => ({ [s.key]: [vals[s.key] != null ? vals[s.key] : 100, vals.sd || 0] }))) });
    const tiers = {};
    for (const t of E.LADDER_TIERS) tiers[t] = { curve: curveAt({ jungle: 1000 + t * 200, deaths: 6 - t * 0.3 }, 5000), stats: { 7: { n: 5000, wr: 0.5, acc: 0.4 + t * 0.01 } } };
    // You: Sentinel (4). Jungle 1500 = tier-2 level (1400) but below tier 3 (1600), with a tight SD so it's called.
    const mine = { curve: curveAt({ jungle: 1500, deaths: 2.5, sd: 100 }, 20), stats: { 7: { n: 20, wr: 0.55, acc: 0.45 } } };
    const L = E.rankLadder(7, 1200, mine, tiers, 4);
    const row = k => L.rows.find(r => r.key === k);
    eq('jungle level = nearest rank average', row('jungle').level, 2);
    eq('jungle behind your own rank', row('jungle').vsTier, 'behind');
    eq('deaths: fewer than every rank = nearest is Eternus', row('deaths').level, 11);
    eq('stat that barely moves across ranks is flat', row('souls').level, 'flat');
    eq('win rate has no level', row('wr').level, null);
    eq('win rate 55% vs 50% over 20 games is noise', row('wr').vsTier, 'par');
    eq('accuracy reaches tier 5', row('acc').level, 5);
    eq('behind list leads with jungle', L.behind[0].key, 'jungle');
    eq('next rank (Mystic) gap named', [L.toNext[0].key, L.rows.find(r => r.key === 'jungle').next.v], ['jungle', 2000]);
    eq('missing data: null row', E.rankLadder(7, 1800, mine, tiers, 4).rows.find(r => r.key === 'souls').you, null);
  }

  // ---------------------------------------------------------------- coach debrief
  {
    eq('zone: Amber deep in -y = near own base', E.mapZone(0, -9000, 0), 'near your base, centre');
    eq('zone: same spot for Sapphire = near enemy base', E.mapZone(0, -9000, 1), 'near the enemy base, centre');
    eq('zone: east, mid-map', E.mapZone(7000, 500, 0), 'mid-map, east side');
    const ME = 555;
    const snaps = (k) => [[360, 3000 * k, 1, 0, 0, 1000, 2000, 100, 30], [720, 8000 * k, 2, 1, 1, 4000, 4500, 600, 70]];
    const meta = {
      duration_s: 1500, winning_team: 'Team1',
      players: [
        { player_slot: 1, team: 'Team0', hero_id: 7, assigned_lane: 4, account_id: ME,
          stats: snaps(1).map(s => ({ time_stamp_s: s[0], net_worth: s[1], kills: s[2], deaths: s[3], assists: s[4], player_damage: s[5], gold_lane_creep: s[6], gold_neutral_creep: s[7], creep_kills: s[8] })),
          items: [{ game_time_s: 400, item_id: 11, sold_time_s: 0 }, { game_time_s: 90, item_id: 10, sold_time_s: 700 }, { game_time_s: 5, item_id: 999 }],
          death_details: [{ game_time_s: 283, killer_player_slot: 2, death_pos: [7000, 500, 0], time_to_kill_s: 3.14 }] },
        { player_slot: 2, team: 'Team1', hero_id: 8, assigned_lane: 4, account_id: 2,
          stats: snaps(1.5).map(s => ({ time_stamp_s: s[0], net_worth: s[1] })) },
      ],
    };
    const D = E.compactMatchDetail(meta, ME);
    eq('detail keeps my deaths', D.players[0].deaths, [[283, 2, 7000, 500, 3.1]]);
    eq('detail drops other players’ items', D.players[1].items, null);
    const pl = (team, o) => Object.assign([team, 10000, 2, 1, 1, 4000, 0, 7, 500, 0, 0, 0, 0, 4, 50, 0], o || {});
    const L = { v: E.LOBBY_V, me: 0, avgBadge: 43, dur: 1500, win: 1, p: [pl(0, { 7: 7, 15: ME }), pl(1, { 7: 8, 15: 2 })] };
    const m = { hero: 7, won: false, mode: 'ranked', delta: -250, dur: 1500, k: 2, d: 1, a: 1, souls: 10000, lh: 70 };
    const b = E.debriefBrief(m, L, D, E.gameRole(L, false), null, { heroName: id => ({ 7: 'Haze', 8: 'Lash' })[id], items: { 10: ['Headshot Booster', 'weapon', 1, 800], 11: ['Mystic Burst', 'spirit', 1, 800] }, tierName: t => E.TIER_NAMES[t] });
    eq('brief: death with killer + zone + clock', b.deaths, [{ at: '4:43', killed_by: 'Lash', where: 'mid-map, east side', seconds_to_die: 3.1 }]);
    eq('brief: items in time order, unknown ids dropped', b.item_buys.map(x => x.item + (x.sold_at ? '>' + x.sold_at : '')), ['Headshot Booster>11:40', 'Mystic Burst']);
    eq('brief: lane opponent souls', b.economy_timeline[0].lane_opponents_avg_souls, 4500);
    eq('brief: lobby rank named', b.match.lobby_average_rank, 'Sentinel');
    eq('brief: you marked on your team', b.your_team.filter(r => r.is_you).length, 1);
    ok('brief has no ladder unless given', !('hero_vs_ranks' in b));
  }

  // ---------------------------------------------------------------- overall analysis
  {
    const ME = 9;
    const pl = (team, o) => Object.assign([team, 30000, 5, 5, 8, 25000, 0, 1, 1000, 10000, 100, 5, 0, 1, 50, 0], o || {});
    const lobby = () => ({ v: E.LOBBY_V, me: 0, dur: 2000, win: 0, p: [pl(0, { 15: ME }), ...Array.from({ length: 5 }, () => pl(0)), ...Array.from({ length: 6 }, () => pl(1))] });
    // D: me (slot 1, lane 1) vs one lane opponent (slot 2). opp souls fixed; mine varies.
    const det = (myAt720, deaths, itemsList) => ({ v: 1, dur: 2000, players: [
      { slot: 1, team: 0, hero: 7, lane: 1, acct: ME, snaps: [[720, myAt720, 0, 0, 0, 0, 0, 0, 0], [1200, 15000], [1800, 25000]], items: itemsList, deaths },
      { slot: 2, team: 1, hero: 8, lane: 1, acct: 2, snaps: [[720, 8000], [1200, 15000], [1800, 26000]], items: null, deaths: null } ] });
    const items = { 100: ['Big Gun', 'weapon', 3, 3200], 200: ['Huge Gun', 'weapon', 4, 6400] };
    const win = { m: { id: 1, hero: 7, won: true }, L: lobby(), D: det(9000, [[700, 2, 7000, 500, 8]], [[600, 100, 0], [1300, 200, 0]]) };
    const loss = { m: { id: 2, hero: 7, won: false }, L: lobby(), D: det(7000, [[100, 2, 7000, 500, 3], [400, 2, 7000, 500, 2], [1500, 2, -7000, -500, 9]], [[900, 100, 0]]) };
    const A = E.aggregateGames([win, loss], items, id => ({ 7: 'Haze', 8: 'Lash' })[id]);
    eq('agg counts', [A.n, A.wins, A.losses], [2, 1, 1]);
    eq('deaths per game win/loss', [A.deaths.perGame.win, A.deaths.perGame.loss], [1, 3]);
    eq('deaths before 10 min', [A.deaths.before10.win, A.deaths.before10.loss], [0, 2]);
    eq('caught-out share', A.deaths.fastShare, 0.5);
    eq('top killer', A.deaths.killers[0], { hero: 8, name: 'Lash', n: 4 });
    eq('souls vs lane opp at 12 min', [A.economy[1].diff.win, A.economy[1].diff.loss], [1000, -1000]);
    eq('20→30 swing vs opp', A.lateSwing.all, -1000);
    eq('first tier-3 / tier-4 timing', [A.items.tier3.win, A.items.tier3.loss, A.items.tier4.win, A.items.tier4.loss], [600, 900, 1300, null]);
    const b = E.analysisBrief(A, { rankName: 'Sentinel 3' });
    eq('brief: tier-3 clock', b.first_tier3_item_at, { all: '12:30', in_wins: '10:00', in_losses: '15:00' });
    eq('empty sample', E.aggregateGames([], items).n, 0);
  }

  // ---------------------------------------------------------------- misc
  eq('badge 42 = Sentinel 2', E.badgeName(42), 'Sentinel 2');
  eq('badge 24 = Seeker 4', E.badgeName(24), 'Seeker 4');
  eq('badge null', E.badgeName(null), 'Unranked');
  eq('rank series cumulative', E.rankSeries([{ delta: 300 }, { delta: null }, { delta: -100 }]).map(p => p.cum), [300, 200]);

  // ---------------------------------------------------------------- report
  const failed = results.filter(r => !r.ok);
  if (typeof document !== 'undefined') {
    document.body.textContent = failed.length ? 'FAIL ' + failed.length + '/' + results.length : 'PASS ' + results.length;
  } else {
    for (const f of failed) console.log('FAIL', f.name, '\n  got ', JSON.stringify(f.got), '\n  want', JSON.stringify(f.want));
    console.log((failed.length ? 'FAIL ' : 'PASS ') + (results.length - failed.length) + '/' + results.length);
    if (failed.length) process.exit(1);
  }
})(typeof window !== 'undefined' ? window : globalThis);
