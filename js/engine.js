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

  /* /v1/matches/metadata (bulk) item -> a compact lobby: ~1KB instead of ~80KB.
     players: [team, souls, kills, deaths, assists, playerDamage, healing,          (0–6, v1)
               hero, objectiveDamage, damageTaken, lastHits, denies, mvpRank, lane,  (7–13, v2)
               accuracy %, accountId]                                               (14–15, v2)
     me = index of us. mvpRank is Valve's own post-game MVP (1–3, 0 = none).
     LOBBY_V bumps whenever the row grows, so cached lobbies of an older shape get re-fetched. */
  const LOBBY_V = 2;
  function compactLobby(meta, accountId) {
    const acct = accountId || ACCOUNT_ID;
    const teamNum = t => (typeof t === 'number' ? t : String(t).endsWith('1') ? 1 : 0);
    const players = (meta.players || []).map(p => {
      const fs = p.final_stats || {};
      const shots = (fs.shots_hit || 0) + (fs.shots_missed || 0);
      return [teamNum(p.team), p.net_worth || fs.net_worth || 0, p.kills || 0, p.deaths || 0,
        p.assists || 0, fs.player_damage || 0, fs.player_healing || 0,
        p.hero_id || 0, fs.boss_damage || 0, fs.player_damage_taken || 0, p.last_hits || 0, p.denies || 0,
        p.mvp_rank || 0, p.assigned_lane || 0, shots ? Math.round(100 * (fs.shots_hit || 0) / shots) : 0,
        p.account_id || 0];
    });
    const me = (meta.players || []).findIndex(p => p.account_id === acct);
    if (me < 0 || players.length < 2) return null;
    return {
      v: LOBBY_V, avgBadge: meta.average_badge || null, me, p: players,
      dur: meta.duration_s || 0,
      win: meta.winning_team == null ? null : teamNum(meta.winning_team),
    };
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
    { key: 'kills', label: 'Kills', f: ['kills'], higher: true },
    { key: 'assists', label: 'Assists', f: ['assists'], higher: true },
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

  // ---------------------------------------------------------------- steam id

  /* Whatever the user pastes -> { account } (a 32-bit account id, what deadlock-api calls
     account_id / SteamID3) or { search } (a name to look up). Accepts a profile URL, SteamID64,
     [U:1:n], STEAM_0:x:y, a bare account id, or a persona name. */
  const STEAM64_BASE = 76561197960265728n;
  function parseSteamInput(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    let m = s.match(/steamcommunity\.com\/profiles\/(\d{17})/i) || s.match(/^(7656\d{13})$/);
    if (m) return { account: Number(BigInt(m[1]) - STEAM64_BASE) };
    m = s.match(/^\[?U:1:(\d+)\]?$/i);
    if (m) return { account: Number(m[1]) };
    m = s.match(/^STEAM_[0-5]:([01]):(\d+)$/i);
    if (m) return { account: Number(m[2]) * 2 + Number(m[1]) };
    m = s.match(/steamcommunity\.com\/id\/([^/?#]+)/i);
    if (m) return { search: decodeURIComponent(m[1]) };
    if (/^\d{1,10}$/.test(s) && Number(s) > 0 && Number(s) < 2 ** 32) return { account: Number(s) };
    return { search: s };
  }

  // ---------------------------------------------------------------- impact & game roles

  /* Every player's impact on their own team: their share of the team's souls, damage (or
     healing, whichever is bigger, so supports aren't invisible), kills + assists and objective
     damage, each relative to the team average (1.0 = an average teammate), minus a penalty for
     dying more than the team average. Team-relative on purpose: "did I carry THIS team" is
     about my five teammates, not the enemy's carry. */
  function lobbyImpact(L) {
    const P = L.p;
    const teams = [0, 1].map(t => P.map((p, i) => i).filter(i => P[i][0] === t));
    const out = P.map(() => null);
    for (const idx of teams) {
      if (!idx.length) continue;
      const avg = f => mean(idx.map(i => f(P[i])));
      const a = { souls: avg(p => p[1]), dmg: avg(p => p[5]), heal: avg(p => p[6]), ka: avg(p => p[2] + p[4]),
        obj: avg(p => p[8] || 0), d: avg(p => p[3]) };
      for (const i of idx) {
        const p = P[i];
        const r = {
          souls: p[1] / Math.max(1, a.souls),
          dmg: Math.max(p[5] / Math.max(1, a.dmg), a.heal > 0 ? 0.8 * p[6] / Math.max(1, a.heal) : 0),
          ka: (p[2] + p[4] + 1) / (a.ka + 1),
          obj: ((p[8] || 0) + 500) / (a.obj + 500),
          deaths: (p[3] + 1) / (a.d + 1),
        };
        const impact = 0.3 * r.souls + 0.3 * r.dmg + 0.25 * r.ka + 0.15 * r.obj - 0.25 * (r.deaths - 1);
        out[i] = { impact, r };
      }
      const order = idx.slice().sort((x, y) => out[y].impact - out[x].impact);
      order.forEach((i, k) => { out[i].teamRank = k + 1; out[i].teamSize = idx.length; });
    }
    return out;
  }

  const ROLE_LABEL = {
    carried: 'Carried', key: 'Key player', solid: 'Solid win', passenger: 'Passenger',
    lonewolf: 'Couldn’t carry', tough: 'Tough loss', dragged: 'Dragged down',
  };
  const ROLE_GOOD = { carried: 1, key: 1, lonewolf: 1, solid: 0, tough: 0, passenger: -1, dragged: -1 };
  const ROLE_NOTE = {
    carried: 'Won, and you were clearly your team’s biggest impact.',
    key: 'One of the two biggest impacts on your team, or one of Valve’s MVPs.',
    solid: 'Won, pulling your weight in the middle of your team.',
    passenger: 'Won, but near the bottom of your team’s impact. They carried this one.',
    lonewolf: 'Lost, but you were clearly your team’s biggest impact.',
    tough: 'Lost, with you in the middle of your team.',
    dragged: 'Lost, and you were at the bottom of your team’s impact.',
  };
  const TAG2_LABEL = {
    mvp1: 'MVP', mvp2: '2nd MVP', mvp3: '3rd MVP', farm: 'Top farmer', dmg: 'Top damage',
    kills: 'Most kills', play: 'Playmaker', obj: 'Objective focus', heal: 'Healer', tank: 'Frontline',
    survivor: 'Survivor', fed: 'Fed', stomp: 'Stomp', stomped: 'Stomped', long: 'Marathon',
  };
  const TAG2_GOOD = { fed: -1, stomped: -1 };
  const CARRY_IMPACT = 1.3, DRAG_IMPACT = 0.8;

  /* The read on one game: a role (one of ROLE_LABEL) and any number of tags. Needs a v2 lobby. */
  function gameRole(L, won) {
    if (!L || L.v !== LOBBY_V) return null;
    const P = L.p, i = L.me, me = P[i];
    const imp = lobbyImpact(L)[i];
    const mvp = me[12] || 0;
    const top = (col, hi) => rankOf(P.map(p => p[col]), i, hi !== false) === 1;
    const teamDeaths = P.filter(p => p[0] === me[0]).map(p => p[3]);
    const mostDeathsOnTeam = me[3] > 0 && me[3] >= Math.max(...teamDeaths);
    let role;
    if (won) {
      role = imp.teamRank === 1 && imp.impact >= CARRY_IMPACT ? 'carried'
        : imp.teamRank <= 2 || (mvp >= 1 && mvp <= 3) ? 'key'
        : imp.teamRank >= imp.teamSize - 1 ? 'passenger' : 'solid';
    } else {
      role = imp.teamRank === 1 && imp.impact >= CARRY_IMPACT ? 'lonewolf'
        : imp.teamRank <= 2 || (mvp >= 1 && mvp <= 3) ? 'key'
        : imp.teamRank === imp.teamSize || imp.impact < DRAG_IMPACT || (mostDeathsOnTeam && imp.teamRank >= 4) ? 'dragged'
        : 'tough';
    }
    const tags = [];
    if (mvp >= 1 && mvp <= 3) tags.push('mvp' + mvp);
    if (top(1)) tags.push('farm');
    if (top(5)) tags.push('dmg');
    if (top(2)) tags.push('kills');
    if (rankOf(P.map(p => p[2] + p[4]), i, true) === 1) tags.push('play');
    if (top(8) && me[8] > 0) tags.push('obj');
    const heals = P.map(p => p[6]);
    if (top(6) && me[6] >= 3000 && me[6] >= 1.5 * mean(heals)) tags.push('heal');
    if (top(9) && me[9] > 0) tags.push('tank');
    if (top(3, false) && me[3] <= 3) tags.push('survivor');
    if (me[3] >= 10 || (top(3) && me[3] >= 8)) tags.push('fed');
    const dur = L.dur || 0;
    if (dur && dur < 20 * 60) tags.push(won ? 'stomp' : 'stomped');
    if (dur >= 45 * 60) tags.push('long');
    return { role, tags, impact: imp.impact, teamRank: imp.teamRank, teamSize: imp.teamSize, r: imp.r, mvp };
  }

  /* Role counts and rates over a set of games, for the Overview tiles and hero cards. */
  function roleSummary(games, lobbies) {
    const counts = Object.fromEntries(Object.keys(ROLE_LABEL).map(k => [k, 0]));
    let n = 0, impactSum = 0, mvp = 0;
    for (const m of games) {
      const g = gameRole(lobbies[m.id], m.won);
      if (!g) continue;
      n++; counts[g.role]++; impactSum += g.impact;
      if (g.mvp >= 1 && g.mvp <= 3) mvp++;
    }
    const rate = k => (n ? counts[k] / n : null);
    return {
      n, counts, mvp, impact: n ? impactSum / n : null,
      carry: n ? (counts.carried + counts.lonewolf) / n : null,  // games you were the team's #1, won or lost
      key: n ? (counts.carried + counts.key + counts.lonewolf) / n : null,
      dragged: n ? (counts.dragged + counts.passenger) / n : null,
      rate,
    };
  }

  // ---------------------------------------------------------------- rank ladder (Heroes tab)

  /* You on one hero against every rank from Initiate to Eternus, over the same dates. Curve
     metrics are at a chosen game minute; Win rate and Accuracy are whole-game. For each metric
     we say which rank's average you reach ("level"), and whether you are behind, on par or
     ahead of YOUR rank by more than your own game-to-game noise. */
  const LADDER_TIERS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const LADDER_FLAT = 0.08;
  const LADDER_METRICS = [
    { key: 'wr', label: 'Win rate', src: 'stats', higher: true, fmt: 'pct', noLevel: true },
    { key: 'acc', label: 'Accuracy', src: 'stats', higher: true, fmt: 'pct' },
    { key: 'souls', label: 'Souls', src: 'curve', higher: true },
    { key: 'lane', label: 'Lane souls', src: 'curve', higher: true },
    { key: 'jungle', label: 'Jungle souls', src: 'curve', higher: true },
    { key: 'dmg', label: 'Hero damage', src: 'curve', higher: true },
    { key: 'obj', label: 'Objective damage', src: 'curve', higher: true },
    { key: 'kills', label: 'Kills', src: 'curve', higher: true, fmt: 'dec' },
    { key: 'assists', label: 'Assists', src: 'curve', higher: true, fmt: 'dec' },
    { key: 'deaths', label: 'Deaths', src: 'curve', higher: false, fmt: 'dec' },
  ];

  /* /v1/analytics/hero-stats rows -> { [heroId]: { n, wr, acc } }. */
  function compactHeroStats(rows) {
    const out = {};
    for (const r of rows || []) {
      if (!r.matches) continue;
      const shots = (r.total_shots_hit || 0) + (r.total_shots_missed || 0);
      out[r.hero_id] = { n: r.matches, wr: r.wins / r.matches, acc: shots ? r.total_shots_hit / shots : null };
    }
    return out;
  }

  function rankLadder(hero, t, mine, tiers, yourTier) {
    // mine = { curve, stats }, tiers = { [tier]: { curve, stats } }; curves are compactCurve shapes.
    const pick = (src, key) => {
      if (!src) return null;
      if (key === 'wr' || key === 'acc') { const s = src.stats && src.stats[hero]; return s && s[key] != null ? { v: s[key], sd: null, n: s.n } : null; }
      const c = src.curve && src.curve[t];
      return c && c[key] ? { v: c[key][0], sd: c[key][1], n: c.n } : null;
    };
    const rows = LADDER_METRICS.map(M => {
      const you = pick(mine, M.key);
      const ladder = LADDER_TIERS.map(tier => { const x = pick(tiers[tier], M.key); return { tier, v: x ? x.v : null, n: x ? x.n : 0 }; });
      if (!you) return Object.assign({ you: null, ladder, level: null, vsTier: null, own: null, next: null }, M);
      // "Plays like": the rank whose average is closest to yours. Some stats don't climb with
      // rank (low lobbies deal MORE damage in messier games), so "highest rank you beat" would
      // mislead. A stat that varies < LADDER_FLAT across ranks is 'flat': rank doesn't move it.
      let level = null;
      const vals = ladder.filter(L => L.v != null);
      if (!M.noLevel && vals.length) {
        const lo = Math.min(...vals.map(L => L.v)), hi = Math.max(...vals.map(L => L.v));
        const mid = mean(vals.map(L => L.v));
        if (mid && (hi - lo) / Math.abs(mid) < LADDER_FLAT) level = 'flat';
        else level = vals.reduce((b, L) => (Math.abs(L.v - you.v) < Math.abs(b.v - you.v) ? L : b)).tier;
      }
      // Behind / on par / ahead of one rank's average, by more than your own game-to-game noise.
      const versus = tier => {
        const o = ladder.find(L => L.tier === tier);
        if (!o || o.v == null) return { status: null, rel: null, v: null };
        const rel = o.v ? (you.v - o.v) / o.v : 0;
        let se;
        if (M.key === 'wr') se = Math.sqrt(Math.max(o.v * (1 - o.v), 0.01) / Math.max(1, you.n));
        else if (you.sd != null) se = you.sd / Math.sqrt(Math.max(1, you.n));
        else se = 0;
        const gap = you.v - o.v;
        const sig = Math.abs(gap) > 2 * se && Math.abs(rel) >= BENCH_REL_FLOOR;
        return { status: !sig ? 'par' : (gap > 0) === M.higher ? 'ahead' : 'behind', rel, v: o.v };
      };
      const own = versus(yourTier), next = versus(Math.min(11, yourTier + 1));
      const vsTier = own.status, rel = own.rel;
      return Object.assign({ you: you.v, n: you.n, ladder, level, vsTier, rel, own, next }, M);
    });
    const behind = rows.filter(r => r.vsTier === 'behind').sort((a, b) => Math.abs(b.rel) - Math.abs(a.rel));
    const ahead = rows.filter(r => r.vsTier === 'ahead').sort((a, b) => Math.abs(b.rel) - Math.abs(a.rel));
    // What stands between you and the next rank: metrics where you trail its average, biggest first.
    const toNext = rows.filter(r => r.next && r.next.status === 'behind').sort((a, b) => Math.abs(b.next.rel) - Math.abs(a.next.rel));
    return { rows, behind, ahead, toNext };
  }

  // ---------------------------------------------------------------- coach debrief (AI)

  /* The AI coach only ever sees what this section hands it: a compact, factual brief of one
     match. Everything is computed here (pure, tested); coach.js just sends it. The rules in
     DEBRIEF_SYSTEM forbid using anything not in the brief, because general models know little
     about Deadlock and patches move fast. */

  /* /v1/assets/items/by-type/upgrade -> { id: [name, slot, tier, cost] } */
  function compactItems(rows) {
    const out = {};
    for (const i of rows || []) if (i && i.id && i.name) out[i.id] = [i.name, i.item_slot_type || '', i.item_tier || 0, i.cost || 0];
    return out;
  }

  /* Full metadata for one match (items, death details, stat snapshots) -> what the brief needs.
     Snapshots: [t, souls, kills, deaths, assists, heroDamage, laneSouls, jungleSouls, lastHits]. */
  function compactMatchDetail(meta, accountId) {
    const teamNum = t => (typeof t === 'number' ? t : String(t).endsWith('1') ? 1 : 0);
    const players = (meta.players || []).map(p => ({
      slot: p.player_slot, team: teamNum(p.team), hero: p.hero_id, lane: p.assigned_lane || 0, acct: p.account_id,
      snaps: (p.stats || []).map(s => [s.time_stamp_s, s.net_worth || 0, s.kills || 0, s.deaths || 0, s.assists || 0, s.player_damage || 0,
        (s.gold_lane_creep || 0) + (s.gold_lane_creep_orbs || 0), (s.gold_neutral_creep || 0) + (s.gold_neutral_creep_orbs || 0), s.creep_kills || 0]),
      items: p.account_id === accountId ? (p.items || []).map(x => [x.game_time_s, x.item_id, x.sold_time_s || 0]) : null,
      deaths: p.account_id === accountId ? (p.death_details || []).map(d => [d.game_time_s, d.killer_player_slot,
        Math.round((d.death_pos || [])[0] || 0), Math.round((d.death_pos || [])[1] || 0), Math.round((d.time_to_kill_s || 0) * 10) / 10]) : null,
    }));
    const me = players.find(p => p.acct === accountId);
    if (!me) return null;
    return { v: 1, dur: meta.duration_s || 0, win: meta.winning_team == null ? null : teamNum(meta.winning_team), players };
  }

  /* World position -> a coarse zone a player can picture, from that player's side. The map is a
     circle (radius ~10.7k) with Amber's base at -y and Sapphire's at +y; lanes run along y at
     x ≈ -7k, 0 and +7k. Coarse on purpose: it says where, not exactly where. */
  function mapZone(x, y, team) {
    const own = team === 0 ? -y : y;   // + = towards your own base
    const half = own > 7500 ? 'near your base' : own > 1500 ? 'your half' : own < -7500 ? 'near the enemy base' : own < -1500 ? 'enemy half' : 'mid-map';
    const side = x < -3000 ? 'west side' : x > 3000 ? 'east side' : 'centre';
    return `${half}, ${side}`;
  }

  const clock = s => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

  /* -> a plain object; JSON.stringify of it is the user message. opts: heroName, items (compact),
     tierName, ladder (rankLadder result at 20 min, optional), yourTier. */
  function debriefBrief(m, L, D, g, perf, opts) {
    const o = Object.assign({ heroName: id => 'Hero ' + id, items: {}, tierName: t => 'Tier ' + t, ladder: null, yourTier: 0 }, opts);
    const me = D.players.find(p => p.acct === (L.p[L.me][15] || null)) || D.players.find(p => p.items);
    const bySlot = new Map(D.players.map(p => [p.slot, p]));
    const nm = id => o.heroName(id);
    const snapAt = (p, t) => { let best = null; for (const s of p.snaps) if (s[0] <= t) best = s; return best; };
    const laneOpp = D.players.filter(p => p.team !== me.team && p.lane === me.lane);
    const laneMate = D.players.filter(p => p.team === me.team && p.lane === me.lane && p !== me);
    const econ = [360, 540, 720, 900, 1200, 1500, 1800].filter(t => t <= D.dur).map(t => {
      const s = snapAt(me, t);
      if (!s) return null;
      const opp = laneOpp.map(p => snapAt(p, t)).filter(Boolean);
      const teamS = D.players.filter(p => p.team === me.team).map(p => snapAt(p, t)).filter(Boolean);
      const enemyS = D.players.filter(p => p.team !== me.team).map(p => snapAt(p, t)).filter(Boolean);
      return {
        at: clock(t), your_souls: s[1], lane_souls: s[6], jungle_souls: s[7], k_d_a: `${s[2]}/${s[3]}/${s[4]}`,
        lane_opponents_avg_souls: opp.length ? Math.round(mean(opp.map(x => x[1]))) : null,
        team_souls_total: teamS.reduce((a, x) => a + x[1], 0), enemy_souls_total: enemyS.reduce((a, x) => a + x[1], 0),
      };
    }).filter(Boolean);
    const deaths = (me.deaths || []).map(([t, slot, x, y, ttk]) => {
      const k = bySlot.get(slot);
      return { at: clock(t), killed_by: k ? nm(k.hero) : 'unknown', where: mapZone(x, y, me.team), seconds_to_die: ttk };
    });
    const items = (me.items || []).filter(([, id]) => o.items[id]).sort((x, y) => x[0] - y[0]).map(([t, id, sold]) => {
      const it = o.items[id];
      return Object.assign({ at: clock(t), item: it[0], slot: it[1], tier: it[2] }, sold ? { sold_at: clock(sold) } : {});
    });
    const row = r => ({ hero: nm(r[7]), k_d_a: `${r[2]}/${r[3]}/${r[4]}`, souls: r[1], hero_damage: r[5], healing: r[6], objective_damage: r[8], valve_mvp: r[12] || 0 });
    const team = t => L.p.filter(r => r[0] === t).map(r => Object.assign(row(r), r === L.p[L.me] ? { is_you: true } : {}));
    const brief = {
      match: {
        hero: nm(m.hero), result: m.won ? 'win' : 'loss', duration: clock(D.dur || m.dur), mode: m.mode,
        rank_points_change: m.delta, lobby_average_rank: L.avgBadge ? o.tierName(Math.floor(L.avgBadge / 10)) : null,
      },
      you: {
        k_d_a: `${m.k}/${m.d}/${m.a}`, souls: m.souls, last_hits: m.lh,
        climb_role: g ? ROLE_LABEL[g.role] : null,
        climb_role_meaning: g ? ROLE_NOTE[g.role] : null,
        impact_vs_average_teammate: g ? Math.round(g.impact * 100) / 100 : null,
        impact_rank_on_team: g ? `${g.teamRank} of ${g.teamSize}` : null,
        share_vs_average_teammate: g ? Object.fromEntries(Object.entries(g.r).map(([k, v]) => [k, Math.round(v * 100) + '%'])) : null,
        tags: g ? g.tags.map(t => TAG2_LABEL[t]) : [],
        accuracy_pct: L.p[L.me][14] || null,
        lane_partners: laneMate.map(p => nm(p.hero)),
        lane_opponents: laneOpp.map(p => nm(p.hero)),
      },
      vs_your_usual_on_this_hero: perf ? Object.assign({ games_compared: perf.base },
        Object.fromEntries(Object.entries(perf.z).filter(([, v]) => v != null).map(([k, v]) => [{ souls: 'souls', dmg: 'damage', ka: 'kills_assists', deaths: 'staying_alive' }[k], Math.round(v * 10) / 10]))) : null,
      economy_timeline: econ,
      deaths,
      item_buys: items,
      your_team: team(L.p[L.me][0]),
      enemy_team: team(1 - L.p[L.me][0]),
    };
    if (o.ladder) {
      brief.hero_vs_ranks = {
        note: `Your recent average on ${nm(m.hero)} vs the average ${nm(m.hero)} game in each rank's lobbies, at 20 min (win rate and accuracy whole-game). Your rank: ${o.yourTier ? o.tierName(o.yourTier) : 'unranked'}.`,
        stats: o.ladder.rows.filter(r => r.you != null).map(r => ({
          stat: r.label, you: Math.round(r.you * 100) / 100,
          your_rank_avg: r.own && r.own.v != null ? Math.round(r.own.v * 100) / 100 : null,
          next_rank_avg: r.next && r.next.v != null ? Math.round(r.next.v * 100) / 100 : null,
          vs_next_rank: r.next ? r.next.status : null,
        })),
      };
    }
    return brief;
  }

  const DEBRIEF_SYSTEM = [
    'You are a blunt, specific Deadlock coach reviewing ONE match for the player marked is_you.',
    'Rules:',
    '- Use ONLY facts in the brief. Every point must cite at least one number or time from it.',
    '- Never invent hero abilities, item effects, map details or patch facts. Only name items and heroes that appear in the brief.',
    '- Zones are coarse ("enemy half, east side"); do not claim more precision than that.',
    '- Prefer the pattern that cost the most: early deaths, souls falling behind lane opponents, late core items, dying fast (low seconds_to_die = caught out).',
    '- If the player played well, say so plainly, then give the one thing that would have made it better.',
    '- "fix" is one concrete thing to do next game, phrased as an instruction.',
    '- Plain words, no hype, no emojis. Short.',
  ].join('\n');

  const DEBRIEF_SCHEMA = {
    type: 'OBJECT',
    properties: {
      summary: { type: 'STRING', description: 'One sentence: what decided this game for the player.' },
      points: {
        type: 'ARRAY', minItems: 3, maxItems: 3,
        items: {
          type: 'OBJECT',
          properties: {
            title: { type: 'STRING', description: 'A few words.' },
            evidence: { type: 'STRING', description: 'The numbers/times from the brief that show it.' },
            fix: { type: 'STRING', description: 'One concrete instruction for next game.' },
            kind: { type: 'STRING', enum: ['strength', 'mistake'] },
          },
          required: ['title', 'evidence', 'fix', 'kind'],
        },
      },
      focus_next_game: { type: 'STRING', description: 'The single thing to focus on next game on this hero.' },
    },
    required: ['summary', 'points', 'focus_next_game'],
  };

  // ---------------------------------------------------------------- overall analysis (last N games)

  /* Patterns across many games, counted here (free, exact) so the AI only has to read one
     summary instead of N match briefs. entries: [{ m, L, D }] (normalized match, v2 lobby,
     compactMatchDetail). items: compactItems map, for tier lookups. Every number the Coach tab
     shows comes from this, AI or not. */
  const PHASES = [[0, 600, '0–10 min'], [600, 1200, '10–20 min'], [1200, 1800, '20–30 min'], [1800, Infinity, '30+ min']];
  const ECON_TIMES = [360, 720, 1200];
  const FAST_DEATH_S = 5;

  function aggregateGames(entries, items, heroName) {
    const hn = heroName || (id => 'Hero ' + id);
    const rows = entries.filter(e => e.m && e.L && e.L.v === LOBBY_V && e.D);
    const out = { n: rows.length, wins: 0, losses: 0 };
    if (!rows.length) return out;
    const split = () => ({ all: [], win: [], loss: [] });
    const push = (s, won, v) => { if (v == null || Number.isNaN(v)) return; s.all.push(v); s[won ? 'win' : 'loss'].push(v); };
    const avg = xs => xs.length ? mean(xs) : null;
    const fin = s => ({ all: avg(s.all), win: avg(s.win), loss: avg(s.loss), n: s.all.length });

    const deathsPerGame = split(), early = split(), fast = split();
    const phase = PHASES.map(() => split());
    const zones = new Map(), killers = new Map();
    let deathTotal = 0, fastTotal = 0;
    const econ = ECON_TIMES.map(() => ({ diff: split(), ahead: split() }));
    const lateSwing = split();
    const t3 = split(), t4 = split();
    const roles = Object.fromEntries(Object.keys(ROLE_LABEL).map(k => [k, { n: 0, w: 0 }]));
    const impact = split();
    const heroes = new Map();

    for (const { m, L, D } of rows) {
      const won = m.won;
      out[won ? 'wins' : 'losses']++;
      const me = D.players.find(p => p.items) || D.players.find(p => p.acct === L.p[L.me][15]);
      if (!me) continue;
      // deaths
      const ds = me.deaths || [];
      push(deathsPerGame, won, ds.length);
      push(early, won, ds.filter(d => d[0] < 600).length);
      push(fast, won, ds.filter(d => d[4] > 0 && d[4] <= FAST_DEATH_S).length);
      PHASES.forEach(([a, b], i) => { if (D.dur > a) push(phase[i], won, ds.filter(d => d[0] >= a && d[0] < b).length); });
      for (const [, slot, x, y, ttk] of ds) {
        deathTotal++;
        if (ttk > 0 && ttk <= FAST_DEATH_S) fastTotal++;
        const z = mapZone(x, y, me.team);
        zones.set(z, (zones.get(z) || 0) + 1);
        const k = D.players.find(p => p.slot === slot);
        if (k) killers.set(k.hero, (killers.get(k.hero) || 0) + 1);
      }
      // economy vs lane opponents
      const at = (p, t) => { let best = null; for (const s of p.snaps) if (s[0] <= t) best = s; return best; };
      const opps = D.players.filter(p => p.team !== me.team && p.lane === me.lane);
      ECON_TIMES.forEach((t, i) => {
        if (D.dur < t || !opps.length) return;
        const mine = at(me, t), theirs = opps.map(p => at(p, t)).filter(Boolean);
        if (!mine || !theirs.length) return;
        const diff = mine[1] - mean(theirs.map(s => s[1]));
        push(econ[i].diff, won, diff);
        push(econ[i].ahead, won, diff > 0 ? 1 : 0);
      });
      if (D.dur >= 1800 && opps.length) {
        const g = p => { const a = at(p, 1200), b = at(p, 1800); return a && b ? b[1] - a[1] : null; };
        const mine = g(me), theirs = opps.map(g).filter(v => v != null);
        if (mine != null && theirs.length) push(lateSwing, won, mine - mean(theirs));
      }
      // item timings
      const firstTier = tier => { const x = (me.items || []).filter(([, id]) => items && items[id] && items[id][2] >= tier).sort((a, b) => a[0] - b[0])[0]; return x ? x[0] : null; };
      push(t3, won, firstTier(3));
      push(t4, won, firstTier(4));
      // roles
      const g = gameRole(L, won);
      if (g) { roles[g.role].n++; if (won) roles[g.role].w++; push(impact, won, g.impact); }
      // per hero
      if (!heroes.has(m.hero)) heroes.set(m.hero, { hero: m.hero, n: 0, w: 0, deaths: 0, early: 0 });
      const h = heroes.get(m.hero);
      h.n++; if (won) h.w++; h.deaths += ds.length; h.early += ds.filter(d => d[0] < 600).length;
    }

    const top = (map, k) => [...map].sort((a, b) => b[1] - a[1]).slice(0, k);
    Object.assign(out, {
      deaths: {
        perGame: fin(deathsPerGame), before10: fin(early), fast: fin(fast),
        fastShare: deathTotal ? fastTotal / deathTotal : null,
        byPhase: PHASES.map(([, , label], i) => Object.assign({ label }, fin(phase[i]))),
        zones: top(zones, 4).map(([zone, n]) => ({ zone, n, share: n / deathTotal })),
        killers: top(killers, 4).map(([hero, n]) => ({ hero, name: hn(hero), n })),
        total: deathTotal,
      },
      economy: ECON_TIMES.map((t, i) => ({ t, diff: fin(econ[i].diff), aheadRate: fin(econ[i].ahead) })),
      lateSwing: fin(lateSwing),
      items: { tier3: fin(t3), tier4: fin(t4) },
      roles: Object.entries(roles).filter(([, r]) => r.n).map(([role, r]) => ({ role, label: ROLE_LABEL[role], n: r.n, winRate: r.w / r.n })),
      impact: fin(impact),
      heroes: [...heroes.values()].sort((a, b) => b.n - a.n).map(h => Object.assign(h, { name: hn(h.hero), winRate: h.w / h.n, deathsPerGame: h.deaths / h.n, before10PerGame: h.early / h.n })),
    });
    return out;
  }

  /* The aggregate -> what Gemini reads. Rounded, labelled, nothing it has to compute. */
  function analysisBrief(agg, opts) {
    const o = Object.assign({ rankName: null, ladderGaps: [] }, opts);
    const r1 = v => v == null ? null : Math.round(v * 10) / 10;
    const r0 = v => v == null ? null : Math.round(v);
    const pc = v => v == null ? null : Math.round(v * 100) + '%';
    const mmss = s => s == null ? null : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
    const wl = (f, x) => ({ all: f(x.all), in_wins: f(x.win), in_losses: f(x.loss) });
    return {
      sample: { games: agg.n, wins: agg.wins, losses: agg.losses, current_rank: o.rankName },
      deaths: {
        per_game: wl(r1, agg.deaths.perGame),
        before_10_min_per_game: wl(r1, agg.deaths.before10),
        caught_out_per_game: Object.assign(wl(r1, agg.deaths.fast), { note: `deaths where you died within ${FAST_DEATH_S}s of taking damage` }),
        share_of_deaths_caught_out: pc(agg.deaths.fastShare),
        per_game_by_phase: agg.deaths.byPhase.map(p => ({ phase: p.label, all: r1(p.all), in_wins: r1(p.win), in_losses: r1(p.loss) })),
        most_common_zones: agg.deaths.zones.map(z => ({ zone: z.zone, deaths: z.n, share: pc(z.share) })),
        most_frequent_killers: agg.deaths.killers.map(k => ({ hero: k.name, kills_on_you: k.n })),
      },
      souls_vs_lane_opponents: agg.economy.map(e => ({ at: mmss(e.t), avg_difference: wl(r0, e.diff), games_ahead: wl(pc, e.aheadRate) })),
      souls_gained_20_to_30_min_vs_lane_opponents: wl(r0, agg.lateSwing),
      first_tier3_item_at: wl(mmss, agg.items.tier3),
      first_tier4_item_at: wl(mmss, agg.items.tier4),
      game_roles: { note: 'Climb roles are assigned within wins (Carried, Key player, Solid win, Passenger) or losses (Couldn’t carry, Key player, Tough loss, Dragged down), so they describe your part in the result, not the result itself.',
        counts: agg.roles.map(r => ({ role: r.label, games: r.n, of_which_wins: Math.round(r.winRate * r.n) })) },
      impact_vs_average_teammate: wl(v => v == null ? null : Math.round(v * 100) / 100, agg.impact),
      heroes: agg.heroes.slice(0, 6).map(h => ({ hero: h.name, games: h.n, win_rate: pc(h.winRate), deaths_per_game: r1(h.deathsPerGame), deaths_before_10_per_game: r1(h.before10PerGame) })),
      biggest_gaps_vs_next_rank: o.ladderGaps,
    };
  }

  const ANALYSIS_SYSTEM = [
    'You are a blunt, specific Deadlock coach reviewing a player\'s last games as a whole.',
    'The brief is pre-computed statistics. Every number is exact; do not recompute or estimate others.',
    'Rules:',
    '- Use ONLY facts in the brief. Every pattern must cite numbers from it, ideally a wins-vs-losses contrast.',
    '- Rank patterns by how many games they plausibly cost: the biggest win/loss contrasts first.',
    '- Never invent hero abilities, item effects, map details or patch facts.',
    '- Small samples (a hero with 1–3 games) are anecdotes; do not build a pattern on them.',
    '- "practice" is a concrete drill or habit for the next few sessions, not a platitude.',
    '- Plain words, no hype, no emojis.',
  ].join('\n');

  const ANALYSIS_SCHEMA = {
    type: 'OBJECT',
    properties: {
      headline: { type: 'STRING', description: 'One sentence: the state of this player\'s game right now.' },
      patterns: {
        type: 'ARRAY', minItems: 3, maxItems: 3,
        items: {
          type: 'OBJECT',
          properties: {
            title: { type: 'STRING' },
            evidence: { type: 'STRING', description: 'Numbers from the brief, wins vs losses where possible.' },
            why_it_costs_games: { type: 'STRING' },
            practice: { type: 'STRING', description: 'A concrete habit or drill.' },
          },
          required: ['title', 'evidence', 'why_it_costs_games', 'practice'],
        },
      },
      strengths: { type: 'ARRAY', minItems: 1, maxItems: 2, items: { type: 'OBJECT', properties: { title: { type: 'STRING' }, evidence: { type: 'STRING' } }, required: ['title', 'evidence'] } },
      next_sessions_plan: { type: 'ARRAY', minItems: 3, maxItems: 3, items: { type: 'STRING' }, description: 'Three short steps for the next few play sessions.' },
    },
    required: ['headline', 'patterns', 'strengths', 'next_sessions_plan'],
  };

  const Engine = {
    aggregateGames, analysisBrief, ANALYSIS_SYSTEM, ANALYSIS_SCHEMA, FAST_DEATH_S,
    compactItems, compactMatchDetail, mapZone, debriefBrief, DEBRIEF_SYSTEM, DEBRIEF_SCHEMA,
    LOBBY_V, ROLE_LABEL, ROLE_GOOD, ROLE_NOTE, TAG2_LABEL, TAG2_GOOD, LADDER_TIERS, LADDER_METRICS,
    parseSteamInput, lobbyImpact, gameRole, roleSummary, compactHeroStats, rankLadder,
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
