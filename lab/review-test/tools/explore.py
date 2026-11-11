import collections, math
from load import *

R = roster()
P, by_sec = heroes()
me = [e for e, v in R.items() if v['hero'] == ME_HERO][0]
myteam = R[me]['team']
print('me', me, R[me])
fmt = lambda t: f"{int(t // 60)}:{int(t % 60):02d}"

# net worth per second per controller
C = ffill(L('players'), ['hero', 'm_iTeamNum', 'nw', 'lvl'])
nw = collections.defaultdict(dict)
for r in C:
    if 'hero' in r and 'nw' in r:
        nw[int(clock(r['tick']))][r['hero']] = (r['m_iTeamNum'], r['nw'])
def team_nw(sec):
    best = max((s for s in nw if s <= sec), default=None)
    if best is None: return None
    tot = collections.Counter()
    for h, (t, v) in nw[best].items(): tot[t] += v
    return tot[myteam], tot[5 - myteam]

def near(sec, ent, radius=2500):
    S = by_sec.get(sec, {})
    if ent not in S: return None
    mx, my = pos(S[ent])
    al, en = [], []
    for e, r in S.items():
        if e == ent or r.get('life', 0) != 0: continue
        d = math.dist((mx, my), pos(r))
        if d <= radius:
            (al if r['team'] == myteam else en).append((R[e]['hero'], int(d), r['hp']))
    return al, en, (mx, my), S[ent]['hp'], S[ent].get('hpmax')

K = sorted(L('kills'), key=lambda k: k['tick'])
for k in K:
    v, a = k['entindex_victim'], k['entindex_attacker']
    if v == me or a == me:
        t = clock(k['tick'])
        tn = team_nw(int(t) - 10)
        pre = near(int(t) - 8, me)
        print(fmt(t), 'DIED' if v == me else 'KILL', 'killer', R.get(a, {}).get('hero'), 'victim', R.get(v, {}).get('hero'),
              'nw us/them', tn, '| 8s before: allies', pre and pre[0], 'enemies', pre and pre[1], 'myhp', pre and pre[3:])
print()
for o in sorted(L('obj'), key=lambda o: o['died']):
    print('obj', o['kind'], 'team', o['team'], fmt(clock(o['died'])))
