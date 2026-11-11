"""Load the replay query results into per-second frames. Shared by explore.py and build.py."""
import json, collections

TR = 64          # ticks per second
GST = 70.65625   # game start time (s), from CCitadelGameRulesProxy
ME_HERO = 50


def L(n):
    return [json.loads(l) for l in open(n + '.ndjson', encoding='utf-8')]


def pos(r):
    return (r['cx'] * 512 + r['vx'] - 32768, r['cy'] * 512 + r['vy'] - 32768)


def clock(tick):
    return tick / TR - GST


def ffill(rows, keys):
    """Delta rows -> full state per (entity, tick), carrying unchanged fields forward."""
    rows = sorted(rows, key=lambda r: r['tick'])
    state = collections.defaultdict(dict)
    out = []
    for r in rows:
        s = state[r['entity_index']]
        for k in keys:
            if r.get(k) is not None:
                s[k] = r[k]
        out.append(dict(s, tick=r['tick'], entity_index=r['entity_index']))
    return out


def roster():
    """pawn entity index -> {hero, team, name} via the controllers' hero-pawn handles."""
    out = {}
    for c in L('map'):
        if c['hero']:
            out[c['hp'] & 0x3FFF] = {'hero': c['hero'], 'team': c['team'], 'name': c['name']}
    return out


def heroes():
    R = roster()
    P = ffill(L('pawns'), ['team', 'hp', 'hpmax', 'life', 'cx', 'cy', 'vx', 'vy'])
    for r in P:
        if r['entity_index'] in R:
            r['hero'] = R[r['entity_index']]['hero']
    by_sec = collections.defaultdict(dict)   # second -> entity -> state
    for r in P:
        if 'cx' not in r or 'vx' not in r or 'hero' not in r:
            continue
        sec = int(clock(r['tick']))
        by_sec[sec][r['entity_index']] = r
    return P, by_sec
