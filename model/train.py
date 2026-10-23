"""Train Climb's win-chance model and death-cost table from deadlock-api's public data lake.

Run it after each big patch (or whenever), then commit js/wpmodel.js:

    python -m venv model/.venv
    model/.venv/Scripts/python -m pip install -r model/requirements.txt
    model/.venv/Scripts/python model/train.py            # default: the newest 36 hourly files
    model/.venv/Scripts/python model/train.py --files 12 # quicker, smaller sample

What it learns (validated on held-out matches, printed at the end):
  1. Win chance at each snapshot minute from the team-vs-team gaps in souls, kills, objectives
     destroyed and mid-boss claims: a logistic model per minute. It is symmetric (no intercept),
     because "Team0" vs "Team1" carries no information.
  2. What a death usually costs: in snapshot windows where exactly ONE player in the whole
     lobby died, how far that player's team fell behind in souls over the window (median),
     bucketed by minute and by how rich the victim was vs the lobby. That's the measured total:
     the killers' bounty plus the farm missed while dead. Early on it's roughly the bounty, but
     after ~20 min it's about twice the bounty, because respawns get long (seen 2026-10-23 on
     ~45k matches). The bounty alone is kept in the output for reference.
  3. How much more often your team loses an objective in the 90s after a death than at a random
     moment.

Only the needed Parquet columns are read over HTTPS, so ~36 files (~400k matches) take a few
minutes and a few hundred MB of traffic. Output: js/wpmodel.js (window.WPMODEL = {...}, ~3 KB).
It's a script, not JSON, because Climb's CSP allows scripts from 'self' but no fetches to it."""
import argparse, json, time, urllib.request, datetime as dt
from collections import defaultdict
import duckdb
import numpy as np

LAKE = 'https://data.deadlock-api.com'
TIMES = [180, 360, 540, 720, 900, 1200, 1500, 1800, 2100, 2400, 2700, 3000, 3300, 3600]
MIN_BUCKETS = [(0, 360), (360, 720), (720, 1200), (1200, 1800), (1800, 99999)]
SHARE_BUCKETS = [(0, 0.8), (0.8, 1.2), (1.2, 99)]
SCALE = np.array([10000.0, 10.0, 1.0, 1.0])   # souls, kills, objectives, mid-boss -> model units
FEATURES = ['souls', 'kills', 'objectives', 'midboss']


def get_json(url):
    # deadlock-api sits behind Cloudflare, which refuses Python's default user agent.
    req = urllib.request.Request(url, headers={'User-Agent': 'climb-model/1 (personal Deadlock tracker)'})
    return json.load(urllib.request.urlopen(req, timeout=60))


def fit_logistic(X, y, l2=1e-3, iters=50):
    """Newton/IRLS logistic regression without intercept. Small and dependency-free."""
    w = np.zeros(X.shape[1])
    for _ in range(iters):
        p = 1 / (1 + np.exp(-X @ w))
        g = X.T @ (p - y) + l2 * w
        H = (X * (p * (1 - p))[:, None]).T @ X + l2 * np.eye(len(w))
        step = np.linalg.solve(H, g)
        w -= step
        if np.abs(step).max() < 1e-8:
            break
    return w


def auc(y, s):
    order = np.argsort(s); r = np.empty(len(s)); r[order] = np.arange(1, len(s) + 1)
    pos = y == 1
    return (r[pos].sum() - pos.sum() * (pos.sum() + 1) / 2) / (pos.sum() * (~pos).sum())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--files', type=int, default=36, help='newest hourly delta files to use')
    ap.add_argument('--out', default=__file__.replace('model\\train.py', 'js\\wpmodel.js').replace('model/train.py', 'js/wpmodel.js'))
    a = ap.parse_args()

    manifest = get_json(LAKE + '/v1/manifest.json')
    deltas = [f for f in manifest['tables']['match_player']['files'] if '/delta/' in f['key']][-a.files:]
    urls = [LAKE + '/' + f['key'] for f in deltas]
    patches = get_json('https://api.deadlock-api.com/v1/patches/big-days')
    patch_t = max(dt.datetime.fromisoformat(p.replace('Z', '+00:00')).timestamp() for p in patches if dt.datetime.fromisoformat(p.replace('Z', '+00:00')).timestamp() < time.time())
    print(f'{len(urls)} files, ~{sum(f["rows"] for f in deltas) // 12:,} matches; last big patch {dt.datetime.fromtimestamp(patch_t, dt.timezone.utc):%Y-%m-%d}')

    con = duckdb.connect()
    con.execute('INSTALL httpfs; LOAD httpfs;')
    t0 = time.time()
    rows = con.execute(f"""
      SELECT match_id, team, winning_team, duration_s, epoch(start_time) AS st,
             "stats.time_stamp_s" AS ts, "stats.net_worth" AS nw, "stats.kills" AS k,
             "stats.gold_player" AS gp, "stats.gold_player_orbs" AS gpo,
             "death_details.game_time_s" AS dts,
             "objectives.destroyed_time_s" AS odt, "objectives.team" AS oteam,
             "mid_boss.team_claimed" AS mbt, "mid_boss.destroyed_time_s" AS mbd
      FROM read_parquet({urls})
      WHERE game_mode = 'Normal' AND abandon_match_time_s = 0 AND epoch(start_time) >= {patch_t}
    """).fetchall()
    print(f'{len(rows):,} player rows in {time.time() - t0:.0f}s')

    by_match = defaultdict(list)
    for r in rows:
        by_match[r[0]].append(r)

    def at(ts, arr, t):
        v = 0
        for x, y in zip(ts, arr):
            if x <= t: v = y
            else: break
        return v

    samples = defaultdict(list)          # t -> [(features team0-team1, won0, match)]
    bounty = defaultdict(list)           # (minute bucket, share bucket) -> [enemy gain]
    iso_check = defaultdict(list)        # minute bucket -> [(estimate, actual gap change)]
    obj_after, obj_base = defaultdict(lambda: [0, 0]), defaultdict(lambda: [0, 0])
    rng = np.random.default_rng(0)
    for mid, ps in by_match.items():
        if len(ps) != 12 or {p[1] for p in ps} != {'Team0', 'Team1'}:
            continue
        win0 = 1 if ps[0][2] == 'Team0' else 0
        dur = ps[0][3]
        objs = [(t, tm) for t, tm in zip(ps[0][11] or [], ps[0][12] or []) if t]
        mbs = [(t, tm) for t, tm in zip(ps[0][14] or [], ps[0][13] or []) if t]
        team = lambda tm: [p for p in ps if p[1] == tm]
        T0, T1 = team('Team0'), team('Team1')
        for t in TIMES:
            if t > dur:
                break
            souls = sum(at(p[5], p[6], t) for p in T0) - sum(at(p[5], p[6], t) for p in T1)
            kills = sum(at(p[5], p[7], t) for p in T0) - sum(at(p[5], p[7], t) for p in T1)
            objd = sum(1 for x, tm in objs if x <= t and tm == 'Team1') - sum(1 for x, tm in objs if x <= t and tm == 'Team0')
            mbd = sum(1 for x, tm in mbs if x <= t and tm == 'Team0') - sum(1 for x, tm in mbs if x <= t and tm == 'Team1')
            samples[t].append(([souls, kills, objd, mbd], win0, mid))
        # deaths: isolated windows -> bounty; objective follow-up rates
        ts = ps[0][5] or []
        deaths = [(d, p) for p in ps for d in (p[10] or [])]
        for d, p in deaths:
            mb = next(i for i, (lo, hi) in enumerate(MIN_BUCKETS) if lo <= d < hi)
            c = obj_after[mb]; c[1] += 1; c[0] += any(p[1] == tm and d < x <= d + 90 for x, tm in objs)
        for _ in range(4):
            g = rng.uniform(120, max(121, dur - 90)); tm = 'Team0' if rng.random() < .5 else 'Team1'
            mb = next(i for i, (lo, hi) in enumerate(MIN_BUCKETS) if lo <= g < hi)
            c = obj_base[mb]; c[1] += 1; c[0] += any(tm == tm2 and g < x <= g + 90 for x, tm2 in objs)
        for i in range(1, len(ts)):
            lo, hi = ts[i - 1], ts[i]
            inside = [(d, p) for d, p in deaths if lo < d <= hi]
            if len(inside) != 1:
                continue
            d, victim = inside[0]
            if len(victim[6]) <= i:
                continue
            avg = np.mean([p[6][i - 1] for p in ps if len(p[6]) > i])
            share = victim[6][i - 1] / max(1.0, avg)
            enemies = [p for p in ps if p[1] != victim[1] and len(p[8]) > i]
            gain = sum((p[8][i] + p[9][i]) - (p[8][i - 1] + p[9][i - 1]) for p in enemies)
            mb = next(k for k, (a_, b_) in enumerate(MIN_BUCKETS) if a_ <= d < b_)
            sb = next(k for k, (a_, b_) in enumerate(SHARE_BUCKETS) if a_ <= share < b_)
            bounty[(mb, sb)].append(gain)
            own = [p for p in ps if p[1] == victim[1] and len(p[6]) > i]
            gap_change = (sum(p[6][i] - p[6][i - 1] for p in own) - sum(p[6][i] - p[6][i - 1] for p in enemies))
            iso_check[(mb, sb)].append(gap_change)

    # ---- win model per minute, split by match
    model = {}
    report = []
    for t in TIMES:
        S = samples.get(t, [])
        if len(S) < 2000:
            continue
        X = np.array([s[0] for s in S], float) / SCALE; y = np.array([s[1] for s in S], float); M = np.array([s[2] for s in S])
        test = (M % 5) == 0
        Xs = np.vstack([X[~test], -X[~test]]); ys = np.concatenate([y[~test], 1 - y[~test]])   # mirror: no team bias
        w = fit_logistic(Xs, ys)
        p = 1 / (1 + np.exp(-X[test] @ w))
        bins = np.clip((p * 10).astype(int), 0, 9)
        cal = max(abs(p[bins == b].mean() - y[test][bins == b].mean()) for b in range(10) if (bins == b).sum() > 50)
        model[t] = [round(float(v), 5) for v in w]
        report.append((t, len(S), auc(y[test], p), cal, float(((p > 0.5) == (y[test] == 1)).mean())))

    # ---- death-cost tables
    def table(src, sign):
        t = [[int(sign * np.median(src[(i, j)])) if len(src[(i, j)]) >= 30 else None for j in range(len(SHARE_BUCKETS))] for i in range(len(MIN_BUCKETS))]
        for i in range(len(MIN_BUCKETS)):   # fill thin cells from the row's middle bucket
            mid_v = t[i][1] or next((v for v in t[i] if v), None)
            t[i] = [v if v is not None else mid_v for v in t[i]]
        return t
    bt = table(bounty, 1)
    cost = table(iso_check, -1)
    n_iso = [[len(iso_check[(i, j)]) for j in range(len(SHARE_BUCKETS))] for i in range(len(MIN_BUCKETS))]
    obj_lift = [round(obj_after[i][0] / max(1, obj_after[i][1]) - obj_base[i][0] / max(1, obj_base[i][1]), 3) for i in range(len(MIN_BUCKETS))]

    out = {
        'version': 1,
        'trained_at': dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%MZ'),
        'patch': dt.datetime.fromtimestamp(patch_t, dt.timezone.utc).strftime('%Y-%m-%d'),
        'matches': len(by_match),
        'features': FEATURES, 'scale': SCALE.tolist(),
        'win': {str(t): w for t, w in model.items()},
        'death': {
            'minute_buckets': MIN_BUCKETS[:-1] + [[MIN_BUCKETS[-1][0], None]],
            'share_buckets': [list(b) for b in SHARE_BUCKETS[:-1]] + [[SHARE_BUCKETS[-1][0], None]],
            'cost': cost,
            'bounty': bt,
            'samples': n_iso,
            'objective_lift_90s': obj_lift,
        },
        'quality': {str(t): {'n': n, 'auc': round(float(au), 3), 'accuracy': round(acc, 3), 'max_calibration_error': round(float(c), 3)} for t, n, au, c, acc in report},
    }
    with open(a.out, 'w', encoding='utf-8', newline='\n') as f:
        f.write('/* Generated by model/train.py: do not edit by hand. Win-chance model + death-cost table,\n'
                '   trained on deadlock-api data-lake matches. Re-run the script after a big patch. */\n')
        f.write('window.WPMODEL = ' + json.dumps(out, separators=(',', ':')) + ';\n')

    print('\nminute  games    AUC   favourite wins   worst calibration gap')
    for t, n, au, c, acc in report:
        print(f'{t // 60:>5}m  {n:>7,}  {au:.3f}  {acc:.1%}            {c:.3f}')
    print('\nCost of a death in team souls (measured) | bounty only | isolated deaths, by victim souls vs lobby (<80%, 80-120%, >120%):')
    for (lo, hi), row, brow, nrow in zip(MIN_BUCKETS, cost, bt, n_iso):
        print(f'  {lo // 60:>2}-{"+" if hi > 9000 else hi // 60} min: {row} | {brow} | n={nrow}')
    print('Own objective lost within 90s after a death, minus a random moment:', obj_lift)
    print(f'\nWrote {a.out}')


if __name__ == '__main__':
    main()
