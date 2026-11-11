import math
from load import *
R = roster(); P, by_sec = heroes()
me = 87; myteam = 3
O = {o['entity_index']: o for o in L('obj')}
w = [o for o in O.values() if o['kind']=='walker' and o['team']==3 and abs(clock(o['died'])-1102)<5][0]
wp = pos(w); print('our walker died', clock(w['died']), 'at', [int(x) for x in wp])
for s in range(1075, 1105, 3):
    S = by_sec.get(s, {})
    if me not in S: continue
    m = pos(S[me])
    al = sorted((int(math.dist(m, pos(r))), R[e]['hero']) for e, r in S.items() if r.get('team')==myteam and e!=me and r.get('life',0)==0)
    en = sorted((int(math.dist(m, pos(r))), R[e]['hero'], r['hp']) for e, r in S.items() if r.get('team')!=myteam and r.get('life',0)==0)
    print(s//60, s%60, 'me', [int(x) for x in m], 'hp', S[me]['hp'], 'to walker', int(math.dist(m, wp)), 'ally', al[:2], 'enemy', en[:4])
