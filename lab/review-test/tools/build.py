"""Pack match 135194126's replay query results into lab/review-test/data.js for the test page."""
import json, math, collections, sys
from load import *

OUT = sys.argv[1]
R = roster()
P, by_sec = heroes()
H = {x['id']: x for x in json.load(open('heroes_assets.json', encoding='utf-8'))}
me = [e for e, v in R.items() if v['hero'] == ME_HERO][0]
ents = sorted(R, key=lambda e: (R[e]['team'] != R[me]['team'], e != me, e))
end = int(clock(max(r['tick'] for r in P)))
r0 = lambda v: int(round(v))

# heroes: one [x, y, hp%, alive] per second, carried forward
frames = []
last = {}
for s in range(0, end + 1):
    S = by_sec.get(s, {})
    row = []
    for e in ents:
        if e in S:
            r = S[e]
            x, y = pos(r)
            last[e] = [r0(x), r0(y), r0(100 * r['hp'] / max(1, r.get('hpmax') or 1)), 1 if r.get('life', 0) == 0 else 0]
        row.extend(last.get(e, [0, 0, 0, 0]))
    frames.append(row)

# troopers every 2 s (alive only)
T = ffill(L('troop'), ['team', 'life', 'cx', 'cy', 'vx', 'vy'])
troop = collections.defaultdict(list)
for r in T:
    if r.get('life', 0) != 0 or 'vx' not in r: continue
    s = int(clock(r['tick']))
    if s < 0 or s % 2: continue
    x, y = pos(r)
    troop[s].extend([r0(x / 10), r0(y / 10), r['team']])

# team souls every 10 s
C = ffill(L('players'), ['hero', 'm_iTeamNum', 'nw'])
nw = collections.defaultdict(dict)
for r in C:
    if 'hero' in r and 'nw' in r and r['hero']:
        nw[int(clock(r['tick']))][r['hero']] = (r['m_iTeamNum'], r['nw'])
souls = []
for s in range(0, end + 1, 10):
    k = max((t for t in nw if t <= s), default=None)
    tot = collections.Counter()
    if k is not None:
        for h, (t, v) in nw[k].items(): tot[t] += v
    souls.append([tot[R[me]['team']], tot[5 - R[me]['team']]])

objs = [{'kind': o['kind'], 'team': o['team'], 'x': r0(pos(o)[0]), 'y': r0(pos(o)[1]), 'died': round(clock(o['died']), 1)}
        for o in L('obj')]
kills = [{'t': round(clock(k['tick']), 1), 'v': ents.index(k['entindex_victim']) if k['entindex_victim'] in ents else -1,
          'a': ents.index(k['entindex_attacker']) if k['entindex_attacker'] in ents else -1} for k in sorted(L('kills'), key=lambda k: k['tick'])]

data = {
    'match': 135194126, 'end': end, 'me': 0, 'myTeam': R[me]['team'],
    'heroes': [{'name': H[R[e]['hero']]['name'], 'team': R[e]['team'], 'img': H[R[e]['hero']]['images']['minimap_image']} for e in ents],
    'frames': frames, 'troop': troop, 'souls': souls, 'objs': objs, 'kills': kills,
}
with open(OUT, 'w', encoding='utf-8') as f:
    f.write('window.MATCH=' + json.dumps(data, separators=(',', ':')) + ';')
print('heroes', [h['name'] for h in data['heroes']], 'seconds', end, 'bytes', sum(len(json.dumps(v)) for v in data.values()))
