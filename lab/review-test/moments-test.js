// node lab/review-test/moments-test.js [match ...]  — prints the moments found in each packed match.
const fs = require('fs'), path = require('path'), vm = require('vm');
const Mo = require('./moments.js');
const dir = path.join(__dirname, 'matches');
const ids = process.argv.slice(2).length ? process.argv.slice(2) : fs.readdirSync(dir).filter(f => f.endsWith('.js')).map(f => f.slice(0, -3));
const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
let fail = 0;
for (const id of ids) {
  const ctx = { window: {} }; vm.runInNewContext(fs.readFileSync(path.join(dir, id + '.js'), 'utf8'), ctx);
  const M = ctx.window.MATCH, name = i => M.heroes[i].name;
  const deaths = M.kills.filter(k => k.v === M.me);
  const ms = Mo.findMoments(M);
  console.log(`\n${id} · ${M.heroes[M.me].name} · ${M.won ? 'win' : 'loss'} · ${deaths.length} deaths -> ${ms.length} questions`);
  for (const m of ms) {
    console.log(`  ${m.phase.padEnd(4)} ${fmt(m.t)} (died ${fmt(m.death)}) sev ${m.severity}  ${m.allies.length + 1}v${m.enemies.length}  souls ${(m.fight.them / Math.max(1, m.fight.us)).toFixed(2)}x  team ${m.soulsBehind > 0 ? 'behind' : 'ahead'} ${(Math.abs(m.soulsBehind) / 1000).toFixed(1)}k  hp ${m.hp}%` +
      `${m.objective ? '  at your ' + m.objective.kind : ''}  vs ${m.enemies.map(name).join(', ')}`);
  }
  const skipped = deaths.filter(d => !ms.some(m => m.death === d.t));
  if (skipped.length) console.log(`  no question: deaths at ${skipped.map(d => fmt(d.t)).join(', ')}`);
  if (id === '135194126') {
    const q = ms.find(m => m.t >= 1080 && m.t <= 1090);
    console.log(q ? '  ✓ found the 18:05 walker moment' : '  ✗ missed the 18:05 walker moment'); if (!q) fail++;
  }
}
process.exit(fail ? 1 : 0);
