"""Load one match's replay query results (cache/<match>/*.ndjson) into per-second state. Used by build.py."""
import json, collections, os

TR = 64          # ticks per second
STEAM64 = 76561197960265728


class Match:
    def __init__(self, folder):
        self.dir = folder
        rules = self.L('rules')
        self.gst = next(r['gst'] for r in rules if r.get('gst'))   # game start time (s)

    def L(self, n):
        return [json.loads(l) for l in open(os.path.join(self.dir, n + '.ndjson'), encoding='utf-8')]

    def clock(self, tick):
        return tick / TR - self.gst

    def roster(self):
        """pawn entity index -> {hero, team, name, account} via the controllers' hero-pawn handles."""
        out = {}
        for c in self.L('map'):
            if c.get('hero') and c.get('hp') is not None:
                out[c['hp'] & 0x3FFF] = {'hero': c['hero'], 'team': c['team'], 'name': c.get('name'),
                                         'account': (c['steam'] - STEAM64) if c.get('steam') else None}
        return out


def pos(r):
    return (r['cx'] * 512 + r['vx'] - 32768, r['cy'] * 512 + r['vy'] - 32768)


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
