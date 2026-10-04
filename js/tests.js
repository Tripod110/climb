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
  eq('lobby row shape', L.p[4], [0, 34000, 4, 7, 5, 12000, 9000]);
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
