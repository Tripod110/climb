"""Fight-odds study: how often is an outnumbered player killed, by the soul ratio of the fight and by what they did next?

usage: python study.py fetch <account> <n>    fetch replay data for the account's n most recent matches (cached)
       python study.py report                 analyse every cached match and print the table (writes study_out.json)

Every replay holds all 12 players, so each match gives 12 points of view. An "episode" starts the first second a
player is outnumbered within ENGAGE range (after at least GAP seconds not outnumbered). We record the soul ratio
of the fight (enemies in range vs the player plus allies in NEAR range), what they did over the next CHOICE seconds
(toward the enemies = pushed, away = backed off, else held), and whether they died within DIE seconds.
Base defence (standing at your own Patron or base guardian) is left out, as in moments.js."""
import json, math, os, sys, collections, urllib.request
import fetch
from load import Match, pos, ffill

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, 'cache')
QUERIES = ['map', 'rules', 'pawns', 'players', 'kills', 'obj']
ENGAGE, NEAR, GAP, CHOICE, DIE = 2600, 3200, 6, 5, 15
BUCKETS = [0, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 99]


def fetch_matches(account, n):
    url = f'https://api.deadlock-api.com/v1/players/{account}/match-history'
    hist = json.loads(urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': fetch.UA})).read())
    hist = hist if isinstance(hist, list) else hist.get('matches', [])
    ids = [m['match_id'] for m in sorted(hist, key=lambda m: -m['start_time'])][:n]
    for i, mid in enumerate(ids):
        folder = os.path.join(CACHE, str(mid))
        os.makedirs(folder, exist_ok=True)
        res = [fetch.run(mid, q, folder) for q in QUERIES]
        bad = [f'{q}: {m}' for q, m in res if m.startswith('FAILED')]
        print(f'{i + 1}/{len(ids)} {mid}', 'ok' if not bad else bad, flush=True)


def episodes(folder):
    m = Match(folder)
    R = m.roster()
    ents = sorted(R)
    team = {e: R[e]['team'] for e in ents}
    # positions / health / alive per second
    P = ffill(m.L('pawns'), ['hp', 'life', 'cx', 'cy', 'vx', 'vy'])
    sec = collections.defaultdict(dict)
    for r in P:
        if r['entity_index'] in R and 'cx' in r and 'vx' in r:
            sec[int(m.clock(r['tick']))][r['entity_index']] = (pos(r), r.get('life', 0) == 0)
    end = max(sec)
    state, frames = {}, []
    for s in range(end + 1):
        state.update(sec.get(s, {}))
        frames.append(dict(state))
    # souls per hero over time
    hero_ent = {R[e]['hero']: e for e in ents}
    nw = []
    for r in ffill(m.L('players'), ['hero', 'nw']):
        if r.get('hero') in hero_ent and 'nw' in r:
            nw.append((m.clock(r['tick']), hero_ent[r['hero']], r['nw']))
    nw.sort()
    souls_at, cur, j = [], {}, 0
    for s in range(end + 1):
        while j < len(nw) and nw[j][0] <= s:
            cur[nw[j][1]] = nw[j][2]; j += 1
        souls_at.append(dict(cur))
    deaths = collections.defaultdict(list)
    for k in m.L('kills'):
        deaths[k['entindex_victim']].append(m.clock(k['tick']))
    base = [(pos(o), o['team']) for o in m.L('obj') if o.get('kind') in ('patron', 'basegd') and 'cx' in o]

    out = []
    for p in ents:
        quiet = GAP
        for s in range(60, end - DIE):
            f = frames[s]
            if p not in f or not f[p][1]:
                quiet = GAP; continue
            me = f[p][0]
            en = [e for e in ents if team[e] != team[p] and e in f and f[e][1] and math.dist(me, f[e][0]) <= ENGAGE]
            al = [e for e in ents if e != p and team[e] == team[p] and e in f and f[e][1] and math.dist(me, f[e][0]) <= NEAR]
            if len(en) <= len(al) + 1:
                quiet += 1; continue
            if quiet < GAP:
                quiet = 0; continue
            quiet = 0
            if any(t == team[p] and math.dist(me, bp) <= 2500 for bp, t in base):
                continue
            sl = souls_at[s]
            us = sl.get(p, 0) + sum(sl.get(e, 0) for e in al)
            them = sum(sl.get(e, 0) for e in en)
            if not us or not them:
                continue
            # what they did: distance to the enemies' centre now vs CHOICE s later
            # read the move up to the last second they were alive (dying fast mustn't count as "held")
            last = s
            for u in range(s + 1, s + CHOICE + 1):
                if p in frames[u] and frames[u][p][1]: last = u
                else: break
            g = frames[last]
            def centre(fr):
                pts = [fr[e][0] for e in en if e in fr and fr[e][1]]
                return (sum(x for x, _ in pts) / len(pts), sum(y for _, y in pts) / len(pts)) if pts else None
            c0, c1 = centre(f), centre(g)
            if last >= s + 2 and c0 and c1:
                d = math.dist(g[p][0], c1) - math.dist(me, c0)
                did = 'pushed' if d < -300 else 'backed' if d > 300 else 'held'
            else:
                did = 'held'
            died = any(s < t <= s + DIE for t in deaths.get(p, []))
            out.append({'ratio': them / us, 'n': len(al) + 1, 'e': len(en), 'did': did, 'died': died,
                        'minute': s / 60})
    return out


def report():
    rows, matches = [], 0
    for mid in sorted(os.listdir(CACHE)):
        folder = os.path.join(CACHE, mid)
        if not os.path.isdir(folder) or not all(os.path.exists(os.path.join(folder, q + '.ndjson')) for q in QUERIES):
            continue
        try:
            rows += episodes(folder); matches += 1
        except Exception as ex:
            print('skip', mid, ex)
    print(f'{matches} matches, {len(rows)} outnumbered episodes\n')

    def table(title, sel):
        print(title)
        print(f'{"their souls / yours":>20} {"n":>6} {"died":>6}   {"pushed":>14} {"held":>14} {"backed off":>14}')
        res = []
        for lo, hi in zip(BUCKETS, BUCKETS[1:]):
            b = [r for r in rows if sel(r) and lo <= r['ratio'] < hi]
            if not b:
                continue
            rate = lambda xs: (sum(x['died'] for x in xs) / len(xs), len(xs)) if xs else (None, 0)
            cells = {d: rate([x for x in b if x['did'] == d]) for d in ('pushed', 'held', 'backed')}
            fmtc = lambda c: f'{c[0] * 100:5.0f}% ({c[1]:>4})' if c[1] else ' ' * 13 + '-'
            tot = rate(b)
            print(f'{lo:>9.2f}–{hi:<9.2f} {len(b):>6} {tot[0] * 100:5.0f}%   {fmtc(cells["pushed"]):>14} {fmtc(cells["held"]):>14} {fmtc(cells["backed"]):>14}')
            res.append({'lo': lo, 'hi': hi, 'n': len(b), 'died': tot[0], **{d: {'died': c[0], 'n': c[1]} for d, c in cells.items()}})
        print()
        return res

    out = {'matches': matches, 'episodes': len(rows),
           'all': table('All outnumbered episodes: chance of dying within 15 s', lambda r: True),
           'down1': table('Outnumbered by exactly one', lambda r: r['e'] - r['n'] == 1),
           'down2': table('Outnumbered by two or more', lambda r: r['e'] - r['n'] >= 2)}
    json.dump(out, open(os.path.join(HERE, 'study_out.json'), 'w'), indent=1)


if __name__ == '__main__':
    if sys.argv[1] == 'fetch':
        fetch_matches(int(sys.argv[2]), int(sys.argv[3]))
    else:
        report()
