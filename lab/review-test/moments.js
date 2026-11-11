/* Climb lab: find the moments worth a question in one match's replay data (window.MATCH from tools/build.py).
   Pure functions, no DOM, so it can move into js/engine.js later. Test: node lab/review-test/moments-test.js

   A moment is a decision you made just before a fight that went wrong: we walk back from each of your deaths
   to the second you stepped into enemy range, then read the situation at that point (who was near, souls,
   health, any objective you were standing on). It becomes a question only if the situation was clearly bad
   before the fight started, so there is a clearly wrong answer. */
(function (root) {
  const ENGAGE = 2600;      // units: an enemy this close means you're in the fight
  const NEAR = 3200;        // units: allies/enemies this close at the decision count as "in it"
  const LEAD = 3;           // seconds before the fight starts that the decision is read
  const MAX_LOOK = 40;      // seconds: how far back from a death a fight can start
  const LANE_END = 540;     // 9:00, same as Engine.LANE_END
  const LATE_SOULS = 22000; // average souls per player where late game starts. A guess: tune on public match data.
  const SLOTS = 3, MAX_Q = 9;
  const BASE = ['patron', 'basegd'];  // standing on these = defending your base

  const hero = (M, s, i) => { const f = M.frames[Math.max(0, Math.min(M.end, s))], o = i * 4; return { x: f[o], y: f[o + 1], hp: f[o + 2], alive: !!f[o + 3] }; };
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const mine = (M, i) => M.heroes[i].team === M.myTeam;
  const soulsAt = (M, s) => M.souls[Math.max(0, Math.min(M.souls.length - 1, Math.floor(s / 10)))];

  function phaseAt(M, s) {
    if (s < LANE_END) return 'lane';
    const row = soulsAt(M, s), avg = row.reduce((a, b) => a + b, 0) / row.length;
    return avg >= LATE_SOULS ? 'late' : 'mid';
  }

  // When did the losing fight that ended at `td` begin? Walk back from the death through the unbroken stretch
  // where you were outnumbered within range (a 2 s gap is allowed); its first second is when it turned bad.
  function fightStart(M, td) {
    let s = Math.floor(td) - 1, start = null, gap = 0;
    for (; s >= Math.max(0, td - MAX_LOOK); s--) {
      if (!hero(M, s, M.me).alive) break;
      const sit = situation(M, s, ENGAGE);
      if (sit.enemies.length > sit.allies.length + 1) { start = s; gap = 0; } else if (start != null && ++gap > 2) break;
    }
    return start == null ? Math.floor(td) : start;
  }

  // The situation at second s, seen from you.
  function situation(M, s, range = NEAR) {
    const me = hero(M, s, M.me), allies = [], enemies = [];
    M.heroes.forEach((h, i) => {
      if (i === M.me) return;
      const p = hero(M, s, i);
      if (!p.alive || dist(me, p) > range) return;
      (mine(M, i) ? allies : enemies).push(i);
    });
    const row = soulsAt(M, s);
    const team = t => row.reduce((a, v, i) => a + (mine(M, i) === t ? v : 0), 0);
    const objective = M.objs.find(o => o.team === M.myTeam && o.kind !== 'midboss' && o.born <= s && (o.died == null || o.died > s) && dist(me, o) <= 2500) || null;
    // fight maths: the souls of the heroes actually in it, your side vs theirs
    const fight = { us: row[M.me] + allies.reduce((a, i) => a + row[i], 0), them: enemies.reduce((a, i) => a + row[i], 0) };
    return { s, hp: me.hp, allies, enemies, soulsBehind: team(false) - team(true), objective, fight };
  }

  // How clearly bad was it before the fight began? 0 = not a question.
  // Outnumbered, AND the enemies in the fight carried at least ODDS times your side's souls (so a 2v4 while
  // far ahead on items doesn't count, and an even-numbers fight never does).
  const ODDS = 1.75;
  function severity(sit) {
    const out = sit.enemies.length - (sit.allies.length + 1);   // positive = outnumbered
    if (out < 1 || !sit.fight.us) return 0;
    const ratio = sit.fight.them / sit.fight.us;
    if (ratio < ODDS) return 0;
    let v = ratio;
    if (!sit.allies.length) v += .5;                              // alone
    if (sit.hp < 50) v += .5;
    return Math.round(v * 10) / 10;
  }

  function findMoments(M) {
    const found = [];
    for (const k of M.kills) {
      if (k.v !== M.me) continue;
      // Within the losing stretch, find the first second it was clearly bad (outnumbered by 2, or by 1 while well
      // behind): that's when you should have left. Ask the question a few seconds before it.
      const fs = fightStart(M, k.t);
      let bad = null;
      for (let s = fs; s < k.t; s++) if (severity(situation(M, s, ENGAGE))) { bad = s; break; }
      if (bad == null) continue;
      const t = Math.max(0, bad - LEAD), sit = situation(M, bad), sev = severity(sit);
      if (!sev) continue;
      // a last stand in your own base has nowhere to fall back to: not a question
      if (BASE.includes((situation(M, t).objective || {}).kind)) continue;
      found.push({ kind: 'death', t, death: k.t, fightStart: fs, phase: phaseAt(M, t), severity: sev, killer: k.a, ...sit,
        hp: situation(M, t).hp, objective: situation(M, t).objective || sit.objective, focus: [M.me, ...sit.allies, ...sit.enemies] });
    }
    // drop moments inside the same fight (keep the earlier decision)
    found.sort((a, b) => a.t - b.t);
    const uniq = found.filter((m, i) => !i || m.t - found[i - 1].death > 5);
    return pickSlots(uniq);
  }

  // 3 per phase; an empty phase's slots go to the busiest one, 9 at most. Worst first within a phase.
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

  // What did you do in the seconds after the decision? Toward the enemies = fought; stayed on your objective = held;
  // away from them = backed off (too late, since you still died).
  function choice(M, m) {
    const centre = s => { const ps = m.enemies.map(i => hero(M, s, i)).filter(p => p.alive); return ps.length ? { x: ps.reduce((a, p) => a + p.x, 0) / ps.length, y: ps.reduce((a, p) => a + p.y, 0) / ps.length } : null; };
    const a = m.t, b = Math.min(Math.floor(m.death) - 1, m.t + LEAD + 4);
    const c0 = centre(a), c1 = centre(b), p0 = hero(M, a, M.me), p1 = hero(M, b, M.me);
    if (m.objective && dist(p1, m.objective) <= 2500) return 'hold';
    if (!c0 || !c1) return 'fight';
    return dist(p1, c1) <= dist(p0, c0) + 300 ? 'fight' : 'back';
  }

  const OBJ_NAME = { guardian: 'guardian', walker: 'walker', basegd: 'base guardian', patron: 'Patron' };
  const list = names => names.length < 2 ? names.join('') : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];

  // Turn a moment into the question card's content: title, facts, three options with verdicts, and the outcome.
  // Every number comes from the moment; verdicts follow the one rule that made it a question (outnumbered before it began).
  function buildQuestion(M, m) {
    const name = i => M.heroes[i].name, n = m.allies.length + 1, e = m.enemies.length, fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
    const obj = m.objective && OBJ_NAME[m.objective.kind];
    const lost = m.objective && m.objective.died != null && m.objective.died <= m.death + 15 ? m.objective.died : null;
    const k = M.kills.find(x => x.t === m.death);
    const behind = m.soulsBehind >= 1000 ? `${(m.soulsBehind / 1000).toFixed(1)}k souls behind` : m.soulsBehind <= -1000 ? `${(-m.soulsBehind / 1000).toFixed(1)}k souls ahead` : 'even on souls';
    const facts = [
      [String(e), `enem${e === 1 ? 'y' : 'ies'} coming: ${list(m.enemies.map(name))}`],
      m.allies.length ? [String(m.allies.length), `teammate${m.allies.length === 1 ? '' : 's'} with you (${list(m.allies.map(name))}); the rest are far away`] : ['0', 'teammates near you'],
      [m.soulsBehind >= 1000 ? `${(m.soulsBehind / 1000).toFixed(1)}k` : '—', m.soulsBehind >= 1000 ? 'souls your team is behind' : behind],
      [`${m.hp}%`, 'your health'],
    ];
    const W = ['zero', 'one', 'two', 'three', 'four', 'five', 'six'], word = x => W[x] || String(x);
    const odds = `${n === 1 ? 'Alone' : word(n)[0].toUpperCase() + word(n).slice(1) + ' of you'} against ${word(e)}`;
    const opts = [
      { id: 'fight', label: obj ? 'Go out and fight them' : 'Take the fight', verdict: 'risky',
        why: `${odds}${m.soulsBehind >= 1000 ? `, ${behind}` : ''}. You died at ${fmt(m.death)}${lost ? `, and the ${obj} fell at ${fmt(lost)} anyway` : ''}.` },
      obj ? { id: 'hold', label: `Stay and defend the ${obj}`, verdict: 'risky',
        why: `Still ${odds.toLowerCase()}. ${lost ? `The ${obj} fell at ${fmt(lost)}; staying would have traded your life for a few seconds.` : `Holding there means fighting them on their terms.`}` }
          : { id: 'hold', label: 'Hold your ground and wait for help', verdict: 'risky',
        why: `Nobody was close enough to arrive in time: ${m.allies.length ? 'only ' + list(m.allies.map(name)) + ' was near' : 'no teammate was near you'}.` },
      { id: 'back', label: 'Fall back and group with your team', verdict: 'good',
        why: `${obj ? `Give up the ${obj} you can’t save, ` : 'Back off before they reach you, '}deny them the ${k && k.gold ? k.gold.toLocaleString('en') + '-soul ' : ''}bounty on you, and come back to the next fight with your team.` },
    ];
    const title = obj ? `Your ${obj} is under attack` : n === 1 ? `You’re on your own` : `You’re outnumbered`;
    return { title, facts, opts, did: choice(M, m), outcome: `Died${n === 1 ? ' alone' : ''} at ${fmt(m.death)}` };
  }

  const api = { findMoments, situation, fightStart, phaseAt, severity, pickSlots, choice, buildQuestion, LATE_SOULS, LANE_END };
  if (typeof module !== 'undefined') module.exports = api; else root.Moments = api;
})(this);
