"""Which habits actually raise win rate, for every hero and every rank? (Climb's habit study.)

Reads ranked matches from deadlock-api's public data lake (data.deadlock-api.com, hourly Parquet files,
DuckDB over HTTPS, only the needed columns), turns each player-game into a row of candidate rules
checked before the game is decided, and measures each rule's effect on winning.

The comparison that matters is WITHIN a player: their games where they kept the rule vs their games where
they didn't. Comparing different players would credit the rule with plain skill (good players die less AND
win more). Rules from 9:00 to 20:00 are also compared from the same team souls position at 9:00, so a rule
isn't credited with a lead the lane phase already built.

A rule is only worth teaching if its effect is positive in every rank band, on most heroes, and in both
random halves of the players. Output: model/habits_out.json (+ a printed table).

    model/.venv/Scripts/python -I model/habits.py --files 50
"""
import argparse, datetime as dt, json, os, time, urllib.request, zlib
from collections import defaultdict

import duckdb
import numpy as np

LAKE = 'https://data.deadlock-api.com'
API = 'https://api.deadlock-api.com'
UA = {'User-Agent': 'climb-model/1 (personal Deadlock tracker)'}
HERE = os.path.dirname(os.path.abspath(__file__))
LANE_END, MID_END, FAST_DEATH_S, LONE_S = 540, 1200, 5, 10

BANDS = [('Calibrating', 0, 0), ('Initiate–Seeker', 1, 2), ('Acolyte–Sentinel', 3, 4), ('Mystic–Ritualist', 5, 6),
         ('Emissary–Oracle', 7, 8), ('Phantom–Eternus', 9, 11)]

# id, label, window ('lane' = checked at 9:00; 'mid' = 9:00-20:00, compared from the same 9:00 team position)
RULES = [
    ('lane_nodeath', 'No deaths before 9:00', 'lane'),
    ('lane_le1', 'At most 1 death before 9:00', 'lane'),
    ('lane_souls', 'Souls ≥ your lane opponents at 9:00', 'lane'),
    ('lane_lh', 'Last hits ≥ your lane opponents at 9:00', 'lane'),
    ('lane_cs80', 'Last-hit 80%+ of the creeps you could reach by 9:00', 'lane'),
    ('lane_denies', 'Denies ≥ your lane opponents at 9:00', 'lane'),
    ('lane_jungle', 'Jungle souls ≥ your lane opponents at 9:00', 'lane'),
    ('mid_nocaught', 'No caught-out deaths (killed within 5s) before 20:00', 'mid'),
    ('mid_nolone', 'No lone deaths 9:00–20:00 (nobody else died within 10s)', 'mid'),
    ('mid_nodeep', 'No deaths in the enemy half 9:00–20:00', 'mid'),
    ('mid_le2', 'At most 2 deaths 9:00–20:00', 'mid'),
    ('mid_bank', 'Souls lost to deaths by 20:00 ≤ the lobby median', 'mid'),
    ('mid_obj', 'Objective damage by 20:00 ≥ the lobby average', 'mid'),
    ('mid_acc', 'Accuracy by 20:00 ≥ the lobby average', 'mid'),
    ('mid_t3', 'First tier-3 item before 13:00', 'mid'),
]
RID = [r[0] for r in RULES]


def get_json(url):
    return json.load(urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60))


def at(ts, arr, t):
    """Value of a cumulative stat at time t (last snapshot at or before t)."""
    v = 0
    for x, y in zip(ts or [], arr or []):
        if x <= t: v = y
        else: break
    return v or 0


def team_of(t):
    return 1 if str(t).endswith('1') else 0


def features(match, tier3):
    """One match (list of player dicts) -> [(account, hero, won, tier, gap9, {rule: 0/1/None})]."""
    out = []
    deaths_all = sorted(t for p in match for t in (p['dts'] or []))
    for p in match:
        p['tm'] = team_of(p['team'])
    souls9 = defaultdict(float)
    for p in match: souls9[p['tm']] += at(p['ts'], p['nw'], LANE_END)
    long_game = match[0]['dur'] >= MID_END
    lob = lambda f: [f(q) for q in match]
    for p in match:
        ts, me = p['ts'], p['tm']
        opps = [q for q in match if q['tm'] != me and q['lane'] == p['lane'] and p['lane']]
        dts, ttk, pos = [t for t in (p['dts'] or []) if t is not None], p['ttk'] or [], p['pos'] or []
        r = {}
        d9 = sum(1 for t in dts if t < LANE_END)
        r['lane_nodeath'] = int(d9 == 0)
        r['lane_le1'] = int(d9 <= 1)
        om = lambda f: float(np.mean([f(q) for q in opps])) if opps else None
        def vs(f):
            o = om(f)
            return None if o is None else int(f(p) >= o)
        r['lane_souls'] = vs(lambda q: at(q['ts'], q['nw'], LANE_END))
        r['lane_lh'] = vs(lambda q: at(q['ts'], q['ck'], LANE_END))
        pc = at(ts, p['pc'], LANE_END)
        r['lane_cs80'] = int(at(ts, p['ck'], LANE_END) >= 0.8 * pc) if pc else None
        r['lane_denies'] = vs(lambda q: at(q['ts'], q['dn'], LANE_END))
        r['lane_jungle'] = vs(lambda q: at(q['ts'], q['jg'], LANE_END) + at(q['ts'], q['jgo'], LANE_END))
        if long_game:
            mid = [i for i, t in enumerate(dts) if LANE_END <= t < MID_END]
            r['mid_nocaught'] = int(not any(t < MID_END and 0 < k <= FAST_DEATH_S for t, k in zip(dts, [x or 0 for x in ttk])))
            others = deaths_all.copy()
            for t in dts: others.remove(t)
            r['mid_nolone'] = int(not any(not any(abs(o - dts[i]) <= LONE_S for o in others) for i in mid))
            def deep(i):
                if i >= len(pos) or not pos[i]: return False
                y = pos[i].get('2', pos[i].get(2, 0)) or 0
                return (y > 1500) if me == 0 else (y < -1500)
            r['mid_nodeep'] = int(not any(deep(i) for i in mid))
            r['mid_le2'] = int(len(mid) <= 2)
            loss = lob(lambda q: at(q['ts'], q['dl'], MID_END))
            r['mid_bank'] = int(at(ts, p['dl'], MID_END) <= float(np.median(loss)))
            obj = lob(lambda q: at(q['ts'], q['bd'], MID_END))
            r['mid_obj'] = int(at(ts, p['bd'], MID_END) >= float(np.mean(obj)))
            acc = lambda q: (lambda h, m: h / (h + m) if h + m else None)(at(q['ts'], q['sh'], MID_END), at(q['ts'], q['sm'], MID_END))
            accs = [a for a in lob(acc) if a is not None]
            r['mid_acc'] = None if acc(p) is None or not accs else int(acc(p) >= float(np.mean(accs)))
            buys = [t for t, i in zip(p['it'] or [], p['ii'] or []) if tier3.get(i, 0) >= 3]
            r['mid_t3'] = int(bool(buys) and min(buys) < 780)
        else:
            for k in RID:
                if k.startswith('mid_'): r[k] = None
        tier = (p['rank'] or 0) // 10
        if tier <= 0 and p['avg']: tier = -((p['avg'] or 0) // 10)   # calibrating: keep the lobby's tier for reference, negative
        gap9 = souls9[me] - souls9[1 - me]
        out.append((p['acct'], p['hero'], bool(p['won']), tier, gap9, r))
    return out


def load(nfiles, cache):
    if os.path.exists(cache):
        return json.load(open(cache))
    tier3 = {i['id']: i.get('item_tier') or 0 for i in get_json(API + '/v1/assets/items/by-type/upgrade')}
    man = get_json(LAKE + '/v1/manifest.json')
    files = [f for f in man['tables']['match_player']['files'] if '/delta/' in f['key']][-nfiles:]
    con = duckdb.connect(); con.execute('INSTALL httpfs; LOAD httpfs;')
    rows = []
    for n, f in enumerate(files):
        t0 = time.time()
        q = con.execute(f"""
          SELECT match_id, account_id, hero_id, won, team, assigned_lane, duration_s, average_badge,
                 player_rank_initial_display_rank,
                 "stats.time_stamp_s", "stats.net_worth", "stats.creep_kills", "stats.possible_creeps", "stats.denies",
                 "stats.gold_neutral_creep", "stats.gold_neutral_creep_orbs", "stats.gold_death_loss", "stats.boss_damage",
                 "stats.shots_hit", "stats.shots_missed",
                 "death_details.game_time_s", "death_details.time_to_kill_s", "death_details.death_pos",
                 "items.game_time_s", "items.item_id"
          FROM read_parquet('{LAKE}/{f['key']}')
          WHERE match_mode = 'Ranked' AND game_mode = 'Normal' AND abandon_match_time_s = 0 AND duration_s >= 900
        """).fetchall()
        by = defaultdict(list)
        for x in q:
            by[x[0]].append(dict(acct=x[1], hero=x[2], won=x[3], team=x[4], lane=x[5], dur=x[6], avg=x[7], rank=x[8],
                ts=x[9], nw=x[10], ck=x[11], pc=x[12], dn=x[13], jg=x[14], jgo=x[15], dl=x[16], bd=x[17], sh=x[18], sm=x[19],
                dts=x[20], ttk=x[21], pos=x[22], it=x[23], ii=x[24]))
        for mid, ps in by.items():
            if len(ps) != 12: continue
            for a, h, w, tier, gap9, r in features(ps, tier3):
                rows.append([a, h, int(w), tier, gap9, [r[k] for k in RID]])
        print(f'file {n + 1}/{len(files)}: {len(by)} matches, {len(rows):,} player-games so far ({time.time() - t0:.0f}s)', flush=True)
    os.makedirs(os.path.dirname(cache), exist_ok=True)
    json.dump(rows, open(cache, 'w'))
    return rows


def within(acct, won, passed, w8=None):
    """Within-player effect: per account, win rate when kept minus when not, weighted by n_pass*n_fail/(n_pass+n_fail)."""
    g = defaultdict(lambda: [0.0, 0, 0.0, 0])   # pass wins, pass n, fail wins, fail n
    for a, y, p in zip(acct, won, passed):
        s = g[a]
        if p: s[0] += y; s[1] += 1
        else: s[2] += y; s[3] += 1
    num = den = 0.0; players = 0
    for s in g.values():
        if s[1] and s[3]:
            wt = s[1] * s[3] / (s[1] + s[3])
            num += wt * (s[0] / s[1] - s[2] / s[3]); den += wt; players += 1
    return (num / den if den else None), players


def main():
    import sys; sys.stdout.reconfigure(encoding='utf-8')
    ap = argparse.ArgumentParser()
    ap.add_argument('--files', type=int, default=50)
    ap.add_argument('--fresh', action='store_true', help='ignore the cached player-games')
    a = ap.parse_args()
    cache = os.path.join(HERE, '.cache', f'habits_{a.files}.json')
    if a.fresh and os.path.exists(cache): os.remove(cache)
    rows = load(a.files, cache)
    acct = np.array([r[0] for r in rows]); hero = np.array([r[1] for r in rows]); won = np.array([r[2] for r in rows], float)
    tier = np.array([r[3] for r in rows]); gap9 = np.array([r[4] for r in rows], float)
    R = np.array([[np.nan if v is None else v for v in r[5]] for r in rows], float)
    # Outcome relative to the 9:00 team position (for 'mid' rules): won minus the win rate of that souls-gap bucket.
    bucket = np.clip(np.round(gap9 / 1500), -8, 8)
    base = {b: won[bucket == b].mean() for b in np.unique(bucket)}
    won_mid = won - np.array([base[b] for b in bucket])
    half = np.array([zlib.crc32(str(x).encode()) % 2 for x in acct])
    band_of = lambda t: next((b[0] for b in BANDS if b[1] <= t <= b[2]), 'Calibrating') if t > 0 else 'Calibrating'
    band = np.array([band_of(t) for t in tier])
    print(f'{len(rows):,} player-games, {len(set(acct)):,} players, {len(rows) // 12:,} matches')
    out = {'made': dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds'), 'files': a.files, 'player_games': len(rows),
           'players': int(len(set(acct))), 'rules': []}
    for j, (rid, label, win) in enumerate(RULES):
        ok = ~np.isnan(R[:, j]); p = R[:, j] == 1
        y = (won_mid if win == 'mid' else won)
        eff, players = within(acct[ok], y[ok], p[ok])
        naive = won[ok & p].mean() - won[ok & ~p].mean()
        halves = [within(acct[ok & (half == h)], y[ok & (half == h)], p[ok & (half == h)])[0] for h in (0, 1)]
        bands = {}
        for b, _, _ in BANDS:
            m = ok & (band == b)
            if m.sum() > 2000: bands[b] = within(acct[m], y[m], p[m])[0]
        heroes = []
        for h in np.unique(hero[ok]):
            m = ok & (hero == h)
            if (m & p).sum() >= 300 and (m & ~p).sum() >= 300:
                heroes.append(within(acct[m], y[m], p[m])[0])
        heroes = [x for x in heroes if x is not None]
        rec = dict(id=rid, label=label, window=win, n=int(ok.sum()), pass_rate=float(p[ok].mean()), effect=eff,
                   naive=float(naive), players=players, halves=halves, bands=bands,
                   heroes_positive=(sum(1 for x in heroes if x > 0) / len(heroes)) if heroes else None, heroes_checked=len(heroes))
        rec['passes'] = bool(eff is not None and eff >= 0.02 and all(x is not None and x > 0 for x in halves)
                             and all(v is None or v > 0 for v in bands.values()) and (rec['heroes_positive'] or 0) >= 0.75)
        out['rules'].append(rec)
    out['rules'].sort(key=lambda r: -(r['effect'] or -1))
    json.dump(out, open(os.path.join(HERE, 'habits_out.json'), 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
    pc = lambda v: '   —' if v is None else f'{v * 100:+5.1f}'
    print(f"\n{'rule':58} {'keep':>5} {'effect':>6} {'naive':>6} {'halves':>12} {'heroes+':>7}  bands")
    for r in out['rules']:
        hp = '—' if r['heroes_positive'] is None else f"{r['heroes_positive'] * 100:.0f}%"
        bands = ' '.join(f"{k.split('–')[0][:4]} {pc(v)}" for k, v in r['bands'].items())
        print(f"{'✓' if r['passes'] else ' '} {r['label'][:56]:56} {r['pass_rate'] * 100:4.0f}% {pc(r['effect'])} {pc(r['naive'])} "
              f"{pc(r['halves'][0])}/{pc(r['halves'][1])} {hp:>7}  {bands}")


if __name__ == '__main__':
    main()
