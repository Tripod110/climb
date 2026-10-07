/* play-tests.js — play-time model tests. Run:  node js/play-tests.js   (exits 1 on any failure)
   Timestamps are built from local dates, so the tests pass in any timezone. */
'use strict';
const P = require('./play.js');
const results = [];
const eq = (name, got, want) => results.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });

const at = (d, h, m) => new Date(2026, 9, d, h, m || 0) / 1000;   // October 2026, local time
const H = 3600;

// ---------------------------------------------------------------- days
eq('day starts at 5 AM: 4:59 belongs to yesterday', P.dayKey(at(6, 4, 59)), '2026-10-05');
eq('5:00 is today', P.dayKey(at(6, 5)), '2026-10-06');
eq('addDays crosses months', P.addDays('2026-10-31', 1), '2026-11-01');
eq('Monday is weekday 0', P.weekday('2026-10-05'), 0);
eq('Sunday is weekday 6', P.weekday('2026-10-11'), 6);

// ---------------------------------------------------------------- intervals
const api = [{ t: at(3, 20), dur: 1800 }, { t: at(3, 20, 20), dur: 1800 }, { t: at(6, 21), dur: 1800 }];
eq('overlapping API matches merge', P.intervals(null, api, at(7, 12)).map(i => [i.s, i.e]),
  [[at(3, 20), at(3, 20, 50)], [at(6, 21), at(6, 21, 30)]]);
const helper = { since: at(6, 12), playing: true, sessions: [{ start: at(6, 20, 30), end: null }] };
const ivs = P.intervals(helper, api, at(6, 22));
eq('API data after helper.since is ignored; open session runs to now',
  ivs.map(i => [i.s, i.e, i.src]), [[at(3, 20), at(3, 20, 50), 'api'], [at(6, 20, 30), at(6, 22), 'helper']]);
eq('API match straddling helper.since is clipped',
  P.intervals({ since: at(6, 12), sessions: [] }, [{ t: at(6, 11, 45), dur: 1800 }], at(6, 13)).map(i => i.e), [at(6, 12)]);

// ---------------------------------------------------------------- per day
const late = P.perDay([{ s: at(6, 23), e: at(7, 6) }]);
eq('session over 5 AM splits: 6h to the 6th, 1h to the 7th', [late.get('2026-10-06'), late.get('2026-10-07')], [6 * H, 1 * H]);
eq('1 AM play counts toward the evening before', P.perDay([{ s: at(7, 1), e: at(7, 2) }]).get('2026-10-06'), H);

// ---------------------------------------------------------------- hours
const hp = P.hourProfile([{ s: at(6, 22, 30), e: at(7, 0, 30) }], at(1, 0), at(8, 0));
eq('hour profile splits on clock hours', [hp[22], hp[23], hp[0]], [1800, 3600, 1800]);

// ---------------------------------------------------------------- levels + summary
eq('levels are fixed hour steps', [0, 1, H, 2 * H, 3 * H, 5 * H].map(P.level), [0, 1, 2, 3, 4, 5]);
const many = [];
for (let d = 1; d <= 5; d++) many.push({ t: at(d, 20), dur: 2 * H });   // Oct 1-5, 2h a day
const s = P.summary({ since: at(6, 12), playing: true, sessions: [{ start: at(6, 19), end: at(6, 20) }, { start: at(6, 21), end: null }] }, many, at(6, 22));
eq('today = both helper sessions', [s.todaySecs, s.todaySessions, s.playing, s.playingSince], [2 * H, 2, true, at(6, 21)]);
eq('average counts only days since data began', [s.avgSecs, s.avgDays], [2 * H, 5]);
eq('heatmap is 12 full weeks', s.cells.length, 84);
eq('heatmap ends in the current week, future days flagged', s.cells.filter(c => c.future).length, 6 - P.weekday('2026-10-06'));
eq('today\'s cell uses the helper', s.cells.find(c => c.key === '2026-10-06').src, 'helper');
eq('average needs 3 days of data', P.summary(null, [{ t: at(5, 20), dur: H }], at(6, 22)).avgSecs, null);

eq('dur formats', [P.dur(0), P.dur(45 * 60), P.dur(125 * 60)], ['0m', '45m', '2h 05m']);

// ---------------------------------------------------------------- report
const bad = results.filter(r => !r.ok);
for (const r of bad) console.log('FAIL', r.name, '\n  got ', JSON.stringify(r.got), '\n  want', JSON.stringify(r.want));
console.log(`${results.length - bad.length}/${results.length} passed`);
if (bad.length) process.exit(1);
