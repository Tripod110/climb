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

  /* A bulk /v1/matches/metadata item (include_info + include_player_info) -> our match, for a game
     Valve's match history leaves out (added by id). Same shape as normalizeMatch plus added: true;
     null if the account isn't in it. Here start_time is "YYYY-MM-DD HH:MM:SS" UTC, match_mode and
     teams are names ("Ranked", "Team1"), and the rank change is the flat-progress difference. */
  function matchFromMeta(meta, acct) {
    const p = meta && (meta.players || []).find(x => x.account_id === acct);
    if (!p) return null;
    const t = typeof meta.start_time === 'number' ? meta.start_time
      : Math.floor(Date.parse(String(meta.start_time).replace(' ', 'T') + 'Z') / 1000);
    const mm = String(meta.match_mode).toLowerCase();
    const mode = mm === 'ranked' || mm === '4' ? 'ranked' : mm === 'unranked' || mm === '1' ? 'unranked' : 'other';
    const a = p.player_rank_initial_flat_progress, b = p.player_rank_final_flat_progress;
    return {
      id: meta.match_id, t, mode, hero: p.hero_id,
      won: String(meta.winning_team) === String(p.team),
      delta: mode === 'ranked' && a != null && b != null ? b - a : null,
      badge: p.player_rank_initial_display_rank || null,
      calib: false,
      dur: meta.duration_s || 0,
      k: p.kills || 0, d: p.deaths || 0, a: p.assists || 0,
      souls: p.net_worth || 0, lh: p.last_hits || 0,
      added: true,
    };
  }
  /* History plus the games added by id ({ id: match }). Once Valve's history has a game, its row wins. */
  function mergeAdded(matches, added) {
    const have = new Set(matches.map(m => m.id));
    const extra = Object.values(added || {}).filter(m => m && m.mode !== 'other' && !have.has(m.id));
    return extra.length ? matches.concat(extra).sort((x, y) => x.t - y.t || x.id - y.id) : matches;
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
    // lobbyFirst: Valve's own post-game MVP #1, the "1st in the lobby" shown in-game. Climb's impact
    // score is team-relative, so it doesn't rank across both teams; on 60 real games the two never agreed.
    return { role, tags, impact: imp.impact, teamRank: imp.teamRank, teamSize: imp.teamSize, r: imp.r, mvp, lobbyFirst: mvp === 1 };
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

  const DETAIL_V = 3;   // 2 = + objectives and mid-boss; 3 = every player's deaths. Older cached details get re-fetched
  /* Full metadata for one match (items, death details, stat snapshots) -> what the brief needs.
     Snapshots: [t, souls, kills, deaths, assists, heroDamage, laneSouls, jungleSouls, lastHits]. */
  function compactMatchDetail(meta, accountId) {
    const teamNum = t => (typeof t === 'number' ? t : String(t).endsWith('1') ? 1 : 0);
    const players = (meta.players || []).map(p => ({
      slot: p.player_slot, team: teamNum(p.team), hero: p.hero_id, lane: p.assigned_lane || 0, acct: p.account_id,
      snaps: (p.stats || []).map(s => [s.time_stamp_s, s.net_worth || 0, s.kills || 0, s.deaths || 0, s.assists || 0, s.player_damage || 0,
        (s.gold_lane_creep || 0) + (s.gold_lane_creep_orbs || 0), (s.gold_neutral_creep || 0) + (s.gold_neutral_creep_orbs || 0), s.creep_kills || 0]),
      items: p.account_id === accountId ? (p.items || []).map(x => [x.game_time_s, x.item_id, x.sold_time_s || 0]) : null,
      deaths: (p.death_details || []).map(d => [d.game_time_s, d.killer_player_slot,
        Math.round((d.death_pos || [])[0] || 0), Math.round((d.death_pos || [])[1] || 0), Math.round((d.time_to_kill_s || 0) * 10) / 10]),
    }));
    const me = players.find(p => p.acct === accountId);
    if (!me) return null;
    // objs: [time destroyed, owning team] (the owner LOST it); mbs: [time, team that claimed the mid-boss].
    const objs = (meta.objectives || []).filter(o => o.destroyed_time_s).map(o => [o.destroyed_time_s, teamNum(o.team)]);
    const mbs = (meta.mid_boss || []).filter(b => b.destroyed_time_s).map(b => [b.destroyed_time_s, teamNum(b.team_claimed)]);
    return { v: DETAIL_V, dur: meta.duration_s || 0, win: meta.winning_team == null ? null : teamNum(meta.winning_team), players, objs, mbs };
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
    if (o.win) {
      const pc = v => Math.round(v * 100) + '%';
      brief.win_chance = {
        note: 'Your team\'s win chance from Climb\'s model trained on deadlock-api matches (souls, kills, objectives and mid-boss gaps at each minute). Death costs are what a death like that USUALLY costs at that minute, not a measurement of that death.',
        timeline: o.win.timeline.filter(x => !x.end).map(x => ({ at: clock(x.t), your_team: pc(x.p) })),
        biggest_swings: o.win.turning.map(w => ({ from: clock(w.from), to: clock(w.to), change: (w.delta > 0 ? '+' : '') + Math.round(w.delta * 100) + ' pts',
          your_deaths: w.myDeaths.map(clock), team_deaths: w.teamDeaths, enemy_deaths: w.enemyDeaths, objectives_lost: w.objLost, objectives_taken: w.objTaken, souls_gap_change: w.soulsSwing })),
        your_deaths: o.win.deaths.map(d => ({ at: clock(d.t), killed_by: d.killerHero != null ? nm(d.killerHero) : 'unknown',
          typical_cost: `about ${Math.round(d.total * 100)} pts of win chance (~${d.souls} souls swing)` })),
      };
    }
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

  // ---------------------------------------------------------------- v13: grounded reads

  /* Team share (replaces Carried/Dragged as a verdict). Checked 2026-10-23 on the user's last
     400 games: a share of your OWN team's stats cannot predict the result (impact AUC 0.49; team
     #1 by impact won 49%, #5 won 59%), because the whole team wins or loses together. So it's
     shown as a neutral description, never good/bad. What does predict results is early-game
     play, measured before the outcome is decided (the focus habits). */
  function teamShare(L, won) {
    const g = gameRole(L, won);
    if (!g) return null;
    const label = g.teamRank <= 2 ? 'Top share' : g.teamRank >= g.teamSize - 1 ? 'Low share' : 'Mid share';
    return { label, teamRank: g.teamRank, teamSize: g.teamSize, impact: g.impact, lobbyFirst: g.lobbyFirst, tags: g.tags };
  }

  /* Early-game rates over a set of games (needs match detail): the two habits that split the
     user's wins from losses most cleanly. -> { n, ahead12, clean10, nAhead, nClean } */
  function earlyRates(entries, items) {
    const rate = id => {
      const r = habitResults(habitById(id), entries, items).filter(x => x.pass != null);
      return { n: r.length, rate: r.length ? r.filter(x => x.pass).length / r.length : null };
    };
    const a = rate('ahead12'), c = rate('early0');
    return { ahead12: a.rate, nAhead: a.n, clean10: c.rate, nClean: c.n };
  }

  /* Which ladder stats move you toward the next rank, turned into training targets. Uses the
     rankLadder result for one hero. Each target says the number to hit and, where Climb can
     check it game by game, the focus habit that trains it. */
  const LADDER_HABIT = { lane: 'ahead12', souls: 'ahead12', deaths: 'early0', jungle: null, dmg: null, obj: null, kills: null, assists: null, acc: null, wr: null };
  function nextRankPlan(lad) {
    const gaps = lad.rows.filter(r => r.key !== 'wr' && r.you != null && r.next && r.next.v != null && r.next.status === 'behind')
      .sort((a, b) => Math.abs(b.next.rel) - Math.abs(a.next.rel))
      .map(r => ({ key: r.key, label: r.label, you: r.you, target: r.next.v, gap: r.next.v - r.you, rel: r.next.rel, fmt: r.fmt, higher: r.higher, habit: LADDER_HABIT[r.key] || null }));
    const strengths = lad.rows.filter(r => r.key !== 'wr' && r.next && r.next.status === 'ahead').map(r => ({ label: r.label, you: r.you, target: r.next.v, fmt: r.fmt }));
    const onPar = lad.rows.filter(r => r.key !== 'wr' && r.next && r.next.status === 'par').map(r => r.label);
    return { gaps, strengths, onPar };
  }

  /* Does the win model hold up on YOUR games? For each of your games with detail that lasted to
     `t`, the model's win chance for your team at t vs whether you won. */
  function calibration(entries, W, t) {
    t = t || 1200;
    const rows = [];
    for (const e of entries) {
      const D = e.D, me = D && D.players.find(p => p.items);
      if (!me || !e.m || D.dur < t) continue;
      rows.push({ p: wpAt(W, t, gapsAt(D, me.team, t)), won: e.m.won });
    }
    const bin = (lo, hi) => { const r = rows.filter(x => x.p >= lo && x.p < hi); return { lo, hi, n: r.length, wins: r.filter(x => x.won).length, avgP: r.length ? mean(r.map(x => x.p)) : null }; };
    const fav = rows.filter(x => x.p >= 0.5), dog = rows.filter(x => x.p < 0.5);
    return { t, n: rows.length, bins: [bin(0, 0.35), bin(0.35, 0.65), bin(0.65, 1.01)],
      right: fav.filter(x => x.won).length + dog.filter(x => !x.won).length, avgP: rows.length ? mean(rows.map(x => x.p)) : null,
      winRate: rows.length ? rows.filter(x => x.won).length / rows.length : null };
  }

  /* The latest finished play session: from the helper's sessions when it runs, else a 2h gap
     between matches. -> { start, end, games } or null if it ended more than `maxAgeH` ago. */
  function lastSession(matches, helper, now, maxAgeH) {
    const maxAge = (maxAgeH || 18) * 3600;
    let start, end;
    const done = helper && helper.sessions ? helper.sessions.filter(x => x.end != null) : [];
    if (done.length && !(helper.playing)) {
      const s0 = done[done.length - 1];
      start = s0.start; end = s0.end;
    } else {
      const ss = sessionOf(matches);
      if (!ss.length) return null;
      start = ss[0].t; const last = ss[ss.length - 1]; end = last.t + last.dur;
      if (helper && helper.playing) return null;
    }
    if (now - end > maxAge) return null;
    const games = matches.filter(m => m.t >= start - 120 && m.t <= end + 60);
    return games.length ? { start, end, games } : null;
  }

  /* Friends = people you've played 10+ games with (random teammates almost never repeat that
     often). mates: /v1/players/{id}/mate-stats rows. history: your normalized matches. */
  const FRIEND_MIN = 10;
  function friendStats(mates, history) {
    const mine = new Map(history.map(m => [m.id, m]));
    return (mates || []).filter(x => x.matches_played >= FRIEND_MIN).map(x => {
      const ids = new Set(x.matches || []);
      const together = history.filter(m => ids.has(m.id));
      const apart = history.filter(m => !ids.has(m.id));
      const wr = ms => ms.length ? ms.filter(m => m.won).length / ms.length : null;
      const last = together.length ? together[together.length - 1].t : null;
      return { acct: x.mate_id, games: x.matches_played, wins: x.wins, wr: x.wins / x.matches_played,
        seen: together.length, wrTogether: wr(together), wrApart: wr(apart), last, ids: [...ids].filter(id => mine.has(id)) };
    }).sort((a, b) => (b.last || 0) - (a.last || 0) || b.games - a.games);
  }

  /* A match detail seen from another player's seat (so the habit tests run for a friend). */
  function asPlayer(D, acct) {
    if (!D || !D.players.some(p => p.acct === acct)) return null;
    return Object.assign({}, D, { players: D.players.map(p => Object.assign({}, p, { items: p.acct === acct ? (p.items || []) : null })) });
  }

  /* You vs a friend in your shared games that have detail: each one's habit passes, early deaths,
     and who died first in your losses. */
  function duo(entries, myAcct, friendAcct, habitId, items) {
    const h = habitById(habitId || 'early0');
    const rows = entries.filter(e => e.D && e.D.players.some(p => p.acct === friendAcct));
    const pass = acct => rows.map(e => { const D = asPlayer(e.D, acct); return D ? h.test(e.m, e.L, D, items) : null; }).filter(x => x != null);
    const early = acct => mean(rows.map(e => { const p = e.D.players.find(x => x.acct === acct); return p ? (p.deaths || []).filter(d => d[0] < 600).length : 0; }));
    let firstMe = 0, firstThem = 0;
    for (const e of rows.filter(r => !r.m.won)) {
      const a = e.D.players.find(x => x.acct === myAcct), b = e.D.players.find(x => x.acct === friendAcct);
      const fa = a && a.deaths && a.deaths.length ? a.deaths[0][0] : Infinity, fb = b && b.deaths && b.deaths.length ? b.deaths[0][0] : Infinity;
      if (fa < fb) firstMe++; else if (fb < fa) firstThem++;
    }
    const pm = pass(myAcct), pf = pass(friendAcct);
    return { n: rows.length, habit: h.id, habitLabel: h.label, mePass: pm.filter(Boolean).length, meN: pm.length, themPass: pf.filter(Boolean).length, themN: pf.length,
      meEarly: rows.length ? early(myAcct) : null, themEarly: rows.length ? early(friendAcct) : null, firstMe, firstThem,
      wins: rows.filter(r => r.m.won).length };
  }

  // ---------------------------------------------------------------- squads
  /* Squads = you plus the friends on your team in a game. Everything here runs on one small row
     per game (~300 bytes) instead of full match detail (~6KB), so 90 days of shared games fit in
     localStorage. Only habits measured BEFORE the game is decided are used: tested on 266 games
     (2026-10-26), caught-out deaths over the whole game split wins 55/36 but before 15:00 they
     didn't (48/52), because losing teams get picked off late. Shared "squad rules" were dropped
     too: a friend's early deaths and caught-outs barely moved your result; yours did.
     row: { v, id, t, won, team: [[acct, hero, earlyDeaths, ahead12 (1/0/null), caught15 (1/0),
     winChanceLostToDeaths (0–1, null without the model), worstDeath: [cost, t, killerHero] | null], ...] } */
  const SQUAD_V = 1;
  const SQUAD_DAYS = 90;
  const CAUGHT_BEFORE_S = 900;
  function squadRow(D, m, W) {
    const me = D && D.players.find(p => p.items);
    if (!me) return null;
    const ahead = habitById('ahead12');
    const team = D.players.filter(p => p.team === me.team && p.acct).map(p => {
      const seat = asPlayer(D, p.acct);
      const a = seat ? ahead.test(m, null, seat, null) : null;
      const costs = W && W.death && seat ? deathCosts(seat, W) : null;
      const worst = costs && costs.length ? costs.reduce((b, x) => x.total > b.total ? x : b) : null;
      return [p.acct, p.hero, (p.deaths || []).filter(d => d[0] < 600).length, a == null ? null : a ? 1 : 0,
        (p.deaths || []).some(d => d[0] < CAUGHT_BEFORE_S && d[4] > 0 && d[4] <= FAST_DEATH_S) ? 1 : 0,
        costs ? Math.round(costs.reduce((s, x) => s + x.total, 0) * 1000) / 1000 : null,
        worst ? [Math.round(worst.total * 1000) / 1000, worst.t, worst.killerHero] : null];
    });
    return { v: SQUAD_V, id: m.id, t: m.t, won: m.won, team };
  }
  const seatOf = (row, acct) => row.team.find(s => s[0] === acct) || null;

  /* Your games by stack size: solo, duo, 3+ (friends on your team, from mate-stats ids). */
  function squadRecord(history, friends, since) {
    const byGame = new Map();
    for (const f of friends) for (const id of f.ids) (byGame.get(id) || byGame.set(id, []).get(id)).push(f.acct);
    const out = { solo: { n: 0, wins: 0 }, duo: { n: 0, wins: 0 }, squad: { n: 0, wins: 0 }, partners: {} };
    for (const m of history) {
      if (m.t < since) continue;
      const mates = byGame.get(m.id) || [];
      const b = out[mates.length === 0 ? 'solo' : mates.length === 1 ? 'duo' : 'squad'];
      b.n++; if (m.won) b.wins++;
      for (const a of mates) { const p = out.partners[a] || (out.partners[a] = { n: 0, wins: 0 }); p.n++; if (m.won) p.wins++; }
    }
    for (const k of ['solo', 'duo', 'squad']) out[k].wr = out[k].n ? out[k].wins / out[k].n : null;
    return out;
  }

  /* Win chance lost to deaths per game, for `acct` over rows where they played. */
  const costOf = (rows, acct) => {
    const xs = rows.map(r => seatOf(r, acct)).filter(s => s && s[5] != null).map(s => s[5]);
    return xs.length ? { mean: mean(xs), n: xs.length } : null;
  };
  /* "Better / worse / too close to call", you vs one friend, on win chance lost to deaths in your
     shared games. Committed only when the gap is BOARD_GAP+ and points the same way in both
     halves of the period (on 90 days of real data the order flipped between halves for 2 of 4
     regular friends). */
  const BOARD_MIN = 10, BOARD_GAP = 0.02;
  function versus(rows, me, friend) {
    const shared = rows.filter(r => seatOf(r, me) && seatOf(r, friend)).sort((a, b) => a.t - b.t);
    const all = [costOf(shared, me), costOf(shared, friend)];
    if (!all[0] || !all[1] || shared.length < BOARD_MIN) return { n: shared.length, me: all[0] && all[0].mean, them: all[1] && all[1].mean, call: 'few' };
    const half = Math.floor(shared.length / 2);
    const gap = rs => { const a = costOf(rs, me), b = costOf(rs, friend); return a && b ? b.mean - a.mean : 0; };
    const g = all[1].mean - all[0].mean, g1 = gap(shared.slice(0, half)), g2 = gap(shared.slice(half));
    const call = Math.abs(g) >= BOARD_GAP && Math.sign(g1) === Math.sign(g) && Math.sign(g2) === Math.sign(g) ? (g > 0 ? 'you' : 'them') : 'close';
    return { n: shared.length, me: all[0].mean, them: all[1].mean, gap: g, halves: [g1, g2], call };
  }
  /* Everyone ranked on win chance lost to deaths per game in games with you (you: all rows). */
  function friendBoard(rows, me, friends) {
    const people = friends.map(f => {
      const vs = versus(rows, me, f.acct);
      return { acct: f.acct, cost: vs.them, n: vs.n, call: vs.call, vs };
    }).filter(p => p.n >= BOARD_MIN && p.cost != null);
    const mine = costOf(rows, me);
    if (mine) people.push({ acct: me, cost: mine.mean, n: mine.n, call: 'self', you: true });
    return people.sort((a, b) => a.cost - b.cost);
  }

  /* You vs one friend on the early-game habits + cost, and a catch-up plan for whoever trails.
     metrics: { id, label, me, them, better: 'me'|'them'|null } (rates 0–1; cost: lower is better).
     split: in your shared games, your team's win rate when the trailing player passed vs missed. */
  const SCORE_METRICS = [
    { id: 'early0', label: 'No deaths before 10:00', get: s => s[2] === 0 ? 1 : 0, how: 'Play the first 10 minutes for zero deaths: back off when your lane opponent has the souls lead or a teammate is missing, and don’t chase past your guardian.' },
    { id: 'ahead12', label: 'Ahead of your lane at 12:00', get: s => s[3], how: 'Last-hit and deny every wave you can, take the urn and jungle camps between waves, and don’t trade health for kills that aren’t there.' },
    { id: 'caught15', label: 'Not caught out before 15:00', get: s => s[4] ? 0 : 1, how: 'Before 15:00 don’t walk alone into fog on the enemy half; move with a teammate or stay where your lane can see you.' },
  ];
  const PLAN_GAP = 0.1;
  function scorecard(rows, me, friend) {
    const shared = rows.filter(r => seatOf(r, me) && seatOf(r, friend));
    const rate = (acct, get) => { const xs = shared.map(r => get(seatOf(r, acct))).filter(x => x != null); return xs.length ? mean(xs) : null; };
    const metrics = SCORE_METRICS.map(x => {
      const a = rate(me, x.get), b = rate(friend, x.get);
      return { id: x.id, label: x.label, me: a, them: b, better: a == null || b == null || Math.abs(a - b) < 0.05 ? null : a > b ? 'me' : 'them' };
    });
    const vs = versus(rows, me, friend);
    metrics.push({ id: 'cost', label: 'Win chance lost to deaths per game', me: vs.me, them: vs.them, lowerBetter: true,
      better: vs.call === 'you' ? 'me' : vs.call === 'them' ? 'them' : null });
    const behindMetrics = who => metrics.filter(x => x.better && x.better !== who).length;
    const trailing = vs.call === 'you' ? 'them' : vs.call === 'them' ? 'me' : behindMetrics('me') > behindMetrics('them') ? 'me' : behindMetrics('them') > behindMetrics('me') ? 'them' : null;
    const plan = [];
    if (trailing) {
      const acct = trailing === 'me' ? me : friend;
      for (const x of SCORE_METRICS) {
        const mm = metrics.find(y => y.id === x.id);
        const mine = trailing === 'me' ? mm.me : mm.them, other = trailing === 'me' ? mm.them : mm.me;
        if (mine == null || other == null || other - mine < PLAN_GAP) continue;
        const pass = shared.filter(r => x.get(seatOf(r, acct)) === 1), fail = shared.filter(r => x.get(seatOf(r, acct)) === 0);
        plan.push({ id: x.id, label: x.label, how: x.how, from: mine, to: other, gap: other - mine,
          wrPass: pass.length ? pass.filter(r => r.won).length / pass.length : null, wrFail: fail.length ? fail.filter(r => r.won).length / fail.length : null, nPass: pass.length, nFail: fail.length });
      }
      plan.sort((a, b) => b.gap - a.gap);
    }
    return { n: shared.length, wins: shared.filter(r => r.won).length, metrics, vs, trailing, plan: plan.slice(0, 2) };
  }

  /* The week together, for pasting into the group chat. Only games you played in (that's what
     Climb has). worstDeath is a TYPICAL cost from the model, not an exact one. */
  const WEEK_S = 7 * 86400;
  function weeklyReport(rows, me, friends, now) {
    const fs = new Set(friends.map(f => f.acct));
    const inSquad = r => r.team.some(s => fs.has(s[0]));
    const week = rows.filter(r => r.t >= now - WEEK_S && inSquad(r));
    const before = rows.filter(r => r.t < now - WEEK_S && r.t >= now - 5 * WEEK_S && inSquad(r));
    if (!week.length) return null;
    const who = [me, ...fs].filter(a => week.some(r => seatOf(r, a)));
    const people = who.map(acct => {
      const c = costOf(week, acct), p = costOf(before, acct);
      return { acct, games: week.filter(r => seatOf(r, acct)).length, cost: c ? c.mean : null, prev: p && p.n >= 4 ? p.mean : null };
    }).filter(p => p.cost != null && p.games >= 2).sort((a, b) => a.cost - b.cost);
    let worst = null;
    for (const r of week) for (const s of r.team) if ((s[0] === me || fs.has(s[0])) && s[6] && (!worst || s[6][0] > worst.cost))
      worst = { acct: s[0], hero: s[1], cost: s[6][0], t: s[6][1], killerHero: s[6][2], matchId: r.id, won: r.won };
    const improved = people.filter(p => p.prev != null && p.prev - p.cost >= BOARD_GAP).sort((a, b) => (b.prev - b.cost) - (a.prev - a.cost))[0] || null;
    return { games: week.length, wins: week.filter(r => r.won).length, people, best: people[0] || null,
      worst: people.length > 1 ? people[people.length - 1] : null, worstDeath: worst, improved };
  }

  const DUO_SYSTEM = [
    'You are a blunt, specific Deadlock coach for two friends who queue together.',
    'You get their shared games: each player\'s rate on early-game habits, the win chance each loses to deaths per game, who is trailing, and the win rate in their shared games when the trailing player passes each habit vs misses it.',
    'Rules:',
    '- Use ONLY numbers in the brief, and cite them. No invented hero abilities, items or map facts.',
    '- Coach the trailing player toward the leading one. Also give the duo one thing to do together.',
    '- Friendly banter is fine, but every point must be useful. Plain words, no emojis, short.',
  ].join('\n');
  const DUO_SCHEMA = {
    type: 'OBJECT',
    properties: {
      verdict: { type: 'STRING', description: 'One sentence: who is ahead in these games, and by how much.' },
      catch_up: { type: 'ARRAY', minItems: 2, maxItems: 3, items: { type: 'STRING', description: 'One concrete instruction for the trailing player, citing a number.' } },
      together: { type: 'STRING', description: 'One thing to do as a duo next session.' },
    },
    required: ['verdict', 'catch_up', 'together'],
  };
  function duoBrief(sc, names) {
    const pc = v => v == null ? null : Math.round(v * 100) + '%';
    const nm = k => k === 'me' ? names.me : names.them;
    return {
      players: { you: names.me, friend: names.them }, shared_games: sc.n, shared_wins: sc.wins,
      habits: sc.metrics.map(x => ({ habit: x.label, [names.me]: x.lowerBetter ? (x.me == null ? null : (x.me * 100).toFixed(1) + ' pts') : pc(x.me),
        [names.them]: x.lowerBetter ? (x.them == null ? null : (x.them * 100).toFixed(1) + ' pts') : pc(x.them), lower_is_better: !!x.lowerBetter, better: x.better ? nm(x.better) : 'too close to call' })),
      trailing_player: sc.trailing ? nm(sc.trailing) : 'neither clearly',
      biggest_gaps: sc.plan.map(p => ({ habit: p.label, trailing_rate: pc(p.from), leading_rate: pc(p.to), team_win_rate_when_trailing_player_passed: pc(p.wrPass), when_missed: pc(p.wrFail) })),
    };
  }

  // ---------------------------------------------------------------- data freshness

  /* How far behind deadlock-api is for this account. deadlock-api only has a match once it has
     collected it (Valve hands out match keys sparingly), so recent games can be missing for hours.
     With the Climb helper we can tell: play time recorded after the newest match ended is play
     deadlock-api hasn't seen yet. Only finished sessions count. -> { newestT, newestEnd, sinceS, unseenS, sessions } */
  const UNSEEN_GRACE_S = 10 * 60;     // a match can end a few minutes before Deadlock is closed
  function freshness(matches, helper, now) {
    const last = matches.length ? matches.reduce((a, b) => (b.t > a.t ? b : a)) : null;
    const newestEnd = last ? last.t + (last.dur || 0) : null;
    let unseenS = 0, sessions = 0;
    if (helper && helper.sessions && newestEnd != null) {
      for (const x of helper.sessions) {
        if (x.end == null) continue;   // still playing: that game isn't "missing" yet
        const end = x.end;
        const from = Math.max(x.start, newestEnd + UNSEEN_GRACE_S);
        if (end > from) { unseenS += end - from; sessions++; }
      }
    }
    return { newestT: last ? last.t : null, newestEnd, newestId: last ? last.id : null, sinceS: newestEnd != null ? now - newestEnd : null, unseenS, sessions };
  }

  // ---------------------------------------------------------------- win chance (trained model)

  /* W is window.WPMODEL from js/wpmodel.js, written by model/train.py from deadlock-api's data
     lake. win[t] holds logistic weights for the gaps [souls, kills, objectives destroyed,
     mid-bosses claimed] (my team minus enemy, divided by `scale`) at snapshot minute t. Between
     trained minutes the weights are interpolated linearly. A death's cost comes from `death.cost`:
     the median team-souls swing measured around deaths where nobody else in the lobby died, by
     minute and by how rich the victim was. It's what a death like that USUALLY costs, not a
     measurement of that particular death. */
  function wpWeights(W, t) {
    const ts = Object.keys(W.win).map(Number).sort((a, b) => a - b);
    if (t <= ts[0]) return W.win[ts[0]].map(w => w * Math.max(0, t) / ts[0]);   // fades to 50/50 at 0:00
    if (t >= ts[ts.length - 1]) return W.win[ts[ts.length - 1]];
    const hi = ts.findIndex(x => x >= t), a = ts[hi - 1], b = ts[hi];
    const f = (t - a) / (b - a);
    return W.win[a].map((w, i) => w + f * (W.win[b][i] - w));
  }
  function wpAt(W, t, gaps) {
    const w = wpWeights(W, t);
    const z = gaps.reduce((s, g, i) => s + (g / W.scale[i]) * w[i], 0);
    return 1 / (1 + Math.exp(-z));
  }

  /* Team gaps at time t from a compact match detail, from `team`'s side. */
  function gapsAt(D, team, t) {
    const sum = (tm, col) => D.players.filter(p => p.team === tm).reduce((s, p) => { const x = snapAtT(p, t); return s + (x ? x[col] : 0); }, 0);
    const souls = sum(team, 1) - sum(1 - team, 1);
    const kills = sum(team, 2) - sum(1 - team, 2);
    const objs = (D.objs || []).filter(o => o[0] <= t);
    const obj = objs.filter(o => o[1] !== team).length - objs.filter(o => o[1] === team).length;
    const mbs = (D.mbs || []).filter(b => b[0] <= t);
    const mb = mbs.filter(b => b[1] === team).length - mbs.filter(b => b[1] !== team).length;
    return [souls, kills, obj, mb];
  }

  /* -> [{ t, p, gaps }] for your team at 0:00, every snapshot, and the end. */
  function winTimeline(D, W, team) {
    const me = D.players.find(p => p.items) || D.players[0];
    if (team == null) team = me.team;
    const times = [0, ...me.snaps.map(s => s[0]).filter(t => t > 0 && t < D.dur)];
    const pts = times.map(t => { const g = gapsAt(D, team, t); return { t, p: t === 0 ? 0.5 : wpAt(W, t, g), gaps: g }; });
    if (D.win != null) pts.push({ t: D.dur, p: D.win === team ? 1 : 0, gaps: gapsAt(D, team, D.dur), end: true });
    return pts;
  }

  const bucketOf = (buckets, x) => { const i = buckets.findIndex(([lo, hi]) => x >= lo && (hi == null || x < hi)); return i < 0 ? buckets.length - 1 : i; };

  /* Each of your deaths with what a death like it usually costs: souls (the measured swing) and
     win-chance points at that moment, plus the extra objective risk in the next 90s. */
  function deathCosts(D, W) {
    const me = D.players.find(p => p.items);
    if (!me || !W.death) return [];
    const bySlot = new Map(D.players.map(p => [p.slot, p]));
    return (me.deaths || []).map(([t, slot, x, y, ttk]) => {
      const before = Math.max(0, ...me.snaps.map(s => s[0]).filter(s => s <= t));
      const lobbyAvg = mean(D.players.map(p => { const s = snapAtT(p, before); return s ? s[1] : 0; }));
      const mine = snapAtT(me, before);
      const share = lobbyAvg > 0 && mine ? mine[1] / lobbyAvg : 1;
      const mb = bucketOf(W.death.minute_buckets, t), sb = bucketOf(W.death.share_buckets, share);
      const souls = W.death.cost[mb][sb];
      const g = gapsAt(D, me.team, t);
      const p0 = wpAt(W, t, g);
      const pts = p0 - wpAt(W, t, [g[0] - souls, g[1] - 1, g[2], g[3]]);
      const objLift = W.death.objective_lift_90s[mb] || 0;
      const objPts = Math.max(0, objLift) * (p0 - wpAt(W, t, [g[0], g[1], g[2] - 1, g[3]]));
      const k = bySlot.get(slot);
      return { t, killerHero: k ? k.hero : null, x, y, ttk, share, souls, pts, objPts, objLift, total: pts + objPts, p: p0 };
    });
  }

  /* The windows where your team's win chance moved most, with what happened in each. */
  function turningPoints(D, W, n) {
    const me = D.players.find(p => p.items);
    const tl = winTimeline(D, W, me.team).filter(x => !x.end);
    const deaths = D.players.flatMap(p => (p.deaths || []).map(d => ({ t: d[0], team: p.team, slot: p.slot, hero: p.hero, me: p === me, killer: d[1] })));
    const out = [];
    for (let i = 1; i < tl.length; i++) {
      const a = tl[i - 1], b = tl[i];
      const inW = x => x > a.t && x <= b.t;
      const ds = deaths.filter(d => inW(d.t));
      out.push({
        from: a.t, to: b.t, p0: a.p, p1: b.p, delta: b.p - a.p,
        soulsSwing: (b.gaps[0] - a.gaps[0]),
        myDeaths: ds.filter(d => d.me).map(d => d.t),
        teamDeaths: ds.filter(d => d.team === me.team).length, enemyDeaths: ds.filter(d => d.team !== me.team).length,
        objLost: (D.objs || []).filter(o => inW(o[0]) && o[1] === me.team).length,
        objTaken: (D.objs || []).filter(o => inW(o[0]) && o[1] !== me.team).length,
        midboss: (D.mbs || []).filter(m => inW(m[0])).map(m => m[1] === me.team ? 'yours' : 'theirs'),
      });
    }
    return out.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta)).slice(0, n || 3).sort((x, y) => x.from - y.from);
  }

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

  // ---------------------------------------------------------------- focus loop (one habit at a time)

  /* Why habits and not averaged goals: on the user's 60 games (2026-10-22) per-game counts were
     far too noisy. A 1-death drop in late deaths needs ~60 games to show, while a pass/fail habit
     gives feedback every game and a pass RATE settles in ~15. Each habit is checkable from one
     game's data. `outcome: true` marks habits that partly follow the result (losing causes late
     deaths), which are offered last. A habit is only offered when passing it actually split YOUR
     wins from losses (FOCUS_MIN_LIFT), so advice like "tier 3 by 13:00", which made no
     difference (52%/52%), never becomes a goal. */
  const FOCUS_MIN_GAMES = 15;     // games before the pass rate gets a verdict
  const FOCUS_GRAD = [7, 10];     // graduate at 7 passes in your last 10
  const FOCUS_MIN_LIFT = 0.10;    // win-rate gap (pass vs fail) a habit needs to be offered
  const FOCUS_MIN_SIDE = 5;       // games on each side of that split

  const deathsIn = (D, a, b) => { const me = D && D.players.find(p => p.items); return me ? (me.deaths || []).filter(d => d[0] >= a && d[0] < b) : null; };
  const meOf = D => D && D.players.find(p => p.items);
  const snapAtT = (p, t) => { let b = null; for (const s of p.snaps) if (s[0] <= t) b = s; return b; };
  const firstTierAt = (D, items, tier) => {
    const me = meOf(D);
    if (!me || !items) return null;
    const x = (me.items || []).filter(([, id]) => items[id] && items[id][2] >= tier).sort((a, b) => a[0] - b[0])[0];
    return x ? x[0] : Infinity;
  };
  /* test(m, L, D, items) -> true / false / null (can't tell from this game's data). */
  const HABITS = [
    { id: 'early0', label: 'No deaths before 10:00', short: 'No early deaths', test: (m, L, D) => { const d = deathsIn(D, 0, 600); return d ? d.length === 0 : null; } },
    { id: 'early1', label: 'At most 1 death before 10:00', short: '≤1 early death', test: (m, L, D) => { const d = deathsIn(D, 0, 600); return d ? d.length <= 1 : null; } },
    { id: 'nocatch', label: `Never caught out (no death within ${FAST_DEATH_S}s of taking damage)`, short: 'Never caught out', test: (m, L, D) => { const me = meOf(D); return me ? !(me.deaths || []).some(d => d[4] > 0 && d[4] <= FAST_DEATH_S) : null; } },
    { id: 'ahead12', label: 'Ahead of your lane opponents in souls at 12:00', short: 'Ahead at 12:00', test: (m, L, D) => {
      const me = meOf(D); if (!me || D.dur < 720) return null;
      const opps = D.players.filter(p => p.team !== me.team && p.lane === me.lane).map(p => snapAtT(p, 720)).filter(Boolean);
      const mine = snapAtT(me, 720); return mine && opps.length ? mine[1] > mean(opps.map(s => s[1])) : null; } },
    { id: 'cs12', label: '25+ last hits by 12:00', short: '25 CS by 12:00', test: (m, L, D) => { const me = meOf(D); const s = me && D.dur >= 720 ? snapAtT(me, 720) : null; return s ? s[8] >= 25 : null; } },
    { id: 'tier3', label: 'First tier-3 item before 13:00', short: 'Tier 3 by 13:00', test: (m, L, D, items) => { const t = firstTierAt(D, items, 3); return t == null ? null : t < 780; } },
    { id: 'tier4', label: 'First tier-4 item before 24:00', short: 'Tier 4 by 24:00', test: (m, L, D, items) => { const t = firstTierAt(D, items, 4); return t == null || (t === Infinity && D.dur < 1440) ? null : t < 1440; } },
    { id: 'rate', label: 'Under 1.2 deaths per 10 minutes', short: '<1.2 deaths / 10 min', outcome: true, test: m => m.dur ? (m.d / (m.dur / 60)) * 10 < 1.2 : null },
    { id: 'late2', label: 'At most 2 deaths after 20:00', short: '≤2 late deaths', outcome: true, test: (m, L, D) => { if (!D || D.dur < 1500) return null; const d = deathsIn(D, 1200, Infinity); return d ? d.length <= 2 : null; } },
  ];
  const habitById = id => HABITS.find(h => h.id === id) || null;

  /* entries: [{ m, L, D }] -> [{ m, pass }] where pass is true / false / null. */
  function habitResults(habit, entries, items) {
    return entries.map(e => ({ m: e.m, pass: e.m ? habit.test(e.m, e.L, e.D, items) : null }));
  }

  /* Every habit over a sample: how often you pass, and your win rate when you do vs don't. */
  function habitCatalog(entries, items) {
    return HABITS.map(h => {
      const r = habitResults(h, entries, items).filter(x => x.pass != null);
      const yes = r.filter(x => x.pass), no = r.filter(x => !x.pass);
      const wr = xs => xs.length ? xs.filter(x => x.m.won).length / xs.length : null;
      const lift = yes.length && no.length ? wr(yes) - wr(no) : null;
      const eligible = yes.length >= FOCUS_MIN_SIDE && no.length >= FOCUS_MIN_SIDE && lift != null && lift >= FOCUS_MIN_LIFT;
      return { id: h.id, label: h.label, short: h.short, outcome: !!h.outcome, n: r.length, passRate: r.length ? yes.length / r.length : null,
        wrPass: wr(yes), wrFail: wr(no), nPass: yes.length, nFail: no.length, lift, eligible };
    }).sort((a, b) => (b.eligible - a.eligible) || (a.outcome - b.outcome) || ((b.lift || -1) - (a.lift || -1)));
  }

  /* The habit Climb itself would pick: the biggest win-rate split among eligible habits that you
     don't already pass most of the time, preferring ones that don't follow the result. */
  function suggestHabit(catalog) {
    const ok = catalog.filter(c => c.eligible && c.passRate < FOCUS_GRAD[0] / FOCUS_GRAD[1]);
    return (ok.find(c => !c.outcome) || ok[0] || null);
  }

  /* goal: { habit, start (unix), baseline: { rate, n } }; entries: every game since start, oldest first.
     -> { n, passes, rate, recent: [true/false…] (last 10, oldest first), verdict, graduated } */
  function focusProgress(goal, entries, items) {
    const h = habitById(goal.habit);
    if (!h) return null;
    const r = habitResults(h, entries.filter(e => e.m && e.m.t >= goal.start), items).filter(x => x.pass != null);
    const passes = r.filter(x => x.pass).length, n = r.length;
    const rate = n ? passes / n : null;
    const recent = r.slice(-FOCUS_GRAD[1]).map(x => x.pass);
    const p0 = goal.baseline && goal.baseline.rate != null ? goal.baseline.rate : null;
    let verdict = 'early';
    if (n >= FOCUS_MIN_GAMES && p0 != null) {
      const se = Math.sqrt(Math.max(p0 * (1 - p0), 0.04) / n);
      verdict = rate - p0 > 2 * se ? 'improved' : p0 - rate > 2 * se ? 'worse' : 'same';
    }
    const graduated = recent.length >= FOCUS_GRAD[1] && recent.filter(Boolean).length >= FOCUS_GRAD[0];
    return { n, passes, rate, recent, verdict, graduated, results: r, baseline: p0, needed: Math.max(0, FOCUS_MIN_GAMES - n) };
  }

  const FOCUS_SYSTEM = [
    'You are a Deadlock coach choosing ONE habit for the player to work on next.',
    'You get the player\'s recent stats and a catalog of habits Climb can check in every game, each with how often the player passes it and their win rate when they pass vs fail.',
    'Rules:',
    '- Choose only an id from the catalog with eligible=true. Prefer habits that do not follow the result (outcome=false) and that the player passes less than 70% of the time.',
    '- Pick the habit most likely to win them games, using the win-rate split and the rest of the stats.',
    '- "why" cites the numbers. "how" gives 2–3 concrete things to do in-game to pass it. No invented hero or item facts.',
  ].join('\n');
  const focusSchema = ids => ({
    type: 'OBJECT',
    properties: {
      habit_id: { type: 'STRING', enum: ids },
      why: { type: 'STRING', description: 'One or two sentences with the numbers.' },
      how: { type: 'ARRAY', minItems: 2, maxItems: 3, items: { type: 'STRING' } },
    },
    required: ['habit_id', 'why', 'how'],
  });

  // ---------------------------------------------------------------- hero pool + readiness
  /* Hero pool advisor: per hero, ranked games since the last big patch (widened like the Heroes
     tab's benchWindow), record and rank points per game. The call is sample-aware: points per game
     swing a lot (SD in the hundreds), so a hero is only "Keep" or "Bench" when the mean is clear of
     zero by its standard error AND has the same sign in both halves of its games. Under
     POOL_MIN games it makes no call. ranked: your ranked matches (normalized), ascending. */
  const POOL_MIN = 10, POOL_KEEP_Z = 1.28, POOL_BENCH_Z = -1.64, POOL_NOT_Z = -0.8;
  const POOL_LABEL = { keep: 'Keep', fine: 'Fine', notcarrying: 'Not carrying', bench: 'Bench', toofew: 'Too few' };
  function heroPool(ranked, patchT, now) {
    const wideFrom = Math.min(patchT == null ? Infinity : patchT, benchWideFrom(now));
    const heroes = [...new Set(ranked.filter(m => m.t >= wideFrom).map(m => m.hero))];
    const rows = heroes.map(hero => {
      const w = benchWindow(ranked, hero, patchT, now);
      const from = w ? w.from : wideFrom;
      const gs = ranked.filter(m => m.hero === hero && m.t >= from);
      const wins = gs.filter(m => m.won).length;
      const ds = gs.filter(m => m.delta != null).map(m => m.delta);
      const ppg = ds.length ? mean(ds) : null;
      const sd = ds.length > 1 ? Math.sqrt(ds.reduce((s, x) => s + (x - ppg) * (x - ppg), 0) / (ds.length - 1)) : 0;
      const z = ds.length > 1 && sd > 0 ? ppg / (sd / Math.sqrt(ds.length)) : null;
      const half = Math.floor(ds.length / 2);
      const h1 = half ? mean(ds.slice(0, half)) : null, h2 = ds.length - half ? mean(ds.slice(half)) : null;
      let call = 'fine';
      if (gs.length < POOL_MIN || z == null) call = 'toofew';
      else if (z >= POOL_KEEP_Z && h1 > 0 && h2 > 0) call = 'keep';
      else if (z <= POOL_BENCH_Z && h1 < 0 && h2 < 0) call = 'bench';
      else if (z <= POOL_NOT_Z) call = 'notcarrying';
      return { hero, from, widened: from < patchT || patchT == null, n: gs.length, wins, losses: gs.length - wins, ds: ds.length, ppg, net: ds.reduce((s, x) => s + x, 0), z, halves: [h1, h2], call };
    }).sort((a, b) => b.n - a.n || a.hero - b.hero);
    const best = rows.filter(r => r.call === 'keep').sort((a, b) => b.ppg - a.ppg)[0] || null;
    return { rows, best };
  }

  /* Who to queue with: the friend the leaderboard (friendBoard) calls better than you, cleanest
     first. null when no one is clearly better. */
  function bestFriend(board) {
    return (board || []).filter(p => p.call === 'them').sort((a, b) => a.cost - b.cost)[0] || null;
  }

  /* Queue readiness, 0–100, from things known BEFORE a game: rest (40), recent form (40), focus
     streak (20). A Climb rule of thumb: none of it is claimed to predict wins (tilt, tested
     2026-10-26 on 842 games, showed nothing). games: all matches ascending; form: { meanScore, n } over the
     last 20 or null; focus: { habit, recent: [true/false…] } or null; tzMin: local UTC offset. */
  const READY_GOOD = 65, READY_OK = 45;
  function readiness(games, now, form, focus, tzMin) {
    const tz = (tzMin || 0) * 60;
    const parts = [];
    const day = games.filter(m => m.t + m.dur > now - 86400);
    const late = games.some(m => { const e = m.t + m.dur; return e > now - 18 * 3600 && e <= now && (((e + tz) % 86400) + 86400) % 86400 < 5 * 3600; });
    const inGame = day.reduce((s, m) => s + m.dur, 0);
    const heavy = inGame > 4 * 3600;
    const rest = 40 - (late ? 15 : 0) - (heavy ? 10 : 0);
    parts.push({ key: 'rest', label: 'Rest', pts: rest, max: 40, tone: rest >= 40 ? 1 : rest >= 30 ? 0 : -1,
      note: late || heavy ? [late ? 'a game ended after midnight in the last 18 hours' : null, heavy ? Math.round(inGame / 360) / 10 + ' hours in game in the last day' : null].filter(Boolean).join('; ')
        : 'no late night and under 4 hours in game in the last day' });
    if (form && form.n >= 5 && form.meanScore != null) {
      const f = Math.round(20 + Math.max(-1, Math.min(1, form.meanScore / 0.5)) * 20);
      parts.push({ key: 'form', label: 'Form', pts: f, max: 40, tone: f >= 28 ? 1 : f >= 14 ? 0 : -1,
        note: (f >= 28 ? 'above' : f >= 14 ? 'around' : 'below') + ' your usual over your last ' + form.n + ' games' });
    } else parts.push({ key: 'form', label: 'Form', pts: 20, max: 40, tone: 0, note: 'not enough scored games yet, counted as neutral' });
    const r = focus ? focus.recent.slice(-5) : [];
    if (r.length >= 3) {
      const p = r.filter(Boolean).length, f = Math.round(20 * p / r.length);
      parts.push({ key: 'focus', label: 'Focus habit', pts: f, max: 20, tone: p / r.length >= 0.6 ? 1 : p / r.length >= 0.3 ? 0 : -1, note: p + ' of your last ' + r.length + ' games passed' });
    } else parts.push({ key: 'focus', label: 'Focus habit', pts: 10, max: 20, tone: 0, note: focus ? 'fewer than 3 games checked, counted as neutral' : 'no habit picked, counted as neutral' });
    const score = parts.reduce((s, x) => s + x.pts, 0);
    const tone = score >= READY_GOOD ? 'good' : score >= READY_OK ? 'warn' : 'bad';
    return { score, tone, word: tone === 'good' ? 'Good to queue' : tone === 'warn' ? 'Okay to queue' : 'Take it easy', parts };
  }

  const Engine = {
    POOL_MIN, POOL_LABEL, heroPool, bestFriend, readiness,
    freshness,
    SQUAD_V, SQUAD_DAYS, BOARD_MIN, squadRow, squadRecord, versus, friendBoard, scorecard, weeklyReport, DUO_SYSTEM, DUO_SCHEMA, duoBrief,
    teamShare, earlyRates, nextRankPlan, calibration, lastSession, FRIEND_MIN, friendStats, asPlayer, duo,
    DETAIL_V, wpAt, wpWeights, gapsAt, winTimeline, deathCosts, turningPoints,
    HABITS, FOCUS_MIN_GAMES, FOCUS_GRAD, FOCUS_MIN_LIFT, habitById, habitResults, habitCatalog, suggestHabit, focusProgress, FOCUS_SYSTEM, focusSchema,
    aggregateGames, analysisBrief, ANALYSIS_SYSTEM, ANALYSIS_SCHEMA, FAST_DEATH_S,
    compactItems, compactMatchDetail, mapZone, debriefBrief, DEBRIEF_SYSTEM, DEBRIEF_SCHEMA,
    LOBBY_V, ROLE_LABEL, ROLE_GOOD, ROLE_NOTE, TAG2_LABEL, TAG2_GOOD, LADDER_TIERS, LADDER_METRICS,
    parseSteamInput, lobbyImpact, gameRole, roleSummary, compactHeroStats, rankLadder,
    BENCH_TIMES, BENCH_STATS, BENCH_MIN_PATCH, BENCH_WIDE_DAYS,
    lastBigPatch, benchWindow, benchHeroes, benchBrackets, compactCurve, benchCompare,
    ACCOUNT_ID, MIN_HERO_GAMES, COMPARE_N, QUADS, QUAD_LABEL, TAG_LABEL, TIER_NAMES,
    ladder, normalizeMatch, normalizeHistory, matchFromMeta, mergeAdded, compactLobby, lobbyStats, perfScores, classify,
    seasonOf, sessionOf, windowsFor, summarize, rankUnit, verdict, rankSeries, heroBreakdown, badgeName,
    heroStatShift, briefing,
  };
  root.Engine = Engine;
  if (typeof module === 'object' && module.exports) module.exports = Engine;
})(typeof window !== 'undefined' ? window : globalThis);
