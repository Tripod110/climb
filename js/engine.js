/* engine.js — every number Climb shows comes from here. Pure functions, no DOM, no network,
   so it runs unchanged in the browser and under `node js/tests.js`.

   The model, in one paragraph:
   - A match's RESULT is win/loss. How you PLAYED is scored against your own history on that
     hero, so a quiet support game is compared with your other games on that support, never
     with the lobby's carry.
   - "How you played" uses lobby-relative ratios (your souls / lobby average, etc.) so a slow
     stompy lobby and a fast scrappy one land on the same scale, and then a z-score against
     your other games on the same hero. Positive = above your usual.
   - Result x played gives the four classes: earned / passenger / unlucky / rough.
   - Lobby-placement TAGS (Farmer, Damage…) are bragging rights within that one lobby and do
     not feed the classification.
   - The verdict for a window is three signals (rank points, form, consistency) and nothing
     that claims to know WHY. */
(function (root) {
  'use strict';

  const ACCOUNT_ID = 186993885;
  const MIN_HERO_GAMES = 5;            // games on a hero before it gets a baseline
  const SESSION_GAP_S = 2 * 3600;      // a >2h break ends a session
  const SEASON_GAP_S = 45 * 86400;     // a >45 day hole in ranked play starts a new season
  const COMPARE_N = 20;                // size of the "before" window
  const FORM_STEP = 0.2;               // mean-score shift (in SDs) that counts as a real move
  const ROUGH_STEP = 0.1;              // 10 points of rough-game rate
  const SD_FLOOR = 0.05;
  const Z_CAP = 3;                     // per-stat z clamp               // log-ratio SD floor so one-trick consistency can't explode z

  /* Fallback names if /v1/assets/ranks hasn't loaded. Confirmed against the API 2026-10-04. */
  const TIER_NAMES = ['Obscurus', 'Initiate', 'Seeker', 'Acolyte', 'Sentinel', 'Mystic',
    'Ritualist', 'Emissary', 'Oracle', 'Phantom', 'Ascendant', 'Eternus'];

  const QUADS = ['earned', 'unlucky', 'passenger', 'rough'];
  const QUAD_LABEL = { earned: 'Earned win', unlucky: 'Unlucky loss', passenger: 'Passenger win', rough: 'Rough game' };
  const TAG_LABEL = { farmer: 'Farmer', damage: 'Damage', playmaker: 'Playmaker', survivor: 'Survivor', support: 'Support' };
  const METRICS = ['souls', 'dmg', 'ka', 'deaths'];

  // ---------------------------------------------------------------- normalising API data

  /* /v1/players/{id}/match-history row -> our match. Win is match_result === player_team
     (player_match_outcome is not reliable for this). ranked_delta is null for pre-2025 games. */
  function normalizeMatch(r) {
    const mode = r.match_mode === 4 ? 'ranked' : r.match_mode === 1 ? 'unranked' : 'other';
    return {
      id: r.match_id, t: r.start_time, mode, hero: r.hero_id,
      won: r.match_result === r.player_team,
      delta: r.ranked_delta == null ? null : r.ranked_delta,
      badge: r.ranked_display_badge == null ? null : r.ranked_display_badge,
      calib: !!r.ranked_calibration_match,
      dur: r.match_duration_s || 0,
      k: r.player_kills || 0, d: r.player_deaths || 0, a: r.player_assists || 0,
      souls: r.net_worth || 0, lh: r.last_hits || 0,
    };
  }
  function normalizeHistory(rows) {
    return (rows || []).map(normalizeMatch).filter(m => m.mode !== 'other').sort((x, y) => x.t - y.t || x.id - y.id);
  }

  /* /v1/matches/metadata (bulk) item -> a compact lobby: ~600 bytes instead of ~80KB.
     players: [team, souls, kills, deaths, assists, playerDamage, healing]; me = index of us. */
  function compactLobby(meta, accountId) {
    const acct = accountId || ACCOUNT_ID;
    const teamNum = t => (typeof t === 'number' ? t : String(t).endsWith('1') ? 1 : 0);
    const players = (meta.players || []).map(p => {
      const fs = p.final_stats || {};
      return [teamNum(p.team), p.net_worth || fs.net_worth || 0, p.kills || 0, p.deaths || 0,
        p.assists || 0, fs.player_damage || 0, fs.player_healing || 0];
    });
    const me = (meta.players || []).findIndex(p => p.account_id === acct);
    if (me < 0 || players.length < 2) return null;
    return { avgBadge: meta.average_badge || null, me, p: players };
  }

  // ---------------------------------------------------------------- lobby placement

  const mean = xs => xs.reduce((s, x) => s + x, 0) / (xs.length || 1);
  /* Competition rank, 1 = best; ties share the better rank. */
  function rankOf(values, i, higherIsBetter) {
    const v = values[i];
    return 1 + values.filter(x => (higherIsBetter ? x > v : x < v)).length;
  }

  function lobbyStats(lobby) {
    const P = lobby.p, i = lobby.me, me = P[i];
    const souls = P.map(p => p[1]), ka = P.map(p => p[2] + p[4]), deaths = P.map(p => p[3]);
    const dmg = P.map(p => p[5]), heal = P.map(p => p[6]);
    const ranks = {
      souls: rankOf(souls, i, true), dmg: rankOf(dmg, i, true), ka: rankOf(ka, i, true),
      deaths: rankOf(deaths, i, false), heal: rankOf(heal, i, true),
    };
    const ratio = {
      souls: me[1] / Math.max(1, mean(souls)),
      dmg: dmg.some(x => x > 0) ? me[5] / Math.max(1, mean(dmg)) : null,
      ka: (me[2] + me[4] + 1) / (mean(ka) + 1),
      deaths: (mean(deaths) + 1) / (me[3] + 1),   // inverted: higher is better
    };
    const tags = [];
    if (ranks.souls <= 3) tags.push('farmer');
    if (ratio.dmg != null && ranks.dmg <= 3) tags.push('damage');
    if (ranks.ka <= 3) tags.push('playmaker');
    if (ranks.deaths <= 2) tags.push('survivor');
    // Healing only counts when it is real healing, not 100 HP of incidental lifesteal.
    if (ranks.heal <= 2 && me[6] >= 1.5 * mean(heal) && me[6] > 0) tags.push('support');
    const placement = mean([ranks.souls, ranks.dmg, ranks.ka, ranks.deaths]);
    return { ranks, ratio, tags, placement, size: P.length };
  }

  // ---------------------------------------------------------------- performance vs your hero history

  /* Returns Map(matchId -> {score, z, base}) for every match in `targets` that has a lobby and
     enough other games on its hero in `pool`. Leave-one-out: a game is never part of its own
     baseline, so a single monster game can't drag its own score toward zero. */
  function perfScores(pool, lobbies, targets) {
    const feat = new Map();
    for (const m of pool) {
      const L = lobbies[m.id];
      if (!L) continue;
      const r = lobbyStats(L).ratio;
      const f = {};
      for (const k of METRICS) f[k] = r[k] == null ? null : Math.log(Math.max(r[k], 0.01));
      feat.set(m.id, { hero: m.hero, f });
    }
    const byHero = new Map();
    for (const [id, x] of feat) {
      if (!byHero.has(x.hero)) byHero.set(x.hero, []);
      byHero.get(x.hero).push(id);
    }
    const out = new Map();
    for (const m of targets || pool) {
      const me = feat.get(m.id);
      if (!me) continue;
      const others = (byHero.get(m.hero) || []).filter(id => id !== m.id);
      if (others.length < MIN_HERO_GAMES - 1) continue;
      const z = {};
      for (const k of METRICS) {
        if (me.f[k] == null) { z[k] = null; continue; }
        const xs = others.map(id => feat.get(id).f[k]).filter(v => v != null);
        if (xs.length < MIN_HERO_GAMES - 1) { z[k] = null; continue; }
        const mu = mean(xs);
        const sd = Math.max(SD_FLOOR, Math.sqrt(mean(xs.map(v => (v - mu) ** 2))));
        // Clamp: with small baselines one freak stat (a 1-death game) can hit z=6 and drown
        // the other three. +-3 still reads as 'exceptional' without owning the average.
        z[k] = Math.max(-Z_CAP, Math.min(Z_CAP, (me.f[k] - mu) / sd));
      }
      const zs = METRICS.map(k => z[k]).filter(v => v != null);
      out.set(m.id, { score: mean(zs), z, base: others.length });
    }
    return out;
  }

  function classify(match, perf) {
    if (!perf) return null;
    const well = perf.score >= 0;
    return match.won ? (well ? 'earned' : 'passenger') : (well ? 'unlucky' : 'rough');
  }

  // ---------------------------------------------------------------- windows

  /* Ranked games since the last >45-day hole. Valve's ranked data only carries ranked_delta from
     the current system onward, and a long break is where "your season" honestly restarts. */
  function seasonOf(ranked) {
    let start = 0;
    for (let i = 1; i < ranked.length; i++) if (ranked[i].t - ranked[i - 1].t > SEASON_GAP_S) start = i;
    return ranked.slice(start);
  }
  function sessionOf(ranked) {
    if (!ranked.length) return [];
    let start = ranked.length - 1;
    while (start > 0 && ranked[start].t - (ranked[start - 1].t + ranked[start - 1].dur) < SESSION_GAP_S) start--;
    return ranked.slice(start);
  }

  /* -> { cur, prev, label, prevLabel } as arrays of matches (ascending). */
  function windowsFor(kind, ranked) {
    const season = seasonOf(ranked);
    if (kind === 'session') {
      const cur = sessionOf(season);
      const before = season.slice(0, season.length - cur.length);
      return { cur, prev: before.slice(-COMPARE_N), label: 'Last session', prevLabel: 'the ' + Math.min(COMPARE_N, before.length) + ' games before' };
    }
    if (kind === 'last20') {
      const cur = season.slice(-COMPARE_N);
      const before = season.slice(0, season.length - cur.length);
      return { cur, prev: before.slice(-COMPARE_N), label: 'Last ' + cur.length + ' games', prevLabel: 'the ' + Math.min(COMPARE_N, before.length) + ' before' };
    }
    const half = Math.floor(season.length / 2);
    return { cur: season.slice(half), prev: season.slice(0, half), label: 'Second half of the season', prevLabel: 'the first half', all: season };
  }

  /* Badge -> a linear subrank index (6 subranks per tier) so averages and differences mean
     something: Seeker 6 -> Acolyte 1 is one step, not five. */
  const ladder = b => (b == null || b <= 0 ? null : Math.floor(b / 10) * 6 + (b % 10));

  function summarize(games, perf, lobbies) {
    const q = { earned: 0, unlucky: 0, passenger: 0, rough: 0 };
    let classified = 0, scoreSum = 0, net = 0, hasDelta = 0;
    const lobbyLadder = [];
    for (const m of games) {
      const L = lobbies && lobbies[m.id];
      if (L && ladder(L.avgBadge) != null) lobbyLadder.push(ladder(L.avgBadge));
      const p = perf.get(m.id);
      const c = classify(m, p);
      if (c) { q[c]++; classified++; scoreSum += p.score; }
      if (m.delta != null) { net += m.delta; hasDelta++; }
    }
    const wins = games.filter(m => m.won).length;
    return {
      n: games.length, wins, losses: games.length - wins,
      winRate: games.length ? wins / games.length : null,
      net, hasDelta, q, classified,
      meanScore: classified ? scoreSum / classified : null,
      roughRate: classified ? q.rough / classified : null,
      lobby: lobbyLadder.length ? mean(lobbyLadder) : null,
    };
  }

  /* One rank point "unit" = a typical single-game swing, so "up" means at least one game's
     worth of net gain rather than an arbitrary constant. */
  function rankUnit(ranked) {
    const xs = ranked.map(m => Math.abs(m.delta || 0)).filter(x => x > 0).sort((a, b) => a - b);
    return xs.length ? xs[Math.floor(xs.length / 2)] : 300;
  }

  /* Lobby-relative scores have a known bias: climbing puts you in better lobbies, so the same
     play places lower. When the average lobby got >= TOUGHER_STEP subranks harder, a dip in
     form/consistency is reported but not counted against you — holding level against better
     players is not slipping. */
  const TOUGHER_STEP = 3;

  function verdict(cur, prev, unit) {
    const sig = (dir, text, detail) => ({ dir, text, detail });
    const signals = [];
    const lobbyShift = prev && cur.lobby != null && prev.lobby != null ? cur.lobby - prev.lobby : null;
    const tougher = lobbyShift != null && lobbyShift >= TOUGHER_STEP;

    // 1. Rank — the outcome. Only needs the current window.
    if (cur.hasDelta) {
      const dir = cur.net >= unit ? 1 : cur.net <= -unit ? -1 : 0;
      signals.push(sig(dir, 'rank', { net: cur.net, wins: cur.wins, losses: cur.losses }));
    } else signals.push(sig(null, 'rank', { wins: cur.wins, losses: cur.losses }));

    // 2. Form — how you played vs your usual, compared with the window before.
    if (cur.classified >= 3) {
      const ref = prev && prev.classified >= 3 ? prev.meanScore : 0;
      const shift = cur.meanScore - ref;
      const dir = shift >= FORM_STEP ? 1 : shift <= -FORM_STEP ? -1 : 0;
      signals.push(sig(dir, 'form', { score: cur.meanScore, ref, shift, hasRef: !!(prev && prev.classified >= 3) }));
    } else signals.push(sig(null, 'form', { classified: cur.classified }));

    // 3. Consistency — fewer rough games is improvement even before it shows as wins.
    if (cur.classified >= 3 && prev && prev.classified >= 3) {
      const shift = cur.roughRate - prev.roughRate;
      const dir = shift <= -ROUGH_STEP ? 1 : shift >= ROUGH_STEP ? -1 : 0;
      signals.push(sig(dir, 'consistency', { rate: cur.roughRate, ref: prev.roughRate, rough: cur.q.rough, of: cur.classified }));
    } else signals.push(sig(null, 'consistency', { rate: cur.roughRate, rough: cur.q.rough, of: cur.classified }));

    if (tougher) for (const s of signals) {
      if (s.text !== 'rank' && s.dir === -1) { s.dir = 0; s.detail.tougher = true; }
    }
    const known = signals.filter(s => s.dir != null);
    const total = known.reduce((s, x) => s + x.dir, 0);
    let call = 'holding';
    if (known.length === 0 || cur.n === 0) call = 'unknown';
    else if (total >= 2 || (total >= 1 && known.length === 1)) call = 'improving';
    // Up in rank AND keeping pace in lobbies that got clearly harder: that is improvement.
    else if (tougher && signals[0].dir === 1 && known.every(s => s.dir >= 0)) call = 'improving';
    else if (total <= -2 || (total <= -1 && known.length === 1)) call = 'slipping';
    const confidence = cur.n < 5 || known.length < 2 ? 'low' : cur.n < 10 ? 'medium' : 'high';
    return { call, signals, confidence, lobbyShift, tougher };
  }

  // ---------------------------------------------------------------- series & breakdowns

  function rankSeries(season) {
    let cum = 0;
    return season.filter(m => m.delta != null).map(m => {
      cum += m.delta;
      return { id: m.id, t: m.t, cum, delta: m.delta, badge: m.badge, won: m.won, hero: m.hero };
    });
  }

  function heroBreakdown(games, perf) {
    const by = new Map();
    for (const m of games) {
      if (!by.has(m.hero)) by.set(m.hero, []);
      by.get(m.hero).push(m);
    }
    return [...by].map(([hero, ms]) => {
      const s = summarize(ms, perf);
      const scored = ms.filter(m => perf.has(m.id));
      // Recent form on this hero: last 5 scored games vs the rest.
      let trend = null;
      if (scored.length >= 8) {
        const recent = mean(scored.slice(-5).map(m => perf.get(m.id).score));
        const earlier = mean(scored.slice(0, -5).map(m => perf.get(m.id).score));
        trend = recent - earlier;
      }
      return { hero, games: ms.length, ...s, ready: scored.length > 0, trend };
    }).sort((a, b) => b.games - a.games);
  }

  function badgeName(badge, tiers) {
    if (badge == null) return 'Unranked';
    const tier = Math.floor(badge / 10), sub = badge % 10;
    const name = (tiers && tiers[tier]) || TIER_NAMES[tier] || 'Tier ' + tier;
    return sub ? name + ' ' + sub : name;
  }

  // ---------------------------------------------------------------- pre-queue briefing

  /* The launch notification: a few lines, rank-first, read in five seconds before queuing.
     Everything is a count or an average. It says what moved and never why. */
  const BRIEF_HERO_N = 10;              // a hero's "recent" = its last 10 season games
  const BRIEF_ACTIVE_S = 30 * 86400;    // only heroes played in the last 30 days are worth naming
  const BRIEF_MIN_SIDE = 8;             // both sides of a lever split need 8+ games

  const fmtInt = n => String(Math.round(Math.abs(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const signedInt = n => (n > 0 ? '+' : n < 0 ? '−' : '±') + fmtInt(n);
  const wl = ms => { const w = ms.filter(m => m.won).length; return { w, l: ms.length - w }; };

  /* The stat that moved most on a hero: its last 5 games vs its earlier season games. Returns
     a short phrase, or null when nothing moved by 10%+ or the sample is too thin. */
  function heroStatShift(games) {
    if (games.length < 8) return null;
    const recent = games.slice(-5), before = games.slice(0, -5);
    const spm = ms => mean(ms.map(m => m.souls / Math.max(1, m.dur / 60)));
    const dpg = ms => mean(ms.map(m => m.d));
    const cands = [
      { a: spm(recent), b: spm(before), up: 'more souls/min', down: 'fewer souls/min', goodUp: true, fmt: x => fmtInt(x) },
      { a: dpg(recent), b: dpg(before), up: 'dying more', down: 'dying less', goodUp: false, fmt: x => x.toFixed(1) },
    ].map(c => Object.assign(c, { rel: c.b ? (c.a - c.b) / c.b : 0 }))
      .filter(c => Math.abs(c.rel) >= 0.1)
      .sort((x, y) => Math.abs(y.rel) - Math.abs(x.rel));
    if (!cands.length) return null;
    const c = cands[0];
    return { text: `${c.a > c.b ? c.up : c.down} (${c.fmt(c.a)} vs ${c.fmt(c.b)})`, good: (c.a > c.b) === c.goodUp };
  }

  function briefing(ranked, lobbies, opts) {
    const o = Object.assign({ now: Date.now() / 1000, heroName: id => 'Hero ' + id, tiers: null }, opts);
    const season = seasonOf(ranked);
    if (!season.length) return null;
    const last = season[season.length - 1];
    const unit = rankUnit(season);
    const recent = season.slice(-COMPARE_N);
    const r = wl(recent), net = recent.reduce((s, m) => s + (m.delta || 0), 0);
    const title = `${badgeName(last.badge, o.tiers)} · last ${recent.length}: ${r.w}–${r.l}, ${signedInt(net)}`;

    // Hot and cold heroes by rank points over each hero's recent games.
    const byHero = new Map();
    for (const m of season) { if (!byHero.has(m.hero)) byHero.set(m.hero, []); byHero.get(m.hero).push(m); }
    const heroes = [...byHero].filter(([, ms]) => ms.length >= 4 && o.now - ms[ms.length - 1].t <= BRIEF_ACTIVE_S)
      .map(([hero, ms]) => {
        const g = ms.slice(-BRIEF_HERO_N);
        return { hero, all: ms, g, net: g.reduce((s, m) => s + (m.delta || 0), 0), ...wl(g) };
      });
    const hot = heroes.filter(h => h.net >= unit).sort((a, b) => b.net - a.net)[0] || null;
    const cold = heroes.filter(h => h.net <= -unit).sort((a, b) => a.net - b.net)[0] || null;
    const heroLine = (h, verb) => {
      const shift = heroStatShift(h.all);
      return `${o.heroName(h.hero)} is ${verb}: ${h.w}–${h.l}, ${signedInt(h.net)} over its last ${h.g.length}` +
        (shift ? `, ${shift.text}` : '');
    };

    // The lever: which lobby placement splits your wins most clearly this season.
    let lever = null;
    const placed = season.filter(m => lobbies[m.id]).map(m => ({ m, s: lobbyStats(lobbies[m.id]) }));
    const splits = [
      { name: 'top 3 in souls', test: x => x.s.ranks.souls <= 3 },
      { name: 'one of the 2 fewest deaths in the lobby', test: x => x.s.ranks.deaths <= 2 },
    ].map(sp => {
      const yes = placed.filter(sp.test).map(x => x.m), no = placed.filter(x => !sp.test(x)).map(x => x.m);
      if (yes.length < BRIEF_MIN_SIDE || no.length < BRIEF_MIN_SIDE) return null;
      const a = wl(yes), b = wl(no);
      const ra = a.w / yes.length, rb = b.w / no.length;
      return { ...sp, a, b, ra, rb, gap: ra - rb };
    }).filter(Boolean).sort((x, y) => y.gap - x.gap);
    if (splits.length && splits[0].gap >= 0.15) {
      const s = splits[0];
      lever = `You win ${Math.round(s.ra * 100)}% when you're ${s.name} (${s.a.w}–${s.a.l}), ${Math.round(s.rb * 100)}% otherwise.`;
    }

    return {
      title,
      hot: hot ? heroLine(hot, 'gaining you rank') : null,
      cold: cold ? heroLine(cold, 'costing you rank') : null,
      lever,
      lastId: last.id,
    };
  }

  // ---------------------------------------------------------------- benchmark

  /* You vs better players on the same hero, minute for minute. End-of-game averages are useless
     here: win rate is ~50% at every rank and Phantom lobbies' totals look like Sentinel's because
     their games are shorter. Matched game times do separate them, but only from Phantom up
     (Sentinel → Emissary moved ~1% per tier when checked on 2026-10-21), so the reference is
     Phantom+ and your own bracket is shown as the baseline.
     Window per hero: games since the last big patch; under BENCH_MIN_PATCH of them it widens to
     BENCH_WIDE_DAYS and says so; under MIN_HERO_GAMES even then, the hero isn't benchmarked.
     A gap is only called when it beats 2 standard errors of YOUR mean (the reference averages
     thousands of games, so its own error is negligible) and is at least 5%. */
  const BENCH_MIN_PATCH = 8;
  const BENCH_WIDE_DAYS = 60;
  const BENCH_MAX_HEROES = 6;
  const BENCH_TIMES = [900, 1200, 1800];   // 30 min only counts games that lasted that long
  const BENCH_REL_FLOOR = 0.05;
  /* Each stat = the curve's fields summed. Lane and jungle souls each come in two parts (creep
     kills + the orbs you secure); those parts sum, with death losses, to net worth. Their SDs are
     added, not combined in quadrature, which errs towards calling fewer gaps. */
  const BENCH_STATS = [
    { key: 'souls', label: 'Souls', f: ['net_worth'], higher: true },
    { key: 'lane', label: 'Lane souls', f: ['gold_lane_creep', 'gold_lane_creep_orbs'], higher: true },
    { key: 'jungle', label: 'Jungle souls', f: ['gold_neutral_creep', 'gold_neutral_creep_orbs'], higher: true },
    { key: 'obj', label: 'Objective damage', f: ['boss_damage'], higher: true },
    { key: 'dmg', label: 'Hero damage', f: ['player_damage'], higher: true },
    { key: 'deaths', label: 'Deaths', f: ['deaths'], higher: false },
  ];

  /* The latest big-patch day at or before `now`, from /v1/patches/big-days (ISO strings). */
  function lastBigPatch(days, now) {
    const ts = (days || []).map(d => Date.parse(d) / 1000).filter(t => t <= now);
    return ts.length ? Math.max(...ts) : null;
  }

  /* Whole days, so the widened window (and the curve cache keyed on it) only moves once a day. */
  const benchWideFrom = now => Math.floor(now / 86400 - BENCH_WIDE_DAYS) * 86400;

  function benchWindow(games, hero, patchT, now) {
    const mine = games.filter(m => m.hero === hero);
    const wideFrom = benchWideFrom(now);
    if (patchT != null) {
      const n = mine.filter(m => m.t >= patchT).length;
      if (n >= BENCH_MIN_PATCH) return { hero, from: patchT, n, widened: false, spansPatch: false };
    }
    const from = patchT == null ? wideFrom : Math.min(patchT, wideFrom);
    const n = mine.filter(m => m.t >= from).length;
    if (n < MIN_HERO_GAMES) return null;
    return { hero, from, n, widened: true, spansPatch: patchT != null && from < patchT };
  }

  /* Your most-played heroes over the wide window that qualify, most games first. */
  function benchHeroes(games, patchT, now) {
    const wideFrom = Math.min(patchT == null ? Infinity : patchT, benchWideFrom(now));
    const count = new Map();
    for (const m of games) if (m.t >= wideFrom) count.set(m.hero, (count.get(m.hero) || 0) + 1);
    return [...count.keys()].map(h => benchWindow(games, h, patchT, now)).filter(Boolean)
      .sort((a, b) => b.n - a.n || a.hero - b.hero).slice(0, BENCH_MAX_HEROES);
  }

  /* Lobby-average badge ranges for "your bracket" (your tier, all subranks) and the reference.
     Phantom and Ascendant players get compared with Eternus; Eternus players have no one above. */
  function benchBrackets(badge) {
    const tier = badge == null ? 0 : Math.floor(badge / 10);
    const bracket = { min: tier * 10 + 1, max: tier * 10 + 6, tier };
    const ref = tier >= 11 ? null : tier >= 9 ? { min: 111, tier: 11 } : { min: 91, tier: 9 };
    return { bracket, ref };
  }

  /* /v1/analytics/player-performance-curve (resolution=0) rows -> { [time]: { n, [stat]: [avg, sd] } }
     for BENCH_TIMES only. A few hundred bytes instead of ~20KB. */
  function compactCurve(rows) {
    const out = {};
    for (const r of rows || []) {
      if (!BENCH_TIMES.includes(r.game_time)) continue;
      const c = { n: r.samples || 0 };
      for (const s of BENCH_STATS) {
        c[s.key] = [s.f.reduce((x, f) => x + (r[f + '_avg'] || 0), 0), s.f.reduce((x, f) => x + (r[f + '_std'] || 0), 0)];
      }
      out[r.game_time] = c;
    }
    return out;
  }

  function benchCompare(mine, bracket, ref) {
    const times = {};
    for (const t of BENCH_TIMES) {
      const me = mine && mine[t], vs = ref && ref[t], base = bracket && bracket[t];
      if (!me || !me.n) continue;
      times[t] = {
        n: me.n,
        rows: BENCH_STATS.map(s => {
          const [you, sd] = me[s.key];
          const r = vs ? vs[s.key][0] : null;
          const gap = r == null ? null : you - r;
          const rel = r ? gap / r : null;
          const se = sd / Math.sqrt(me.n);
          const sig = gap != null && me.n >= 2 && Math.abs(gap) > 2 * se && Math.abs(rel) >= BENCH_REL_FLOOR;
          return { key: s.key, label: s.label, you, bracket: base ? base[s.key][0] : null, ref: r, gap, rel, sig,
            good: gap == null ? null : (gap > 0) === s.higher };
        }),
      };
    }
    // Headlines: called gaps at 15 and 20 min (30 is long games only), behind first, biggest first,
    // one per stat (its larger gap of the two times).
    const best = new Map();
    for (const t of [900, 1200]) {
      for (const r of (times[t] ? times[t].rows : [])) {
        if (!r.sig) continue;
        const cur = best.get(r.key);
        if (!cur || Math.abs(r.rel) > Math.abs(cur.rel)) best.set(r.key, Object.assign({ t }, r));
      }
    }
    const headlines = [...best.values()].sort((a, b) => (a.good - b.good) || Math.abs(b.rel) - Math.abs(a.rel)).slice(0, 2);
    return { times, headlines };
  }

  const Engine = {
    BENCH_TIMES, BENCH_STATS, BENCH_MIN_PATCH, BENCH_WIDE_DAYS,
    lastBigPatch, benchWindow, benchHeroes, benchBrackets, compactCurve, benchCompare,
    ACCOUNT_ID, MIN_HERO_GAMES, COMPARE_N, QUADS, QUAD_LABEL, TAG_LABEL, TIER_NAMES,
    ladder, normalizeMatch, normalizeHistory, compactLobby, lobbyStats, perfScores, classify,
    seasonOf, sessionOf, windowsFor, summarize, rankUnit, verdict, rankSeries, heroBreakdown, badgeName,
    heroStatShift, briefing,
  };
  root.Engine = Engine;
  if (typeof module === 'object' && module.exports) module.exports = Engine;
})(typeof window !== 'undefined' ? window : globalThis);
