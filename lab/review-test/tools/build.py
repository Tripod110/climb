"""Pack one match's cached replay query results into a JS data file for the review page (see fetch.py)."""
import json, os, collections, urllib.request
from load import Match, pos, ffill

HERE = os.path.dirname(os.path.abspath(__file__))
r0 = lambda v: int(round(v))


def hero_assets():
    f = os.path.join(HERE, 'cache', 'heroes.json')
    if not os.path.exists(f):
        os.makedirs(os.path.dirname(f), exist_ok=True)
        data = urllib.request.urlopen(urllib.request.Request('https://api.deadlock-api.com/v1/assets/heroes',
                                      headers={'User-Agent': 'climb-model/1 (personal Deadlock tracker)'})).read()
        open(f, 'wb').write(data)
    return {x['id']: x for x in json.load(open(f, encoding='utf-8'))}


def build(mid, account, folder, out):
    m = Match(folder)
    R = m.roster()
    H = hero_assets()
    me = next(e for e, v in R.items() if v['account'] == account)
    ents = sorted(R, key=lambda e: (R[e]['team'] != R[me]['team'], e != me, e))

    # max health per hero over time, from the controllers (includes bonus health from items)
    hero_ent = {R[e]['hero']: e for e in ents}
    hmax = collections.defaultdict(list)   # pawn -> [(second, max)]
    for r in ffill(m.L('players'), ['hero', 'hmax']):
        if r.get('hero') in hero_ent and r.get('hmax'):
            hmax[hero_ent[r['hero']]].append((m.clock(r['tick']), r['hmax']))
    def max_hp(e, s, fallback):
        best = fallback
        for t, v in hmax.get(e, []):
            if t > s: break
            best = v
        return max(best, 1)

    # heroes: one [x, y, hp%, alive] per second, carried forward
    P = ffill(m.L('pawns'), ['team', 'hp', 'hpmax', 'life', 'cx', 'cy', 'vx', 'vy'])
    by_sec = collections.defaultdict(dict)
    for r in P:
        if r['entity_index'] in R and 'cx' in r and 'vx' in r:
            by_sec[int(m.clock(r['tick']))][r['entity_index']] = r
    end = max(by_sec)
    frames, last = [], {}
    for s in range(0, end + 1):
        S = by_sec.get(s, {})
        row = []
        for e in ents:
            if e in S:
                r = S[e]
                x, y = pos(r)
                last[e] = [r0(x), r0(y), min(100, r0(100 * r.get('hp', 0) / max_hp(e, s, r.get('hpmax') or 1))), 1 if r.get('life', 0) == 0 else 0]
            row.extend(last.get(e, [0, 0, 0, 0]))
        frames.append(row)

    # troopers every 2 s (alive only), positions / 10
    troop = collections.defaultdict(list)
    for r in ffill(m.L('troop'), ['team', 'life', 'cx', 'cy', 'vx', 'vy']):
        if r.get('life', 0) != 0 or 'vx' not in r or 'cx' not in r:
            continue
        s = int(m.clock(r['tick']))
        if s < 0 or s % 2:
            continue
        x, y = pos(r)
        troop[s].extend([r0(x / 10), r0(y / 10), r['team']])

    # each hero's souls (net worth) every 10 s, in ents order
    nw = collections.defaultdict(dict)
    for r in ffill(m.L('players'), ['hero', 'nw']):
        if r.get('hero') in hero_ent and 'nw' in r:
            nw[int(m.clock(r['tick']))][hero_ent[r['hero']]] = r['nw']
    souls, cur = [], {}
    keys = sorted(nw)
    ki = 0
    for s in range(0, end + 1, 10):
        while ki < len(keys) and keys[ki] <= s:
            cur.update(nw[keys[ki]]); ki += 1
        souls.append([cur.get(e, 0) for e in ents])

    objs = [{'kind': o['kind'], 'team': o['team'], 'x': r0(pos(o)[0]), 'y': r0(pos(o)[1]),
             'died': round(m.clock(o['died']), 1) if o.get('died') is not None else None,
             'born': round(m.clock(o['born']), 1)}
            for o in m.L('obj') if 'cx' in o and o.get('team') in (2, 3, 4)]
    idx = {e: i for i, e in enumerate(ents)}
    kills = [{'t': round(m.clock(k['tick']), 1), 'v': idx.get(k['entindex_victim'], -1), 'a': idx.get(k['entindex_attacker'], -1),
              'gold': k.get('killfeed_gold')}
             for k in sorted(m.L('kills'), key=lambda k: k['tick'])]
    rules = m.L('rules')
    win = next((r['win'] for r in reversed(rules) if r.get('win') not in (None, -1)), None)

    data = {
        'match': mid, 'end': end, 'me': 0, 'myTeam': R[me]['team'], 'won': win == R[me]['team'] if win is not None else None,
        'heroes': [{'name': H[R[e]['hero']]['name'], 'team': R[e]['team'], 'img': H[R[e]['hero']]['images']['minimap_image']} for e in ents],
        'frames': frames, 'troop': troop, 'souls': souls, 'objs': objs, 'kills': kills,
    }
    with open(out, 'w', encoding='utf-8') as f:
        f.write('window.MATCH=' + json.dumps(data, separators=(',', ':')) + ';')
    print(f'  {mid}: {data["heroes"][0]["name"]}, {"win" if data["won"] else "loss"}, {end // 60}:{end % 60:02d}, {os.path.getsize(out) // 1024} KB')
