"""Fetch one match's replay data from deadlock-api and pack it for the review page.

usage: python fetch.py <match_id> <account_id>
Runs the q_*.sql queries against the match's demo (cached in cache/<match>/), then writes
../matches/<match>.js. Needs Python 3.14+ (compression.zstd)."""
import json, os, sys, time, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor
from compression import zstd

HERE = os.path.dirname(os.path.abspath(__file__))
UA = 'climb-model/1 (personal Deadlock tracker)'
API = 'https://api.deadlock-api.com/v1/matches/demo/query'
QUERIES = ['map', 'rules', 'pawns', 'players', 'kills', 'obj', 'troop', 'fow']


def req(url, body=None):
    r = urllib.request.Request(url, data=json.dumps(body).encode() if body else None,
                               headers={'User-Agent': UA, 'content-type': 'application/json'})
    with urllib.request.urlopen(r, timeout=300) as f:
        return f.read()


def run(mid, name, folder):
    out = os.path.join(folder, name + '.ndjson')
    if os.path.exists(out):
        return name, 'cached'
    q = open(os.path.join(HERE, f'q_{name}.sql'), encoding='utf-8').read()
    for attempt in range(3):
        try:
            job = json.loads(req(API, {'match_id': mid, 'query': q, 'format': 'ndjson'}))
            for _ in range(100):
                s = json.loads(req(f"{API}/{job['job_id']}"))
                if s.get('status') in ('done', 'failed', 'error'):
                    break
                time.sleep(3)
            if s.get('status') != 'done':
                raise RuntimeError(f'{name}: {s}')
            data = req(s['result_url'])
            if s['result_url'].endswith('.zst'):
                data = zstd.decompress(data)
            open(out, 'wb').write(data)
            return name, f'{data.count(b"\n")} rows'
        except (urllib.error.HTTPError, RuntimeError) as e:
            err = e.read().decode()[:300] if isinstance(e, urllib.error.HTTPError) else str(e)
            if attempt == 2:
                return name, 'FAILED ' + err
            time.sleep(5)


if __name__ == '__main__':
    mid, account = int(sys.argv[1]), int(sys.argv[2])
    folder = os.path.join(HERE, 'cache', str(mid))
    os.makedirs(folder, exist_ok=True)
    with ThreadPoolExecutor(4) as ex:
        for name, msg in ex.map(lambda n: run(mid, n, folder), QUERIES):
            print(f'  {name}: {msg}')
    import build
    os.makedirs(os.path.join(HERE, '..', 'matches'), exist_ok=True)
    build.build(mid, account, folder, os.path.join(HERE, '..', 'matches', f'{mid}.js'))
