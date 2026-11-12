/* review.js — match review from the replay: the queries, packing their results into one compact
   match (`pack`), and finding the moments worth a question (`findMoments`, `buildQuestion`).
   Pure functions, no DOM and no network (api.js runs the queries), so `node js/tests.js` covers it.

   Where the numbers come from: deadlock-api runs SQL over a match's demo file (POST
   /v1/matches/demo/query). Units are game units (a hero is ~50 wide; the map is ±10752 square).
   Positions are cell * 512 + vec - 32768; 64 ticks a second; the game clock is
   tick / 64 - m_flGameStartTime. Hero pawns map to players through the controller's
   m_hHeroPawn & 0x3FFF; the fog-of-war list stores hero ids as pawn id x 2. */
(function (root) {
  'use strict';

  // ------------------------------------------------------------------ the replay queries
  const OBJ = (kind, table) => `SELECT '${kind}' AS kind, tick, entity_index, "m_iTeamNum" AS team, "m_lifeState" AS life, ` +
    `"CBodyComponent__m_cellX" AS cx, "CBodyComponent__m_cellY" AS cy, "CBodyComponent__m_vecX" AS vx, "CBodyComponent__m_vecY" AS vy FROM ${table}`;
  const QUERIES = {
    // each player: hero, team, hero pawn handle, and account id (worked out in SQL: Steam's 64-bit ids lose precision in JS)
    map: `SELECT entity_index, max("m_PlayerDataGlobal__m_nHeroID") AS hero, max("m_iTeamNum") AS team, max("m_hHeroPawn") AS hp,
      CAST(max("m_steamID") - 76561197960265728 AS BIGINT) AS account
      FROM CCitadelPlayerController WHERE "m_PlayerDataGlobal__m_nHeroID" > 0 GROUP BY entity_index`,
    rules: `SELECT tick, "m_pGameRules__m_flGameStartTime" AS gst, "m_pGameRules__m_iWinningTeam" AS win
      FROM CCitadelGameRulesProxy WHERE delta_type <> 'update' OR tick % 6400 = 0`,
    // every hero twice a second: position, health, alive
    pawns: `SELECT tick, entity_index, "m_iHealth" AS hp, "m_iMaxHealth" AS hpmax, "m_lifeState" AS life,
      "CBodyComponent__m_cellX" AS cx, "CBodyComponent__m_cellY" AS cy, "CBodyComponent__m_vecX" AS vx, "CBodyComponent__m_vecY" AS vy
      FROM CCitadelPlayerPawn WHERE tick % 32 = 0`,
    // souls and max health (with item bonus health) every 10 s
    players: `SELECT tick, entity_index, "m_PlayerDataGlobal__m_nHeroID" AS hero, "m_PlayerDataGlobal__m_iGoldNetWorth" AS nw,
      "m_PlayerDataGlobal__m_iHealthMax" AS hmax FROM CCitadelPlayerController WHERE tick % 640 = 0 OR delta_type <> 'update'`,
    kills: `SELECT tick, entindex_victim AS v, entindex_attacker AS a, killfeed_gold AS gold FROM HeroKilledEvent`,
    // every objective: where it stands, when it spawned and when it fell
    obj: `SELECT kind, entity_index, team, min(tick) AS born, min(CASE WHEN life <> 0 THEN tick END) AS died,
      min(cx) AS cx, min(cy) AS cy, min(vx) AS vx, min(vy) AS vy FROM (
      ${OBJ('guardian', 'CNPC_TrooperBoss')} UNION ALL ${OBJ('walker', 'CNPC_Boss_Tier2')} UNION ALL ${OBJ('basegd', 'CNPC_BarrackBoss')}
      UNION ALL ${OBJ('midboss', 'CNPC_MidBoss')} UNION ALL ${OBJ('patron', 'CNPC_Boss_Tier3')}) GROUP BY kind, entity_index, team`,
    // lane troopers every 2 s
    troop: `SELECT tick, entity_index, "m_iTeamNum" AS team, "m_lifeState" AS life, "CBodyComponent__m_cellX" AS cx,
      "CBodyComponent__m_cellY" AS cy, "CBodyComponent__m_vecX" AS vx, "CBodyComponent__m_vecY" AS vy FROM CNPC_Trooper WHERE tick % 128 = 0`,
    // what each team could see: heroes on its map, four times a second
    fow: `SELECT tick, team, ent, vis FROM (SELECT tick, "m_iTeamNum" AS team, unnest("m_vecFOWEntities__m_nEntIndex") AS ent,
      unnest("m_vecFOWEntities__m_bVisibleOnMap") AS vis FROM CCitadelTeam WHERE tick % 16 = 0 AND "m_iTeamNum" IN (2, 3)) WHERE ent > 1 AND ent < 1000`,
    // objective health every 4 s (guardians, walkers, base guardians, Patrons, Mid-Boss)
    objhp: ['CNPC_TrooperBoss', 'CNPC_Boss_Tier2', 'CNPC_BarrackBoss', 'CNPC_Boss_Tier3', 'CNPC_MidBoss'].map(t =>
      `SELECT tick, entity_index, "m_iHealth" AS hp, "m_iMaxHealth" AS hpmax FROM ${t} WHERE tick % 256 = 0`).join(' UNION ALL '),
    // every objective destroyed, with its class, owner team, killer pawn and place. Classes: 5 guardian, 29 walker,
    // 30 base guardian, 28 shrine, 8 Mid-Boss, 31 Patron dropping (checked on match 135294772)
    events: `SELECT tick, objective_team AS team, entity_killed_class AS cls, entity_killer AS killer, entity_position['x'] AS x,
      entity_position['y'] AS y FROM BossKilledEvent`,
    // the jungle: neutral creeps, gold statues, Sinner's Sacrifice machines and Urn spawns, one row per entity
    world: [['neutral', 'CNPC_TrooperNeutral', true], ['statue', 'CCitadelItemPunchableNeutralGold', false],
      ['sinner', 'CNPC_Neutral_SinnersSacrifice', true], ['urn', 'CCitadelItemPickupIdol', false]].map(([k, t, life]) =>
      `SELECT '${k}' AS kind, entity_index, max("m_iMaxHealth") AS hpmax, min(tick) AS born, ` +
      `${life ? 'min(CASE WHEN "m_lifeState" <> 0 THEN tick END)' : 'max(tick)'} AS died, min("CBodyComponent__m_cellX") AS cx, ` +
      `min("CBodyComponent__m_cellY") AS cy, min("CBodyComponent__m_vecX") AS vx, min("CBodyComponent__m_vecY") AS vy FROM ${t} GROUP BY entity_index`).join(' UNION ALL '),
  };

  // ------------------------------------------------------------------ packing
  const TR = 64;
  const pos = r => ({ x: r.cx * 512 + r.vx - 32768, y: r.cy * 512 + r.vy - 32768 });
  const r0 = Math.round;

  /* Delta rows -> full state per entity, carrying fields forward (the demo only records what changed). */
  function ffill(rows, keys) {
    rows = rows.slice().sort((a, b) => a.tick - b.tick);
    const state = new Map(), out = [];
    for (const r of rows) {
      let s = state.get(r.entity_index);
      if (!s) state.set(r.entity_index, s = {});
      for (const k of keys) if (r[k] != null) s[k] = r[k];
      out.push(Object.assign({}, s, { tick: r.tick, entity_index: r.entity_index }));
    }
    return out;
  }

  /* Q: { map, rules, pawns, players, kills, obj, troop, fow } arrays of rows; account: whose review.
     Returns the packed match: heroes in order (you first, then your team, then theirs), a frame per second
     ([x, y, hp%, alive] per hero), what your team could see per second (bitmask), troopers every 2 s,
     each hero's souls every 10 s, objectives, and kills. */
  function pack(Q, account, matchId) {
    const g = (Q.rules || []).find(r => r.gst != null);
    if (!g) throw new Error('no game start in the replay');
    const clock = tick => tick / TR - g.gst;
    const R = new Map();
    for (const c of Q.map || []) if (c.hero && c.hp != null) R.set(c.hp & 0x3FFF, { hero: c.hero, team: c.team, account: c.account });
    const me = [...R.keys()].find(e => R.get(e).account === account);
    if (me == null) throw new Error('you are not in this replay');
    const myTeam = R.get(me).team;
    const ents = [...R.keys()].sort((a, b) => (R.get(a).team !== myTeam) - (R.get(b).team !== myTeam) || (a !== me) - (b !== me) || a - b);
    const idx = new Map(ents.map((e, i) => [e, i]));
    const heroEnt = new Map(ents.map(e => [R.get(e).hero, e]));

    // max health over time per hero (includes item bonus health), from the controllers
    const hmax = new Map();
    for (const r of ffill(Q.players || [], ['hero', 'hmax'])) {
      const e = heroEnt.get(r.hero);
      if (e != null && r.hmax) { if (!hmax.has(e)) hmax.set(e, []); hmax.get(e).push([clock(r.tick), r.hmax]); }
    }
    const maxHp = (e, s, fallback) => { let best = fallback; for (const [t, v] of hmax.get(e) || []) { if (t > s) break; best = v; } return Math.max(best || 1, 1); };

    // heroes: last state seen in each second, carried forward
    const bySec = new Map();
    for (const r of ffill(Q.pawns || [], ['hp', 'hpmax', 'life', 'cx', 'cy', 'vx', 'vy'])) {
      if (!idx.has(r.entity_index) || r.cx == null || r.vx == null) continue;
      const s = Math.floor(clock(r.tick));
      if (!bySec.has(s)) bySec.set(s, new Map());
      bySec.get(s).set(r.entity_index, r);
    }
    const end = Math.max(...bySec.keys());
    const frames = [], last = new Map();
    for (let s = 0; s <= end; s++) {
      const S = bySec.get(s), row = [];
      for (const e of ents) {
        const r = S && S.get(e);
        if (r) { const p = pos(r); last.set(e, [r0(p.x), r0(p.y), Math.min(100, r0(100 * (r.hp || 0) / maxHp(e, s, r.hpmax))), (r.life || 0) === 0 ? 1 : 0]); }
        row.push(...(last.get(e) || [0, 0, 0, 0]));
      }
      frames.push(row);
    }

    // fog: your team's map, bit i = hero i visible; rows only come when the list changes, so carry it forward
    const seen = new Map(), st = new Map();
    for (const r of (Q.fow || []).filter(r => r.team === myTeam).sort((a, b) => a.tick - b.tick)) {
      const e = r.ent / 2;
      if (idx.has(e)) st.set(idx.get(e), !!r.vis);
      const s = Math.floor(clock(r.tick));
      if (s >= 0) { let m = seen.get(s) || 0; for (const [i, v] of st) if (v) m |= 1 << i; seen.set(s, m); }
    }
    const vis = (Q.fow && Q.fow.length) ? [] : null;
    if (vis) for (let s = 0; s <= end; s++) vis.push(seen.has(s) ? seen.get(s) : (vis.length ? vis[vis.length - 1] : 0));

    // troopers every 2 s (alive only), positions / 10
    const troop = {};
    for (const r of ffill(Q.troop || [], ['team', 'life', 'cx', 'cy', 'vx', 'vy'])) {
      if ((r.life || 0) !== 0 || r.vx == null || r.cx == null) continue;
      const s = Math.floor(clock(r.tick));
      if (s < 0 || s % 2) continue;
      const p = pos(r);
      (troop[s] || (troop[s] = [])).push(r0(p.x / 10), r0(p.y / 10), r.team);
    }

    // each hero's souls every 10 s, in hero order
    const nw = [];
    for (const r of ffill(Q.players || [], ['hero', 'nw'])) { const e = heroEnt.get(r.hero); if (e != null && r.nw != null) nw.push([clock(r.tick), e, r.nw]); }
    nw.sort((a, b) => a[0] - b[0]);
    const souls = [], cur = new Map();
    for (let s = 0, j = 0; s <= end; s += 10) {
      while (j < nw.length && nw[j][0] <= s) { cur.set(nw[j][1], nw[j][2]); j++; }
      souls.push(ents.map(e => cur.get(e) || 0));
    }

    const t1 = v => Math.round(v * 10) / 10;
    // objective health: per entity, the 4-second samples where it was below full, as [t, %]
    const hpOf = new Map();
    for (const r of ffill(Q.objhp || [], ['hp', 'hpmax'])) {
      if (r.hp == null || !r.hpmax || r.hp >= r.hpmax) continue;
      const s = Math.floor(clock(r.tick));
      if (s < 0) continue;
      if (!hpOf.has(r.entity_index)) hpOf.set(r.entity_index, []);
      hpOf.get(r.entity_index).push([s, Math.max(0, r0(100 * r.hp / r.hpmax))]);
    }
    const objs = (Q.obj || []).filter(o => o.cx != null && [2, 3, 4].includes(o.team)).map(o => {
      const p = pos(o);
      return { kind: o.kind, team: o.team, x: r0(p.x), y: r0(p.y), born: t1(clock(o.born)), died: o.died != null ? t1(clock(o.died)) : null, hp: hpOf.get(o.entity_index) || null };
    });
    // objective kills, newest class map. The killer is a pawn handle -> hero index.
    const EVENT_KIND = { 5: 'guardian', 29: 'walker', 30: 'basegd', 28: 'shrine', 8: 'midboss', 31: 'patron' };
    const events = [];
    for (const e of (Q.events || []).slice().sort((a, b) => a.tick - b.tick)) {
      const kind = EVENT_KIND[e.cls];
      if (!kind) continue;
      const by = e.killer != null && idx.has(e.killer & 0x3FFF) ? idx.get(e.killer & 0x3FFF) : -1;
      events.push({ t: t1(clock(e.tick)), kind: kind === 'patron' ? 'drop' : kind, team: e.team, by, x: e.x != null ? r0(e.x) : null, y: e.y != null ? r0(e.y) : null });
    }
    // shrines have no entity table we can read: place them from their kill events, and mirror the base layout for the
    // ones still standing (two per team at fixed spots; the map is point-symmetric around the middle)
    for (const team of [2, 3]) {
      const down = events.filter(e => e.kind === 'shrine' && e.team === team);
      const spots = SHRINES[team].map(([x, y]) => ({ x, y }));
      for (const sp of spots) {
        const e = down.find(d => d.x != null && Math.hypot(d.x - sp.x, d.y - sp.y) < 800);
        objs.push({ kind: 'shrine', team, x: sp.x, y: sp.y, born: 0, died: e ? e.t : null, hp: null });
      }
    }
    for (const o of objs) if (o.kind === 'patron') { const d = events.find(e => e.kind === 'drop' && e.team === o.team); o.dropped = d ? d.t : null; }
    // the jungle: camps (neutral creeps grouped by place; up while any creep is alive), statues, Sinner's machines, Urns
    const world = (Q.world || []).filter(r => r.cx != null && r.vx != null).map(r => Object.assign({}, r, { p: pos(r) }));
    const camps = [];
    for (const r of world.filter(r => r.kind === 'neutral').sort((a, b) => a.born - b.born)) {
      let c = camps.find(c => Math.hypot(c.x - r.p.x, c.y - r.p.y) < 1200);
      if (!c) camps.push(c = { x: r0(r.p.x), y: r0(r.p.y), size: 1, up: [] });
      c.size = Math.max(c.size, r.hpmax >= 2000 ? 3 : r.hpmax >= 400 ? 2 : 1);
      c.up.push([Math.round(clock(r.born)), r.died != null ? Math.round(clock(r.died)) : end + 1]);
    }
    const things = kind => world.filter(r => r.kind === kind).map(r => ({ x: r0(r.p.x), y: r0(r.p.y), born: Math.round(clock(r.born)), gone: r.died != null ? Math.round(clock(r.died)) : end + 1 }));
    // an Urn that disappears before the end was picked up: by the nearest hero that second
    const urns = things('urn').map(u => {
      if (u.gone > end) return u;
      const f = frames[Math.max(0, Math.min(end, u.gone))];
      let best = -1, bd = 1500;
      for (let i = 0; i < ents.length; i++) { const d = Math.hypot(f[i * 4] - u.x, f[i * 4 + 1] - u.y); if (f[i * 4 + 3] && d < bd) { bd = d; best = i; } }
      if (best >= 0) events.push({ t: u.gone, kind: 'urn', team: R.get(ents[best]).team, by: best, x: u.x, y: u.y });
      return Object.assign(u, { by: best });
    });
    events.sort((a, b) => a.t - b.t);
    const kills = (Q.kills || []).slice().sort((a, b) => a.tick - b.tick).map(k => ({
      t: Math.round(clock(k.tick) * 10) / 10, v: idx.has(k.v) ? idx.get(k.v) : -1, a: idx.has(k.a) ? idx.get(k.a) : -1, gold: k.gold || 0 }));
    const w = (Q.rules || []).slice().reverse().find(r => r.win != null && r.win >= 0);
    return { v: PACK_V, match: matchId || null, end, me: 0, myTeam, won: w ? w.win === myTeam : null,
      heroes: ents.map(e => ({ id: R.get(e).hero, team: R.get(e).team })), frames, vis, troop, souls, objs, kills,
      events, camps, statues: things('statue'), sinners: things('sinner'), urns };
  }
  const PACK_V = 2;
  // the four shrines (two per team), from their kill events on match 135294772
  const SHRINES = { 2: [[-2859, -7535], [299, -7535]], 3: [[2816, 7536], [-256, 7536]] };

  // ------------------------------------------------------------------ moments
  const ENGAGE = 2600;      // units: an enemy this close means you're in the fight
  const NEAR = 3200;        // units: allies/enemies this close at the decision count as "in it"
  const LEAD = 3;           // seconds before it turned bad that the question is asked
  const MAX_LOOK = 40;      // seconds: how far back from a death a losing fight can start
  const LANE_END = 540;     // 9:00, same as Engine.LANE_END
  const LATE_SOULS = 22000; // average souls per player where late game starts (a starting guess; tune on match data)
  const SLOTS = 3, MAX_Q = 9;
  const BASE = ['patron', 'basegd'];  // standing on these = defending your base: nowhere to fall back to
  const KNOWN = 6;          // seconds: an enemy your team saw on the map this recently counts as one you knew about
  const ODDS = 1.75;        // their souls / yours in the fight at which being outnumbered counts as clearly bad

  const hero = (M, s, i) => { const f = M.frames[Math.max(0, Math.min(M.end, s))], o = i * 4; return { x: f[o], y: f[o + 1], hp: f[o + 2], alive: !!f[o + 3] }; };
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const mine = (M, i) => M.heroes[i].team === M.myTeam;
  const known = (M, s, i) => { if (!M.vis) return true; for (let t = Math.max(0, s - KNOWN); t <= s; t++) if (M.vis[t] >> i & 1) return true; return false; };
  const soulsAt = (M, s) => M.souls[Math.max(0, Math.min(M.souls.length - 1, Math.floor(s / 10)))];

  function phaseAt(M, s) {
    if (s < LANE_END) return 'lane';
    const row = soulsAt(M, s), avg = row.reduce((a, b) => a + b, 0) / row.length;
    return avg >= LATE_SOULS ? 'late' : 'mid';
  }

  /* The situation at second s, seen from you. `enemies` are the ones your team had seen in the last KNOWN seconds
     (what you could judge the fight on); `unseen` were there too but hidden by fog. `fight` is the souls of the
     heroes actually in it, your side vs theirs. */
  function situation(M, s, range) {
    range = range || NEAR;
    const me = hero(M, s, M.me), allies = [], enemies = [], unseen = [];
    M.heroes.forEach((h, i) => {
      if (i === M.me) return;
      const p = hero(M, s, i);
      if (!p.alive || dist(me, p) > range) return;
      if (mine(M, i)) allies.push(i); else (known(M, s, i) ? enemies : unseen).push(i);
    });
    const row = soulsAt(M, s);
    const team = t => row.reduce((a, v, i) => a + (mine(M, i) === t ? v : 0), 0);
    const objective = M.objs.find(o => o.team === M.myTeam && o.kind !== 'midboss' && o.born <= s && (o.died == null || o.died > s) && dist(me, o) <= 2500) || null;
    const fight = { us: row[M.me] + allies.reduce((a, i) => a + row[i], 0), them: enemies.reduce((a, i) => a + row[i], 0) };
    return { s, hp: me.hp, allies, enemies, unseen, soulsBehind: team(false) - team(true), objective, fight };
  }

  /* When did the losing fight that ended at `td` begin? Walk back from the death through the unbroken stretch
     where you were outnumbered within range (a 2 s gap is allowed). */
  function fightStart(M, td) {
    let start = null, gap = 0;
    for (let s = Math.floor(td) - 1; s >= Math.max(0, td - MAX_LOOK); s--) {
      if (!hero(M, s, M.me).alive) break;
      const sit = situation(M, s, ENGAGE);
      if (sit.enemies.length + sit.unseen.length > sit.allies.length + 1) { start = s; gap = 0; } else if (start != null && ++gap > 2) break;
    }
    return start == null ? Math.floor(td) : start;
  }

  /* How clearly bad was it? 0 = not a question. Outnumbered AND the enemies you could see carried at least
     ODDS x your side's souls; being alone or under half health makes it worse. */
  function severity(sit) {
    const out = sit.enemies.length - (sit.allies.length + 1);
    if (out < 1 || !sit.fight.us) return 0;
    const ratio = sit.fight.them / sit.fight.us;
    if (ratio < ODDS) return 0;
    let v = ratio;
    if (!sit.allies.length) v += 0.5;
    if (sit.hp < 50) v += 0.5;
    return Math.round(v * 10) / 10;
  }

  /* Every death whose fight was clearly bad before you were caught: asked LEAD seconds before the first second
     it turned clearly bad. Base defence is left out. Then 3 per phase, worst first, spare slots lent, 9 at most. */
  function findMoments(M) {
    const found = [];
    for (const k of M.kills) {
      if (k.v !== M.me) continue;
      const fs = fightStart(M, k.t);
      let bad = null;
      for (let s = fs; s < k.t; s++) if (severity(situation(M, s, ENGAGE))) { bad = s; break; }
      if (bad == null) continue;
      const t = Math.max(0, bad - LEAD), sit = situation(M, bad), sev = severity(sit), at = situation(M, t);
      if (!sev || BASE.includes((at.objective || {}).kind)) continue;
      found.push(Object.assign({ kind: 'death', t, death: k.t, fightStart: fs, phase: phaseAt(M, t), severity: sev, killer: k.a }, sit,
        { hp: at.hp, objective: at.objective || sit.objective, focus: [M.me, ...sit.allies, ...sit.enemies, ...sit.unseen] }));
    }
    found.sort((a, b) => a.t - b.t);
    return pickSlots(found.filter((m, i) => !i || m.t - found[i - 1].death > 5));
  }

  function pickSlots(ms) {
    const by = { lane: [], mid: [], late: [] };
    ms.forEach(m => by[m.phase].push(m));
    Object.values(by).forEach(a => a.sort((x, y) => y.severity - x.severity));
    const keep = [];
    for (const p of ['lane', 'mid', 'late']) keep.push(...by[p].slice(0, SLOTS));
    const spare = Object.values(by).flatMap(a => a.slice(SLOTS)).sort((x, y) => y.severity - x.severity);
    keep.push(...spare.slice(0, MAX_Q - keep.length));
    return keep.sort((a, b) => a.t - b.t);
  }

  /* What you did after the decision: toward the enemies = fought; stayed on your objective = held; away = backed off. */
  function choice(M, m) {
    const centre = s => { const ps = m.enemies.map(i => hero(M, s, i)).filter(p => p.alive); return ps.length ? { x: ps.reduce((a, p) => a + p.x, 0) / ps.length, y: ps.reduce((a, p) => a + p.y, 0) / ps.length } : null; };
    const a = m.t, b = Math.min(Math.floor(m.death) - 1, m.t + LEAD + 4);
    const c0 = centre(a), c1 = centre(b), p0 = hero(M, a, M.me), p1 = hero(M, b, M.me);
    if (m.objective && dist(p1, m.objective) <= 2500) return 'hold';
    if (!c0 || !c1) return 'fight';
    return dist(p1, c1) <= dist(p0, c0) + 300 ? 'fight' : 'back';
  }

  const OBJ_NAME = { guardian: 'guardian', walker: 'walker', basegd: 'base guardian', patron: 'Patron' };
  const list = xs => xs.length < 2 ? xs.join('') : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1];
  const clockTxt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six'];

  /* The question card for a moment: title, facts, three options with verdicts, what you did and the outcome.
     Every number comes from the moment. name(i) gives hero i's display name. */
  function buildQuestion(M, m, name) {
    const n = m.allies.length + 1, e = m.enemies.length, word = x => WORDS[x] || String(x);
    const obj = m.objective && OBJ_NAME[m.objective.kind];
    const lost = m.objective && m.objective.died != null && m.objective.died <= m.death + 15 ? m.objective.died : null;
    const k = M.kills.find(x => x.t === m.death);
    const ratio = m.fight.them / Math.max(1, m.fight.us);
    const facts = [
      [String(e), `enem${e === 1 ? 'y' : 'ies'} you could see coming: ${list(m.enemies.map(name))}`],
      m.allies.length ? [String(m.allies.length), `teammate${m.allies.length === 1 ? '' : 's'} with you (${list(m.allies.map(name))}); the rest are far away`] : ['0', 'teammates near you'],
      [`${ratio.toFixed(1)}×`, 'their souls vs yours, counting only the heroes in this fight'],
      [`${m.hp}%`, 'your health'],
    ];
    const odds = `${n === 1 ? 'Alone' : word(n)[0].toUpperCase() + word(n).slice(1) + ' of you'} against ${word(e)}`;
    const opts = [
      { id: 'fight', label: obj ? 'Go out and fight them' : 'Take the fight', verdict: 'risky',
        why: `${odds}, with ${ratio.toFixed(1)}× your souls on their side. You died at ${clockTxt(m.death)}${lost ? `, and the ${obj} fell at ${clockTxt(lost)} anyway` : ''}.` },
      obj ? { id: 'hold', label: `Stay and defend the ${obj}`, verdict: 'risky',
        why: `Still ${odds.toLowerCase()}. ${lost ? `The ${obj} fell at ${clockTxt(lost)}; staying would have traded your life for a few seconds.` : 'Holding there means fighting them on their terms.'}` }
        : { id: 'hold', label: 'Hold your ground and wait for help', verdict: 'risky',
        why: `Nobody was close enough to arrive in time: ${m.allies.length ? 'only ' + list(m.allies.map(name)) + ' was near' : 'no teammate was near you'}.` },
      { id: 'back', label: 'Fall back and group with your team', verdict: 'good',
        why: `${obj ? `Give up the ${obj} you can’t save, ` : 'Back off before they reach you, '}deny them the ${k && k.gold ? k.gold.toLocaleString('en') + '-soul ' : ''}bounty on you, and come back to the next fight with your team.` },
    ];
    const title = obj ? `Your ${obj} is under attack` : n === 1 ? 'You’re on your own' : 'You’re outnumbered';
    return { title, facts, opts, did: choice(M, m), outcome: `Died${n === 1 ? ' alone' : ''} at ${clockTxt(m.death)}`, ratio };
  }

  const Review = { QUERIES, PACK_V, pack, ffill, known, situation, fightStart, phaseAt, severity, findMoments, pickSlots, choice, buildQuestion,
    ODDS, KNOWN, LATE_SOULS, LANE_END, clockTxt };
  root.Review = Review;
  if (typeof module === 'object' && module.exports) module.exports = Review;
})(typeof window !== 'undefined' ? window : globalThis);
