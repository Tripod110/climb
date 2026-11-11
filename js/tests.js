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
  const plcRow = E.normalizeMatch(row({ ranked_delta: 0, ranked_display_badge: 0, ranked_calibration_match: 3 }));
  eq('placement game: no rank-point delta, keeps the counter', [plcRow.delta, plcRow.calib], [null, 3]);
  eq('history drops other modes + sorts asc',
    E.normalizeHistory([row({ match_id: 2, start_time: 20 }), row({ match_id: 3, match_mode: 3 }), row({ match_id: 1, start_time: 10 })]).map(m => m.id), [1, 2]);

  // ---------------------------------------------------------------- matches added by id
  {
    const me = { account_id: 7, hero_id: 31, team: 'Team1', kills: 4, deaths: 9, assists: 6, net_worth: 37821, last_hits: 119,
      player_rank_initial_flat_progress: 24310, player_rank_final_flat_progress: 24010, player_rank_initial_display_rank: 44 };
    const mt = { match_id: 125201309, start_time: '2026-10-26 14:03:53', winning_team: 'Team0', duration_s: 2251, match_mode: 'Ranked',
      players: [{ account_id: 8, team: 'Team0' }, me] };
    const x = E.matchFromMeta(mt, 7);
    eq('added: UTC start time string -> unix', x.t, Date.UTC(2026, 9, 26, 14, 3, 53) / 1000);
    eq('added: ranked, lost, rank change from flat progress', [x.mode, x.won, x.delta, x.badge], ['ranked', false, -300, 44]);
    eq('added: kda + souls + flag', [x.k, x.d, x.a, x.souls, x.dur, x.added], [4, 9, 6, 37821, 2251, true]);
    eq('added: win when teams match', E.matchFromMeta(Object.assign({}, mt, { winning_team: 'Team1' }), 7).won, true);
    eq('added: unranked has no delta', E.matchFromMeta(Object.assign({}, mt, { match_mode: 'Unranked' }), 7).delta, null);
    eq('added: not in the match -> null', E.matchFromMeta(mt, 99), null);
    const h = [{ id: 1, t: 10 }, { id: 3, t: 30 }];
    eq('merge: added game slots in by time', E.mergeAdded(h, { 2: { id: 2, t: 20, mode: 'ranked' } }).map(m => m.id), [1, 2, 3]);
    eq('merge: history row wins once Valve lists it', E.mergeAdded(h, { 3: { id: 3, t: 30, mode: 'ranked', added: true } })[1].added, undefined);
    eq('merge: nothing added -> same array', E.mergeAdded(h, {}), h);
  }

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
  // Farm: same five lobbies, plus detail where game 104 out-farmed its lane by 12:00 and the rest matched it.
  const farmD = mine => ({ v: E.DETAIL_V, dur: 1800, players: [
    { team: 0, lane: 4, items: [], snaps: [[720, 8000, 0, 0, 0, 0, mine, 400, 30, 300, 0, 36]] },
    { team: 1, lane: 4, items: null, snaps: [[720, 8000, 0, 0, 0, 0, 2000, 400, 30, 300, 0, 36]] }] });
  const details = Object.fromEntries(games.map((g, i) => [g.id, farmD(i === 4 ? 4000 : 2000)]));
  const fGames = games.map((g, i) => ({ ...g, id: 200 + i }));
  const flatLob = Object.fromEntries(fGames.map(g => [g.id, mkLobby(30000)]));
  const flatDet = Object.fromEntries(fGames.map((g, i) => [g.id, details[100 + i]]));
  const pf = E.perfScores(fGames, flatLob, fGames, flatDet);
  ok('form: out-farming your lane scores above usual when nothing else differs', pf.get(204).score > 0 && pf.get(204).z.farm > 0, pf.get(204));
  eq('form: no detail = no farm stat, other stats still score', [perf.get(104).z.farm, perf.get(104).score > 0], [null, true]);
  near('farmRatio: farm souls vs lane opponent at 12:00', E.farmRatio(farmD(4000)), (4700 + 100) / (2700 + 100));
  eq('farmRatio: null with no lane opponent or no detail', [E.farmRatio({ ...farmD(4000), players: farmD(4000).players.slice(0, 1) }), E.farmRatio(null)], [null, null]);

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

    const row = (t, n, o) => Object.assign({ game_time: t, samples: n }, ...E.BENCH_STATS.flatMap(s => s.f).map(f => ({ [f + '_avg']: 0, [f + '_std']: 0 })), o);
    const cc = E.compactCurve([row(600, 9, {}), row(1200, 10, { gold_lane_creep_avg: 4000, gold_lane_creep_orbs_avg: 1000, gold_lane_creep_std: 300, gold_lane_creep_orbs_std: 100 })]);
    eq('curve keeps bench times only', Object.keys(cc), ['1200']);
    eq('lane souls = creeps + orbs, SDs added', cc[1200].lane, [5000, 400]);
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
    eq('Valve MVP #1 = 1st in the lobby', [E.gameRole(lobby(pl(0, 30000, 5, 5, 8, 25000, { 12: 1 }), true), true).lobbyFirst,
      E.gameRole(lobby(pl(0, 30000, 5, 5, 8, 25000, { 12: 2 }), true), true).lobbyFirst], [true, false]);
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

  // ---------------------------------------------------------------- focus loop
  {
    // A game whose only data is my deaths (times) + duration. early0 passes iff no death < 600.
    const ME = 9;
    const g = (i, won, deathTimes) => ({ m: { id: i, t: 1000 + i, won, d: deathTimes.length, dur: 1800 },
      L: null, D: { v: 1, dur: 1800, players: [{ slot: 1, team: 0, lane: 1, acct: ME, snaps: [], items: [], deaths: deathTimes.map(t => [t, 2, 0, 0, 9]) }] } });
    // 10 games passing (8 won), 10 failing (2 won): a 60-point split.
    const es = [];
    for (let i = 0; i < 10; i++) es.push(g(i, i < 8, [900]));
    for (let i = 10; i < 20; i++) es.push(g(i, i < 12, [300]));
    // The rulebook: proven rules only, ranked by worth at your rank × how often you broke it in your losses.
    // lane_le1 (≤1 death before 9:00): the 900s death passes; two deaths before 9:00 fail.
    const es2 = [];
    for (let i = 0; i < 10; i++) es2.push(g(i, i < 8, [900]));
    for (let i = 10; i < 20; i++) es2.push(g(i, i < 12, [100, 300]));
    const cat = E.habitCatalog(es2, {}, 42);
    const le1 = cat.find(c => c.id === 'lane_le1');
    eq('rulebook: only the proven rules', cat.map(c => c.id).sort(), E.RULES.map(r => r.id).sort());
    eq('rulebook: pass rate, split, broken in 8 of 10 losses', [le1.passRate, le1.wrPass, le1.wrFail, le1.missLoss, le1.eligible], [0.5, 0.8, 0.2, 0.8, true]);
    near('rulebook: priority = worth at your rank × broken in losses', le1.priority, 0.089 * 0.8);
    eq('rulebook: a rule with no data in these games is not offered', cat.find(c => c.id === 'lane_souls').eligible, false);
    eq('rulebook: suggest = the rule costing you most', E.suggestHabit(cat).id, 'lane_le1');
    const flat = [];
    for (let i = 0; i < 20; i++) flat.push(g(i, i % 2 === 0, i < 10 ? [900] : [100, 300]));
    eq('rulebook: proven rules are offered even without a personal split', E.habitCatalog(flat, {}, 42).find(c => c.id === 'lane_le1').eligible, true);
    eq('rule worth: lane rule is one number, mid rule a range (15:00 to 9:00 position)', [E.ruleWorth('lane_le1', 42), E.ruleWorth('mid_le2', 42).map(x => +x.toFixed(3))], [[0.089, 0.089], [0.05, 0.125]]);
    eq('rank bands', [0, 13, 42, 61, 85, 116].map(E.rankBandOf), ['cal', 'b1', 'b2', 'b3', 'b4', 'b5']);
    eq('rule card: one line per rule, pass from this game', E.ruleCard(es2[10], {}, 42).find(x => x.id === 'lane_le1').pass, false);
    // Each rule's check on a small match. snap: [t, souls, k, d, a, dmg, lane, jungle, lh, box, treasure, creeps, objDmg, soulsLost]
    const sp = (t, souls, obj, lost) => [t, souls, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, obj, lost];
    const pl = (slot, team, lane, s540, s1200, deaths, items) => ({ slot, team, lane, acct: slot, items: items ? [] : null, snaps: [s540, s1200], deaths: deaths || [] });
    const Dr = (meDeaths, other) => ({ v: E.DETAIL_V, dur: 1800, players: [
      pl(1, 0, 1, sp(540, 6000, 0, 0), sp(1200, 15000, 4000, 300), meDeaths, true),
      pl(2, 1, 1, sp(540, 5000, 0, 0), sp(1200, 14000, 1000, 900), other || []),
      pl(3, 1, 4, sp(540, 4000, 0, 0), sp(1200, 13000, 1000, 100)),
    ] });
    const tr = (id, D) => E.habitById(id).test({ won: true, dur: 1800 }, null, D, {});
    eq('rules: lane souls ≥ lane opponent at 9:00; obj damage ≥ lobby; souls lost ≤ lobby median', ['lane_souls', 'mid_obj', 'mid_bank'].map(id => tr(id, Dr([]))), [true, true, true]);
    eq('rules: a lone death at 12:00 breaks "don’t die alone"; one with another death 5s later doesn’t', [tr('mid_nolone', Dr([[720, 2, 0, 0, 9]])), tr('mid_nolone', Dr([[720, 2, 0, 0, 9]], [[725, 1, 0, 0, 9]]))], [false, true]);
    eq('rules: three deaths 9:00–20:00 break ≤2; a 3s death breaks never caught out', [tr('mid_le2', Dr([[600, 2, 0, 0, 9], [700, 2, 0, 0, 9], [800, 2, 0, 0, 9]])), tr('mid_nocaught', Dr([[600, 2, 0, 0, 3]]))], [false, false]);
    eq('rules: mid rules need a 20-minute game', E.habitById('mid_le2').test({}, null, Object.assign(Dr([]), { dur: 1100 }), {}), null);
    eq('legacy habits are recognised, rules are not', [E.isLegacyHabit('ahead12'), E.isLegacyHabit('tier3'), E.isLegacyHabit('lane_souls')], [true, true, false]);

    const goal = { habit: 'early0', start: 1000 + 20, baseline: { rate: 0.3, n: 30 } };
    const after = n => Array.from({ length: n }, (_, k) => g(20 + k, true, k % 5 === 0 ? [300] : [900]));  // 80% pass
    const p8 = E.focusProgress(goal, [...es, ...after(8)], {});
    eq('progress counts only games since start', [p8.n, p8.passes], [8, 6]);
    eq('too few games -> early', [p8.verdict, p8.needed], ['early', 7]);
    const p16 = E.focusProgress(goal, [...es, ...after(16)], {});
    eq('30% -> 75% over 16 games = improved', p16.verdict, 'improved');
    eq('7+ of last 10 -> graduated', [p16.recent.length, p16.graduated], [10, true]);
    eq('unknown habit -> null', E.focusProgress({ habit: 'nope', start: 0 }, es, {}), null);
    const addedLate = Object.assign(g(99, true, [300]), {}); addedLate.m.added = true;   // played after the goal, but added by id
    const addedOld = g(98, true, [300]); addedOld.m.added = true; addedOld.m.t = 500;     // played before the goal
    const pa = E.focusProgress(goal, [...es, ...after(8), addedLate, addedOld], {});
    eq('games added by id never count toward a goal', [pa.n, pa.passes], [8, 6]);

    // focusImpact: win rate before vs since the goal, only called past the 15-game floor and 2 standard errors.
    const hist = (n, t0, winEvery) => Array.from({ length: n }, (_, k) => ({ id: 500 + t0 + k, t: t0 + k, won: k % winEvery !== 0, d: 0, dur: 1800 }));
    const gl = { habit: 'early0', start: 1000, baseline: { rate: 0.3, n: 30 } };
    const afterG = n => Array.from({ length: n }, (_, k) => g(100 + k, true, k % 5 === 0 ? [300] : [900]));
    const pI = E.focusProgress(gl, afterG(20), {});
    const bad = hist(30, 900, 2);                                  // 50% before
    const goodAfter = afterG(20).map(e => e.m);                    // 100% after
    const imp = E.focusImpact(gl, [...bad, ...goodAfter], pI);
    eq('impact: clear win-rate rise is called up', [imp.call, imp.nBefore, imp.nAfter], ['up', 30, 20]);
    eq('impact: pass rate beat baseline in both halves = held', imp.held, true);
    eq('impact: split by pass vs fail', [imp.split.nPass, imp.split.nFail], [16, 4]);
    const pFew = E.focusProgress(gl, afterG(8), {});
    eq('impact: under 15 games since = early', E.focusImpact(gl, [...bad, ...afterG(8).map(e => e.m)], pFew).call, 'early');
    const same = afterG(20).map((e, k) => ({ ...e.m, won: k % 2 === 0 }));
    eq('impact: same win rate is not called', E.focusImpact(gl, [...bad, ...same], pI).call, 'same');
    const lateAdd = { ...afterG(1)[0].m, id: 9999, added: true };
    eq('impact: added games are not counted', E.focusImpact(gl, [...bad, ...goodAfter, lateAdd], pI).nAfter, 20);
    eq('impact: null without a goal', E.focusImpact(null, [], pI), null);

    // farm: souls by source vs lane opponents. Snapshot = [t, nw, k, d, a, dmg, lane, camps, creepKills, boxes, treasure, creepsAvail].
    const sn = (lane, camps, boxes, treasure, kills, avail) => [720, 8000, 0, 0, 0, 0, lane, camps, kills, boxes, treasure, avail];
    const fp = (acct, team, laneId, snap, isMe) => ({ slot: acct, team, lane: laneId, acct, snaps: [snap], items: isMe ? [] : null, deaths: [] });
    const fg = (mine, opp1, opp2) => ({ m: { id: 1, t: 1, won: true }, L: null, D: { v: 4, dur: 1800, players: [
      fp(1, 0, 2, mine, true), fp(2, 0, 2, sn(2000, 500, 500, 0, 30, 36)), fp(3, 1, 2, opp1), fp(4, 1, 2, opp2), fp(5, 1, 1, sn(9999, 9999, 9999, 0, 36, 36)) ] } });
    const f1 = E.farmAt(fg(sn(2400, 300, 100, 0, 32, 36), sn(2400, 700, 900, 0, 30, 36), sn(2400, 500, 700, 0, 34, 36)).D);
    eq('farmAt: souls by source vs the average of your lane opponents', f1.src.map(x => [x.key, x.me, x.opp]), [['lane', 2400, 2400], ['camps', 300, 600], ['boxes', 100, 800]]);
    eq('farmAt: lane creep efficiency, you vs lane opponents', [Math.round(f1.eff.me * 100), Math.round(f1.eff.opp * 100)], [89, 89]);
    eq('farmAt: opponents in other lanes are ignored', f1.nOpp, 2);
    eq('farmAt: a v3 snapshot (9 columns) has no farm data', E.farmAt({ dur: 1800, players: [{ team: 0, lane: 2, items: [], snaps: [[720, 1, 0, 0, 0, 0, 1, 1, 1]] }] }), null);
    eq('farmAt: game shorter than 12:00 has no checkpoint', E.farmAt({ ...fg(sn(1, 1, 1, 1, 1, 1), sn(1, 1, 1, 1, 1, 1), sn(1, 1, 1, 1, 1, 1)).D, dur: 600 }), null);
    const lanes = E.farmLanes(fg(sn(2400, 300, 100, 0, 32, 36), sn(2400, 700, 900, 0, 30, 36), sn(2400, 500, 700, 0, 34, 36)).D);
    eq('farmLanes: per-player souls per lane (both sides present only), flags your lane', lanes.map(l => [l.lane, l.yours, Math.round(l.mine), Math.round(l.theirs)]), [[2, true, 2900, 3800]]);
    eq('laneColor: 1/4/6 are Yellow/Blue/Green whichever team you are on', [E.laneColor(1), E.laneColor(4), E.laneColor(6), E.laneColor(2)], ['Yellow', 'Blue', 'Green', null]);
    eq('laneSide: ids 1/4/6 are fixed places, flipped for the other team', [E.laneSide(1, 0), E.laneSide(4, 0), E.laneSide(6, 0), E.laneSide(1, 1), E.laneSide(6, 1), E.laneSide(4, 1), E.laneSide(2, 0)], ['left', 'centre', 'right', 'right', 'left', 'centre', null]);
    const gd = { dur: 1800, players: [
      { team: 0, lane: 6, hero: 11, acct: 1, items: [], snaps: [[720, 0, 0, 0, 0, 0, 1000, 200, 20, 100, 0, 30]] },
      { team: 0, lane: 6, hero: 12, acct: 2, items: null, snaps: [[720, 0, 0, 0, 0, 0, 800, 100, 20, 0, 0, 30]] },
      { team: 1, lane: 6, hero: 21, acct: 3, items: null, snaps: [[720, 0, 0, 0, 0, 0, 900, 50, 20, 300, 0, 30]] },
      { team: 0, lane: 1, hero: 13, acct: 4, items: null, snaps: [[720, 0, 0, 0, 0, 0, 500, 500, 20, 0, 0, 30]] },
      { team: 1, lane: 1, hero: 22, acct: 5, items: null, snaps: [[720, 0, 0, 0, 0, 0, 600, 400, 20, 0, 0, 30]] } ] };
    const gl2 = E.farmLanes(gd, 720, 'camps');
    eq('farmLanes: one source, ordered left to right with who was there', gl2.map(l => [l.side, l.yours, Math.round(l.mine), Math.round(l.theirs), l.mineHeroes.map(h => h.hero), l.theirHeroes.map(h => h.hero)]),
      [['left', false, 500, 400, [13], [22]], ['right', true, 150, 50, [11, 12], [21]]]);
    eq('farmLanes: only the you flag marks you', gl2[1].mineHeroes.map(h => h.you), [true, false]);
    const sr = E.farmSeries({ ...gd, players: gd.players.map(p => ({ ...p, snaps: [[360, 0, 0, 0, 0, 0, 300, 0, 9, 0, 0, 15], ...p.snaps] })) }, 'lane');
    eq('farmSeries: you vs lane opponent at every snapshot', sr.map(r => [r.t, r.me, r.opp]), [[360, 300, 300], [720, 1000, 900]]);
    eq('farmSeries: unknown source', E.farmSeries(gd, 'nope'), null);
    const prof = fgs => E.farmProfile(fgs);
    const mk = (n, boxesMine, boxesOpp) => Array.from({ length: n }, () => fg(sn(2400, 500, boxesMine, 0, 32, 36), sn(2400, 500, boxesOpp, 0, 32, 36), sn(2400, 500, boxesOpp, 0, 32, 36)));
    eq('farmProfile: under 8 games is not ready', prof(mk(5, 0, 800)).ready, false);
    const pr = prof(mk(12, 100, 800));
    eq('farmProfile: consistent box gap is called behind and headlined', [pr.src.find(x => x.key === 'boxes').call, pr.headline.key, Math.round(pr.src.find(x => x.key === 'boxes').gap)], ['behind', 'boxes', -700]);
    eq('farmProfile: matching camps and lane read even', [pr.src.find(x => x.key === 'camps').call, pr.src.find(x => x.key === 'lane').call], ['even', 'even']);
    const split = [...mk(6, 100, 800), ...mk(6, 800, 100)];
    eq('farmProfile: a gap that flips between halves is not called', E.farmProfile(split).src.find(x => x.key === 'boxes').call, 'even');
    eq('habit jungle12: more camp+box souls than lane opponents', [E.habitById('jungle12').test(null, null, fg(sn(2400, 900, 900, 0, 32, 36), sn(2400, 500, 500, 0, 32, 36), sn(2400, 500, 500, 0, 32, 36)).D), E.habitById('jungle12').test(null, null, mk(1, 0, 800)[0].D)], [true, false]);
    eq('habit creeps12: 80% of lane creeps', [E.habitById('creeps12').test(null, null, fg(sn(1, 1, 1, 0, 30, 36), sn(1, 1, 1, 0, 1, 36), sn(1, 1, 1, 0, 1, 36)).D), E.habitById('creeps12').test(null, null, fg(sn(1, 1, 1, 0, 20, 36), sn(1, 1, 1, 0, 1, 36), sn(1, 1, 1, 0, 1, 36)).D)], [true, false]);
    const cd4 = E.compactMatchDetail({ duration_s: 100, players: [{ account_id: 7, player_slot: 1, team: 'Team0', assigned_lane: 1, items: [], stats: [{ time_stamp_s: 60, net_worth: 5, gold_lane_creep: 400, gold_lane_creep_orbs: 300, gold_neutral_creep: 50, gold_source_breakable_gold: 70, gold_treasure: 20, possible_creeps: 9, creep_kills: 8 }] }] }, 7);
    eq('detail v5: lane souls not double counted by orbs; boxes, treasure, creeps available kept; objective damage + souls lost (0 when absent)', cd4.players[0].snaps[0].slice(6), [400, 50, 8, 70, 20, 9, 0, 0]);

    // rankForecast: divisions per game over the last 40 ranked games, direction only when both halves agree.
    const rk = (badges, won) => badges.map((b, i) => ({ id: i, t: i, mode: 'ranked', badge: b, calib: false, won: won ? won(i) : i % 2 === 0 }));
    eq('forecast: under 15 games = thin', E.rankForecast(rk([41, 41, 41])).call, 'thin');
    const climbing = rk(Array.from({ length: 31 }, (_, i) => 31 + Math.floor(i / 6)));   // +1 division per 6 games across 31 games
    const fc = E.rankForecast(climbing);
    eq('forecast: climbing + pace', [fc.call, fc.gain, Math.round(fc.perDivision)], ['climbing', 5, 6]);
    eq('forecast: next division', [fc.now, fc.next], [36, 41]);
    eq('forecast: next badge rolls over a tier', [E.nextBadge(36), E.nextBadge(42), E.nextBadge(null)], [41, 43, null]);
    eq('next badge: Ascendant 6 -> Eternus 1, nothing above Eternus 6', [E.nextBadge(106), E.nextBadge(115), E.nextBadge(116)], [111, 116, null]);
    eq('rank status: ranked, top flagged at Eternus', [E.rankStatus([], 42).state, E.rankStatus([], 42).top, E.rankStatus([], 113).top], ['ranked', false, true]);
    const plc = [{ mode: 'unranked' }, { mode: 'ranked', calib: 1, badge: 0 }, { mode: 'ranked', calib: 2, badge: 0 }];
    eq('rank status: placement games -> calibrating, with the count', [E.rankStatus(plc, 0).state, E.rankStatus(plc, null).placed], ['calibrating', 2]);
    eq('rank status: no ranked games -> unranked', E.rankStatus([{ mode: 'unranked' }], null).state, 'unranked');
    const mr = E.matchRanks([
      { id: 5, t: 50, mode: 'ranked', badge: 43 }, { id: 1, t: 10, mode: 'unranked', badge: null },
      { id: 2, t: 20, mode: 'ranked', badge: 0, calib: 1 }, { id: 3, t: 30, mode: 'ranked', badge: 42 },
      { id: 4, t: 40, mode: 'unranked', badge: null }]);
    eq('match ranks: none yet, placement, own badge, rank at the time, own badge',
      [1, 2, 3, 4, 5].map(id => mr.get(id)), [{ badge: null, kind: null }, { badge: null, kind: 'placement' },
        { badge: 42, kind: 'ranked' }, { badge: 42, kind: 'before' }, { badge: 43, kind: 'ranked' }]);
    const mt0 = { id: 100, t: 1000 };
    eq('player rank: this was their latest ranked game -> the rank they entered it with', E.playerRankAt({ badge: 62, last_match: { match_id: 100, start_time: 1000, player_rank_initial_display_rank: 61 } }, mt0), { badge: 61, exact: true });
    eq('player rank: no ranked game since -> exact; played since -> rank now', [E.playerRankAt({ badge: 45, last_match: { match_id: 90, start_time: 900 } }, mt0), E.playerRankAt({ badge: 45, last_match: { match_id: 120, start_time: 1200 } }, mt0)], [{ badge: 45, exact: true }, { badge: 45, exact: false }]);
    eq('player rank: unranked or calibrating -> none', [E.playerRankAt({ badge: 0, last_match: null }, mt0), E.playerRankAt(null, mt0)], [null, null]);
    eq('avg badge on the subrank ladder (Mystic 6 + Ritualist 2 -> Ritualist 1), none without badges', [E.avgBadge([56, 62]), E.avgBadge([0, null])], [61, null]);
    const hrows = [{ hero_id: 6, matches_played: 120, wins: 75, kills: 960, deaths: 600, assists: 1200 }, { hero_id: 7, matches_played: 80, wins: 40 }];
    eq('hero record: games, share of all games, per-game K/D/A', E.heroRecord(hrows, 6), { n: 120, wins: 75, share: 0.6, k: 8, d: 5, a: 10 });
    eq('hero tags: one-trick and wins a lot (adjusted for games)', E.heroTags(E.heroRecord(hrows, 6)).tags.map(t => t.id), ['otp', 'wins']);
    eq('hero tags: 3-0 is "new", not a winner', E.heroTags({ n: 3, wins: 3, share: 0.01 }).tags.map(t => t.id), ['new']);
    eq('hero tags: none on the hero -> first game', E.heroTags(null).tags.map(t => t.id), ['first']);
    eq('hero tags: 25-35 over 60 games loses a lot; main at 40% share', E.heroTags({ n: 60, wins: 25, share: 0.4 }).tags.map(t => t.id), ['main', 'loses']);
    eq('match ranks: placement after an old rank is still a placement', E.matchRanks([{ id: 1, t: 1, mode: 'ranked', badge: 51 }, { id: 2, t: 2, mode: 'ranked', badge: 0, calib: 2 }]).get(2).kind, 'placement');
    eq('road tier: next rank, Eternus vs itself, Initiate before a rank', [E.roadTier(42), E.roadTier(114), E.roadTier(null), E.roadTier(0)],
      [{ tier: 5, kind: 'next' }, { tier: 11, kind: 'top' }, { tier: 1, kind: 'entry' }, { tier: 1, kind: 'entry' }]);
    eq('forecast: flat', E.rankForecast(rk(Array(20).fill(42))).call, 'flat');
    eq('forecast: sliding', E.rankForecast(rk(Array.from({ length: 30 }, (_, i) => 44 - Math.floor(i / 10)))).call, 'sliding');
    const wobble = rk([...Array(10).fill(41), ...Array(10).fill(43), ...Array(10).fill(41)]);
    eq('forecast: up then down is mixed, not a trend', E.rankForecast(wobble).call, 'mixed');
    // matchTotals / matchDays: the Matches tab's figures and day headers.
    const day = (d, h) => new Date(2026, 9, d, h).getTime() / 1000;
    const mt = [
      { t: day(2, 20), won: true, k: 10, d: 2, a: 8, souls: 40000, delta: 300 },
      { t: day(2, 18), won: false, k: 4, d: 6, a: 6, souls: 30000, delta: -300 },
      { t: day(1, 22), won: true, k: 7, d: 4, a: 10, souls: 35000, delta: null }];
    const tot = E.matchTotals(mt);
    eq('matchTotals: record, averages, net over ranked only', [tot.wins, tot.losses, Math.round(tot.winRate * 100), tot.k, tot.d, tot.souls, tot.ranked, tot.net], [2, 1, 67, 7, 4, 35000, 2, 0]);
    eq('matchTotals: empty list', [E.matchTotals([]).n, E.matchTotals([]).winRate], [0, null]);
    const days = E.matchDays(mt);
    eq('matchDays: grouped by local day, newest first, with totals', days.map(g => [g.games.length, g.tot.wins, g.tot.net]), [[2, 1, 0], [1, 1, 0]]);
    // stackBoard: you vs friends in shared lobbies, same team only, shrunk toward the lobby average.
    const LV = E.LOBBY_V;
    // seat: [team, souls, k, d, a, dmg, heal, hero, 0,0,0,0,0,0,0, acct]
    const seatP = (team, souls, k, d, a, dmg, heal, hero, acct) => [team, souls, k, d, a, dmg, heal, hero, 0, 0, 0, 0, 0, 0, 0, acct];
    const sLob = (fr, frTeam) => ({ v: LV, me: 0, p: [seatP(0, 30000, 5, 5, 5, 20000, 0, 7, 1), seatP(frTeam, fr[0], fr[1], fr[2], fr[3], fr[4], fr[5], 9, 2),
      ...Array.from({ length: 10 }, (_, i) => seatP(i < 4 ? 0 : 1, 30000, 5, 5, 5, 20000, 0, 3, 100 + i))] });
    const sMs = n => Array.from({ length: n }, (_, i) => ({ id: 500 + i, t: i * 100 }));
    const strong = Object.fromEntries(sMs(30).map(m => [m.id, sLob([45000, 9, 3, 9, 30000, 0], 0)]));
    const sb = E.stackBoard(sMs(30), strong, 1, [{ acct: 2, ids: sMs(30).map(m => m.id) }]);
    eq('stackBoard: stronger friend ranks above you and is called ahead', sb.map(p => [p.acct, p.call]), [[2, 'them'], [1, 'self']]);
    ok('stackBoard: per-stat ratios vs the lobby', sb[0].stat.souls > 1.3 && sb[0].stat.alive > 1.3 && Math.abs(sb[1].stat.souls - 0.98) < 0.05, [sb[0].stat, sb[1].stat]);
    const few = E.stackBoard(sMs(10), strong, 1, [{ acct: 2, ids: sMs(10).map(m => m.id) }])[0];
    ok('stackBoard: 10 games are pulled halfway to the lobby average', Math.abs(Math.log(few.index) - Math.log(few.raw) / 2) < 1e-9, [few.index, few.raw]);
    const support = Object.fromEntries(sMs(12).map(m => [m.id, sLob([20000, 2, 3, 15, 8000, 30000], 0)]));
    ok('stackBoard: a healer is scored on healing, not damage', E.stackBoard(sMs(12), support, 1, [{ acct: 2, ids: sMs(12).map(m => m.id) }]).find(p => p.acct === 2).stat.out > 3, null);
    const foe = Object.fromEntries(sMs(12).map(m => [m.id, sLob([45000, 9, 3, 9, 30000, 0], 1)]));
    eq('stackBoard: games on opposite teams and too-few games are left out', [E.stackBoard(sMs(12), foe, 1, [{ acct: 2, ids: sMs(12).map(m => m.id) }]).length, E.stackBoard(sMs(9), strong, 1, [{ acct: 2, ids: sMs(9).map(m => m.id) }]).length], [0, 0]);
    // heroInsights: shrunk win rates pick the best hero and the one to park; tidbits from rank points.
    const NOW = 1e9, hg = (hero, w, l, delta) => [...Array(w).fill(true), ...Array(l).fill(false)].map((won, i) => ({ id: hero * 1000 + i, t: NOW - 86400 * (i + 1), hero, won, delta: delta == null ? null : won ? delta : -delta }));
    const hi = E.heroInsights([...hg(1, 18, 8, 300), ...hg(2, 4, 0, 300), ...hg(3, 5, 9, 300), ...hg(4, 10, 10, null), { id: 9, t: NOW - 200 * 86400, hero: 5, won: false }], new Map(), NOW);
    eq('heroInsights: best is the solid record, not the 4–0', hi.best && hi.best.hero, 1);
    eq('heroInsights: avoid is the clearly-below-your-average hero', hi.avoid && hi.avoid.hero, 3);
    eq('heroInsights: most rank points, and no drain when it is the avoid hero', [hi.mostPts && hi.mostPts.hero, hi.drain], [1, null]);
    eq('heroInsights: games older than the window are left out', [hi.n, hi.rows.some(h => h.hero === 5)], [64, false]);
    eq('heroInsights: picker groups (58% overall: 50% is 5+ under)', Object.fromEntries(hi.rows.map(h => [h.hero, h.group])), { 1: 'climb', 2: 'few', 3: 'park', 4: 'park' });
    eq('heroInsights: within the 10+ game heroes, best first', hi.rows.filter(h => h.group !== 'few').map(h => h.hero), [1, 4, 3]);
    eq('heroInsights: steady sits between', E.heroInsights([...hg(1, 14, 6), ...hg(2, 10, 10), ...hg(3, 6, 14)], new Map(), NOW).rows.map(h => h.group), ['climb', 'steady', 'park']);
    eq('heroInsights: nobody below average = no avoid', E.heroInsights([...hg(1, 10, 10), ...hg(2, 10, 10)], new Map(), NOW).avoid, null);
    // rankOutlook: steps per game = DRIFT + STEP × (2·winRate − 1), win rate pulled to 50% by OUTLOOK_K games
    const ol = (n, wins, badge) => Array.from({ length: n }, (_, i) => ({ id: i, t: i, mode: 'ranked', badge, won: i < wins }));
    const o1 = E.rankOutlook(ol(40, 28, 42));
    near('outlook: win rate pulled toward 50%', o1.wr, (28 + 10) / 60);
    near('outlook: steps per game from the fit', o1.per, E.OUTLOOK_DRIFT + E.OUTLOOK_STEP * (2 * (38 / 60) - 1));
    eq('outlook: badges after 20/50/100 games climb, ranges around them', o1.steps.map(s => s.badge > 42 && s.lo <= s.badge && s.hi >= s.badge), [true, true, true]);
    ok('outlook: games to the next tier', o1.tierUp && o1.tierUp.badge === 51 && o1.tierUp.games > 0, o1.tierUp);
    eq('outlook: a losing run points down, no tier-up', [E.rankOutlook(ol(40, 2, 42)).dir, E.rankOutlook(ol(40, 2, 42)).tierUp], [-1, null]);
    eq('outlook: 20% over 40 games is about flat (Season 1 players drifted up even at 50%)', E.rankOutlook(ol(40, 8, 42)).dir, 0);
    eq('outlook: needs 15 ranked games; placement and unranked ignored', [E.rankOutlook(ol(14, 7, 42)), E.rankOutlook([...ol(14, 7, 42), { id: 99, t: 99, mode: 'unranked', badge: 42 }, { id: 98, t: 98, mode: 'ranked', calib: 3, badge: 0 }])], [null, null]);
    eq('outlook: clamped at Eternus 6', E.rankOutlook(ol(40, 40, 116)).steps.map(s => s.hi), [116, 116, 116]);
    eq('forecast: calibration and unranked games are ignored', E.rankForecast([...climbing, ...climbing.map(m => ({ ...m, calib: true })), { id: 1, t: 1, mode: 'unranked', badge: 50 }]).n, 31);
  }

  // ---------------------------------------------------------------- street brawl
  {
    eq('street brawl (game_mode 4) is dropped from history', E.normalizeHistory([row({ game_mode: 4, match_mode: 1 }), row({ match_id: 2, game_mode: 1, match_mode: 1 })]).map(m => m.id), [2]);
    eq('added street brawl game is not counted', E.matchFromMeta({ match_id: 5, start_time: '2026-10-28 03:16:39', match_mode: 'Unranked', game_mode: 'StreetBrawl', winning_team: 'Team0', duration_s: 700,
      players: [{ account_id: 7, hero_id: 1, team: 'Team0' }] }, 7).mode, 'other');
  }

  // ---------------------------------------------------------------- hero coach
  {
    const g = (i, won, deathTimes) => ({ m: { id: i, t: 1000 + i, won, d: deathTimes.length, dur: 1800 }, L: null,
      D: { v: 1, dur: 1800, players: [{ slot: 1, team: 0, lane: 1, acct: 9, snaps: [], items: [], deaths: deathTimes.map(t => [t, 2, 0, 0, 9]) }] } });
    const few = Array.from({ length: 7 }, (_, i) => g(i, true, [900]));
    const r0 = E.heroCoach(few, {});
    eq('hero coach: under the minimum makes no call', [r0.ready, r0.n, r0.need], [false, 7, 1]);
    const es = [];
    for (let i = 0; i < 6; i++) es.push(g(i, i < 5, []));
    for (let i = 6; i < 12; i++) es.push(g(i, i < 7, [100, 300]));
    es.push(g(99, true, [900]), Object.assign(g(98, true, []), { D: null }));   // a game without detail is ignored
    const r = E.heroCoach(es, {});
    eq('hero coach: counts only games with detail, thin under 15', [r.ready, r.n, r.thin], [true, 13, true]);
    eq('hero coach: picks the rule this hero’s losses broke most', r.focus && r.focus.id, 'lane_le1');
  }

  // ---------------------------------------------------------------- win chance
  {
    // A toy model: only souls matter, 1 logit per 10k souls, same at every minute.
    const W = { scale: [10000, 10, 1, 1], win: { 180: [1, 0, 0.2, 0], 900: [1, 0, 0.2, 0], 1800: [2, 0, 0.2, 0] },
      death: { minute_buckets: [[0, 600], [600, null]], share_buckets: [[0, 1.2], [1.2, null]], cost: [[1000, 1500], [2000, 3000]], objective_lift_90s: [0.1, 0.2] } };
    near('even gaps = 50%', E.wpAt(W, 900, [0, 0, 0, 0]), 0.5, 1e-9);
    near('10k souls ahead = logistic(1)', E.wpAt(W, 900, [10000, 0, 0, 0]), 1 / (1 + Math.exp(-1)), 1e-9);
    near('one objective = logistic(0.2)', E.wpAt(W, 900, [0, 0, 1, 0]), 1 / (1 + Math.exp(-0.2)), 1e-9);
    near('weights interpolate between minutes', E.wpWeights(W, 1350)[0], 1.5, 1e-9);
    near('weights fade to 0 at 0:00', E.wpWeights(W, 90)[0], 0.5, 1e-9);
    near('symmetric: my 60% is their 40%', E.wpAt(W, 900, [4000, 0, 0, 0]) + E.wpAt(W, 900, [-4000, 0, 0, 0]), 1, 1e-9);

    const snaps = (k) => [[180, 2000 * k, 0], [360, 4000 * k, 1], [540, 6000 * k, 1], [720, 8000 * k, 2]];
    const D = { v: 2, dur: 800, win: 1, objs: [[700, 0]], mbs: [],
      players: [
        { slot: 1, team: 0, hero: 7, lane: 1, acct: 9, items: [], deaths: [[400, 2, 0, -2000, 3], [650, 2, 0, 0, 9]], snaps: snaps(1).map(s => [s[0], s[0] === 540 ? 3000 : s[1], s[2], 0, 0, 0, 0, 0, 0]) },  // falls well behind 6:00→9:00
        { slot: 2, team: 1, hero: 8, lane: 1, acct: 2, items: null, deaths: null, snaps: snaps(1.5).map(s => [s[0], s[1], s[2], 0, 0, 0, 0, 0, 0]) },
      ] };
    const tl = E.winTimeline(D, W, 0);
    eq('timeline: 0:00, snapshots, end', tl.map(x => x.t), [0, 180, 360, 540, 720, 800]);
    eq('timeline ends at the result', tl[tl.length - 1].p, 0);
    ok('falling behind lowers win chance', tl[4].p < tl[1].p && tl[1].p < 0.5, tl.map(x => x.p));
    eq('objective lost counts against you', E.gapsAt(D, 0, 720)[2], -1);
    const dc = E.deathCosts(D, W);
    eq('death costs: one per death, killer known', dc.map(d => [d.t, d.killerHero, d.souls]), [[400, 8, 1000], [650, 8, 2000]]);
    ok('a later, pricier death costs more win chance', dc[1].pts > dc[0].pts && dc[0].pts > 0, dc.map(d => d.pts));
    ok('objective risk adds a little', dc[1].objPts > 0 && dc[1].objPts < dc[1].pts, dc[1]);
    const tp = E.turningPoints(D, W, 2);
    eq('turning points: biggest moves, in time order', tp.length, 2);
    ok('biggest drop (6:00→9:00) is a turning point with my 6:40 death', tp.some(x => x.from === 360 && x.to === 540 && x.myDeaths[0] === 400), tp);

    const meta = { duration_s: 800, winning_team: 'Team1', objectives: [{ destroyed_time_s: 700, team: 'Team0' }, { destroyed_time_s: 0, team: 'Team1' }],
      mid_boss: [{ destroyed_time_s: 1500, team_claimed: 'Team1' }], players: [{ player_slot: 1, team: 'Team0', hero_id: 7, account_id: 9, stats: [] }] };
    const cd = E.compactMatchDetail(meta, 9);
    eq('detail v2 keeps destroyed objectives + mid-boss', [cd.v, cd.objs, cd.mbs], [E.DETAIL_V, [[700, 0]], [[1500, 1]]]);
  }

  // ---------------------------------------------------------------- v13
  {
    // team share: your rank on your own team by impact (shown neutral on the match page)
    const pl = (team, souls, o) => Object.assign([team, souls, 5, 5, 8, 25000, 0, 1, 1000, 10000, 100, 5, 0, 1, 50, 0], o || {});
    const L = { v: E.LOBBY_V, me: 0, dur: 1800, win: 0, p: [pl(0, 60000), ...[30000, 30000, 30000, 30000, 30000].map(x => pl(0, x)), ...Array.from({ length: 6 }, () => pl(1, 30000))] };
    eq('team share: you are your team’s #1', E.gameRole(L, true).teamRank, 1);
    L.p[0] = pl(0, 9000, { 5: 5000, 2: 0, 4: 1, 3: 12, 8: 0 });
    { const g = E.gameRole(L, false); ok('team share: low share = bottom two of your team', g.teamRank >= g.teamSize - 1, g.teamRank); }

    // next-rank plan from a ladder
    const lad = { rows: [
      { key: 'lane', label: 'Lane souls', you: 8000, fmt: null, higher: true, next: { status: 'behind', rel: -0.1, v: 8900 } },
      { key: 'jungle', label: 'Jungle souls', you: 2000, fmt: null, higher: true, next: { status: 'behind', rel: -0.3, v: 2850 } },
      { key: 'deaths', label: 'Deaths', you: 2.4, fmt: 'dec', higher: false, next: { status: 'ahead', rel: -0.1, v: 2.7 } },
      { key: 'wr', label: 'Win rate', you: 0.5, next: { status: 'behind', rel: -0.2, v: 0.6 } },
      { key: 'kills', label: 'Kills', you: 3, next: { status: 'par', rel: 0, v: 3 } } ] };
    const plan = E.nextRankPlan(lad);
    eq('plan: biggest gap first, win rate never a target', plan.gaps.map(g => [g.key, g.gap]), [['jungle', 850], ['lane', 900]]);
    eq('plan: lane maps to a rule', plan.gaps[1].habit, 'lane_souls');
    eq('plan: strengths + on par', [plan.strengths.map(x => x.label), plan.onPar], [['Deaths'], ['Kills']]);

    // calibration on your own games
    const W = { scale: [10000, 10, 1, 1], win: { 180: [1, 0, 0, 0], 1200: [1, 0, 0, 0] } };
    const mk = (id, gap, won) => ({ m: { id, won }, D: { dur: 1800, objs: [], mbs: [], players: [
      { slot: 1, team: 0, acct: 9, items: [], snaps: [[1200, 30000 + gap, 0]], deaths: [] },
      { slot: 2, team: 1, acct: 2, items: null, snaps: [[1200, 30000, 0]], deaths: [] }] } });
    const cal = E.calibration([mk(1, 15000, true), mk(2, 12000, true), mk(3, -15000, false), mk(4, 0, true), mk(5, -12000, true)], W, 1200);
    eq('calibration: games + favourite right', [cal.n, cal.right], [5, 4]);
    eq('calibration: bins', cal.bins.map(b => [b.n, b.wins]), [[2, 1], [1, 1], [2, 2]]);

    // last session: helper sessions win over match gaps; old sessions are ignored
    const H = 3600;
    const ms = [{ id: 1, t: 1000, dur: 1800 }, { id: 2, t: 3000, dur: 1800 }, { id: 3, t: 30000, dur: 1800 }, { id: 4, t: 32000, dur: 1800 }];
    eq('session from match gaps', E.lastSession(ms, null, 34000, 18).games.map(m => m.id), [3, 4]);
    eq('session from the helper', E.lastSession(ms, { playing: false, sessions: [{ start: 500, end: 5000 }] }, 6000, 18).games.map(m => m.id), [1, 2]);
    eq('still playing: no recap', E.lastSession(ms, { playing: true, sessions: [{ start: 500, end: 5000 }, { start: 29000, end: null }] }, 33000, 18), null);
    eq('too old: no recap', E.lastSession(ms, null, 34000 + 30 * H, 18), null);

    // friends
    const hist = [1, 2, 3, 4, 5, 6].map(i => ({ id: i, t: i, won: i <= 3 }));
    const fs = E.friendStats([{ mate_id: 7, matches_played: 12, wins: 8, matches: [1, 2, 4] }, { mate_id: 8, matches_played: 3, wins: 1, matches: [5] }], hist);
    eq('friends: only 10+ games together', fs.map(f => f.acct), [7]);
    eq('friends: win rate together vs apart', [fs[0].wrTogether, fs[0].wrApart], [2 / 3, 1 / 3]);

    // duo: habit + who died first, from the same match detail
    const D = { dur: 1800, objs: [], mbs: [], players: [
      { slot: 1, team: 0, acct: 9, items: [], snaps: [], deaths: [[900, 3, 0, 0, 9]] },
      { slot: 2, team: 0, acct: 7, items: null, snaps: [], deaths: [[300, 3, 0, 0, 9]] },
      { slot: 3, team: 1, acct: 5, items: null, snaps: [], deaths: [] }] };
    const du = E.duo([{ m: { id: 1, won: false }, L: null, D }], 9, 7, 'early0', {});
    eq('duo: habit passes each', [du.mePass, du.meN, du.themPass, du.themN], [1, 1, 0, 1]);
    eq('duo: who died first in losses', [du.firstMe, du.firstThem], [0, 1]);
    eq('asPlayer moves the seat', E.asPlayer(D, 7).players.find(p => p.items).acct, 7);
  }

  // ---------------------------------------------------------------- squads
  {
    // squadRow from a small detail: me (1) and friend (2) on team 0, an enemy on team 1.
    const pl = (acct, team, deaths, items) => ({ acct, team, hero: acct, slot: acct, lane: 1, items: items || null, deaths,
      snaps: [[0, 0, 0, 0, 0, 0, 0, 0, 0], [720, 5000, 0, 0, 0, 0, 0, 0, 0]] });
    const D = { v: 3, dur: 1800, players: [pl(1, 0, [[300, 3, 0, 0, 2]], []), pl(2, 0, [[1000, 3, 0, 0, 2]]), pl(3, 1, [])] };
    const row = E.squadRow(D, { id: 9, t: 100, won: true }, null);
    eq('squad row: only my team, me + friend', row.team.map(s => s[0]), [1, 2]);
    eq('squad row: early deaths, caught before 15:00', [row.team[0][2], row.team[0][4], row.team[1][2], row.team[1][4]], [1, 1, 0, 0]);
    eq('squad row: no model -> cost null', row.team[0][5], null);

    // rows: friend 2 always loses less win chance than me (5 vs 15 pts) -> 'them'; friend 3 flips by half -> 'close'.
    const R = (i, won, mine, f2, f3) => ({ v: 1, id: i, t: i, won, team: [[1, 1, 1, 1, 0, mine, [mine, 300, 7]], ...(f2 != null ? [[2, 2, 0, 1, 0, f2, null]] : []), ...(f3 != null ? [[3, 3, 0, 0, 1, f3, [0.3, 900, 8]]] : [])] });
    const rows = [];
    for (let i = 0; i < 12; i++) rows.push(R(i, i % 2 === 0, 0.15, 0.05, i < 6 ? 0.05 : 0.30));
    eq('versus: steady gap -> them', E.versus(rows, 1, 2).call, 'them');
    eq('versus: order flips between halves -> close', E.versus(rows, 1, 3).call, 'close');
    eq('versus: too few shared games', E.versus(rows.slice(0, 5), 1, 2).call, 'few');
    eq('board: sorted by cost, you included', E.friendBoard(rows, 1, [{ acct: 2 }, { acct: 3 }]).map(p => p.acct), [2, 1, 3]);
    const sc = E.scorecard(rows, 1, 2);
    eq('scorecard: I trail, plan targets my gaps', [sc.trailing, sc.plan.map(p => p.id)], ['me', ['early0']]);
    eq('scorecard: cost metric names the better player', sc.metrics.find(x => x.id === 'cost').better, 'them');
  }

  // ---------------------------------------------------------------- match tags
  {
    // [team, souls, k, d, a, dmg, heal, hero, obj, dmgTaken, lh, denies, mvp, lane, acc, acct]
    const row = (team, o) => Object.assign([team, 30000, 4, 6, 8, 20000, 500, 1, 2000, 25000, 100, 4, 0, 1, 40, 0], o || {});
    const mk = me => ({ v: E.LOBBY_V, me: 0, dur: 1800, win: 0, p: [row(0, me), ...[0, 0, 0, 0, 0].map(t => row(t)), ...Array.from({ length: 6 }, () => row(1))] });
    const ids = (x) => E.matchTags(x).map(t => t.id);
    const big = mk({ 1: 60000, 2: 14, 3: 0, 4: 12, 5: 50000, 8: 9000, 12: 1, 14: 55 });
    const t1 = ids({ m: { won: true, dur: 1800, souls: 60000 }, L: big });
    eq('tags: a carry game', ['mvp', 'untouchable', 'hardcarry', 'executioner', 'playmaker', 'heavy', 'farmer', 'demolisher', 'sharp'].every(k => t1.includes(k)), true);
    eq('tags: strongest first', t1[0], 'mvp');
    eq('tags: every label is one word or two joined by a hyphen', Object.values(E.MATCH_TAGS).every(t => /^(MVP|[A-Z][a-z]+(-[A-Z][a-z]+)?)$/.test(t[0])), true);
    const t2 = ids({ m: { won: false, dur: 1100 }, L: mk({ 1: 15000, 3: 12, 2: 1, 5: 8000 }) });
    eq('tags: a rough loss: fed, starved, stomped', ['fed', 'starved', 'stomped'].every(k => t2.includes(k)) && !t2.includes('farmer'), true);
    const quiet = mk({ 1: 22000, 2: 1, 4: 3, 5: 9000, 8: 0, 14: 20 }), loud = mk({ 1: 60000, 2: 1, 4: 3, 5: 9000, 8: 0, 14: 20 });
    eq('tags: passenger only when you were the lobby best at nothing', [ids({ m: { won: true, dur: 1800 }, L: quiet }).includes('passenger'), ids({ m: { won: true, dur: 1800 }, L: loud }).includes('passenger')], [true, false]);
    eq('tags: glass cannon = top-2 damage and top-2 deaths', ids({ m: { won: false, dur: 1800 }, L: mk({ 5: 50000, 3: 11 }) }).includes('glass'), true);
    eq('tags: form', [ids({ m: { won: true, dur: 1800 }, form: 1.2 }), ids({ m: { won: true, dur: 1800 }, form: -1.4 })], [['onfire'], ['offday']]);
    eq('tags: comeback / thrown from the win-chance timeline', [ids({ m: { won: true, dur: 1800 }, wp: [{ p: 0.5 }, { p: 0.2 }, { p: 0.9 }] }), ids({ m: { won: false, dur: 1800 }, wp: [{ p: 0.5 }, { p: 0.8 }, { p: 0.1 }] })], [['comeback'], ['thrown']]);
    eq('tags: career best needs 10+ earlier games', [ids({ m: { won: true, dur: 1800, souls: 50 }, past: Array(10).fill({ souls: 40 }) }), ids({ m: { won: true, dur: 1800, souls: 50 }, past: Array(9).fill({ souls: 40 }) })], [['best'], []]);
    // detail: you (slot 1) kill five enemies in a row, die 3 times before 9:00, and lead your lane opponent 30% at 9:00
    const snap = (t, souls) => [t, souls, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const D = { v: E.DETAIL_V, dur: 1800, players: [
      { slot: 1, team: 0, lane: 1, items: [], snaps: [snap(540, 6500)], deaths: [[100, 9, 0, 0, 2], [200, 9, 0, 0, 3], [300, 9, 0, 0, 4]] },
      { slot: 9, team: 1, lane: 1, items: null, snaps: [snap(540, 5000)], deaths: [400, 500, 600, 700, 800].map(t => [t, 1, 0, 0, 9]) }] };
    const t3 = ids({ m: { won: true, dur: 1800 }, D });
    eq('tags: from match detail', ['unstoppable', 'caught', 'rough', 'bully'].every(k => t3.includes(k)), true);
  }

  // ---------------------------------------------------------------- freshness
  {
    const ms = [{ id: 1, t: 1000, dur: 1800 }, { id: 2, t: 5000, dur: 2000 }];   // newest ends at 7000
    const f0 = E.freshness(ms, null, 10000);
    eq('freshness: newest match + age', [f0.newestId, f0.newestEnd, f0.sinceS, f0.unseenS], [2, 7000, 3000, 0]);
    const H = { sessions: [{ start: 4800, end: 7300 }, { start: 9000, end: 12000 }, { start: 13000, end: null }] };
    // first session ends inside the 10-min grace after the match; later ones are unseen play
    eq('freshness: finished play after the newest match; the open session doesn’t count', E.freshness(ms, H, 14000).unseenS, 12000 - 9000);
    eq('freshness: no matches', E.freshness([], H, 14000).newestId, null);
  }

  // ---------------------------------------------------------------- misc
  eq('badge 42 = Sentinel 2', E.badgeName(42), 'Sentinel 2');
  eq('badge 24 = Seeker 4', E.badgeName(24), 'Seeker 4');
  eq('badge null', E.badgeName(null), 'Unranked');
  eq('rank series cumulative', E.rankSeries([{ delta: 300 }, { delta: null }, { delta: -100 }]).map(p => p.cum), [300, 200]);

  // ---------------------------------------------------------------- match review (review.js)
  if (typeof require === 'function' && !root.Review) require('./review.js');
  const Rv = root.Review;
  {
    // A tiny match: 6 heroes (0 = you, 1-2 your team, 3-5 theirs), 120 s, everyone 1000 souls.
    // Heroes stand far apart; scenarios move some of them next to you.
    const mk = (place, opts) => {
      opts = opts || {};
      const end = 120, frames = [];
      for (let s = 0; s <= end; s++) {
        const row = [];
        for (let i = 0; i < 6; i++) { const p = place(s, i) || [i * 5000 - 9000, 9000]; row.push(p[0], p[1], 100, opts.dead && opts.dead(s, i) ? 0 : 1); }
        frames.push(row);
      }
      const souls = []; for (let s = 0; s <= end; s += 10) souls.push((opts.souls || [1000, 1000, 1000, 1000, 1000, 1000]).slice());
      return { end, me: 0, myTeam: 2, heroes: [2, 2, 2, 3, 3, 3].map((team, i) => ({ id: i + 1, team })), frames, souls,
        vis: opts.vis || null, objs: opts.objs || [], troop: {}, kills: opts.kills || [] };
    };
    // you alone at (0,0); enemies 3 and 4 walk up from 60 s and kill you at 70 s
    const gank = mk((s, i) => i === 0 ? [0, 0] : (i === 3 || i === 4) && s >= 60 ? [500 + i * 100, 0] : null,
      { kills: [{ t: 70, v: 0, a: 3, gold: 800 }], dead: (s, i) => i === 0 && s >= 70 });
    const sit = Rv.situation(gank, 62, 2600);
    eq('review: situation counts the two enemies next to you', [sit.allies.length, sit.enemies.length], [0, 2]);
    eq('review: fight maths = their souls / yours in the fight', sit.fight, { us: 1000, them: 2000 });
    ok('review: 1v2 at equal souls (2.0x) is clearly bad', Rv.severity(sit) > 0, Rv.severity(sit));
    eq('review: an even 1v1 is never a question', Rv.severity({ enemies: [3], allies: [], hp: 100, fight: { us: 1000, them: 3000 } }), 0);
    eq('review: outnumbered but their side has under ODDS x your souls is not a question',
      Rv.severity({ enemies: [3, 4], allies: [], hp: 100, fight: { us: 1500, them: 2000 } }), 0);
    eq('review: fight starts the second you became outnumbered', Rv.fightStart(gank, 70), 60);
    const ms = Rv.findMoments(gank);
    eq('review: the gank is one question, asked 3 s before it turned bad', ms.map(m => [m.t, m.death, m.phase]), [[57, 70, 'lane']]);
    const q = Rv.buildQuestion(gank, ms[0], i => 'H' + i);
    eq('review: question options and the good answer', q.opts.map(o => o.id + ':' + o.verdict), ['fight:risky', 'hold:risky', 'back:good']);
    ok('review: the bounty is in the fall-back reason', /800-soul bounty/.test(q.opts[2].why), q.opts[2].why);
    // same gank, but your team never saw enemy 4: judged on 1v1, so no question
    const fog = mk((s, i) => i === 0 ? [0, 0] : (i === 3 || i === 4) && s >= 60 ? [500 + i * 100, 0] : null,
      { kills: [{ t: 70, v: 0, a: 3 }], dead: (s, i) => i === 0 && s >= 70, vis: Array(121).fill(1 << 3) });
    eq('review: an enemy hidden by fog does not count', [Rv.situation(fog, 62, 2600).enemies.length, Rv.situation(fog, 62, 2600).unseen.length], [1, 1]);
    eq('review: an ambush (attackers unseen) is not a question', Rv.findMoments(fog).length, 0);
    // standing on your own Patron: a last stand, never a question
    const base = mk((s, i) => i === 0 ? [0, 0] : (i === 3 || i === 4) && s >= 60 ? [500 + i * 100, 0] : null,
      { kills: [{ t: 70, v: 0, a: 3 }], dead: (s, i) => i === 0 && s >= 70, objs: [{ kind: 'patron', team: 2, x: 100, y: 0, born: 0, died: null }] });
    eq('review: defending your own base is not a question', Rv.findMoments(base).length, 0);
    eq('review: phase is lane before 9:00', Rv.phaseAt(gank, 539), 'lane');
    const slot = (phase, sev, t) => ({ phase, severity: sev, t });
    eq('review: 3 per phase, spare slots lent, 9 at most',
      Rv.pickSlots([...[1, 2, 3, 4, 5, 6, 7].map(i => slot('mid', i, 600 + i)), slot('lane', 1, 10), ...[1, 2, 3, 4, 5].map(i => slot('late', i, 2000 + i))]).length, 9);
    // pack: delta rows carried forward, positions from cell + vec, clock from game start
    const P = Rv.pack({
      rules: [{ tick: 0, gst: 10 }],
      map: [{ hero: 7, team: 2, hp: 0x8000 | 100, account: 42 }, { hero: 8, team: 3, hp: 101, account: 43 }],
      pawns: [{ tick: 640, entity_index: 100, hp: 500, hpmax: 1000, life: 0, cx: 64, cy: 64, vx: 10, vy: 20 }, { tick: 704, entity_index: 100, hp: 250 },
        { tick: 640, entity_index: 101, hp: 100, hpmax: 100, life: 0, cx: 65, cy: 64, vx: 0, vy: 0 }],
      players: [], kills: [{ tick: 704, v: 101, a: 100, gold: 300 }], obj: [], troop: [], fow: [],
    }, 42, 1);
    eq('pack: you first, hero ids kept', P.heroes.map(h => h.id), [7, 8]);
    eq('pack: position = cell * 512 + vec - 32768; health carried forward', P.frames[1].slice(0, 4), [10, 20, 25, 1]);
    eq('pack: the kill on the game clock', [P.kills[0].t, P.kills[0].v, P.kills[0].a], [1, 1, 0]);
  }

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
