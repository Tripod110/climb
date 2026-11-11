"""Run SQL against a match demo through deadlock-api and save the NDJSON result.
usage: python dq.py <match_id> <name> <sql-file>"""
import json, sys, time, urllib.request

UA = 'climb-model/1 (personal Deadlock tracker)'
API = 'https://api.deadlock-api.com/v1/matches/demo/query'


def req(url, body=None):
    r = urllib.request.Request(url, data=json.dumps(body).encode() if body else None,
                               headers={'User-Agent': UA, 'content-type': 'application/json'})
    try:
        with urllib.request.urlopen(r, timeout=120) as f:
            return f.read()
    except urllib.error.HTTPError as e:
        sys.exit(f'HTTP {e.code}: {e.read().decode()[:1500]}')


mid, name, qf = int(sys.argv[1]), sys.argv[2], sys.argv[3]
q = open(qf, encoding='utf-8').read()
job = json.loads(req(API, {'match_id': mid, 'query': q, 'format': 'ndjson'}))
jid = job.get('job_id')
print('job', jid, {k: v for k, v in job.items() if k != 'job_id'})
for _ in range(60):
    s = json.loads(req(f'{API}/{jid}'))
    st = str(s.get('status', '')).lower()
    if st not in ('queued', 'pending', 'running', 'processing', 'in_progress', 'started'):
        break
    time.sleep(3)
print('status', {k: v for k, v in s.items() if k not in ('result',)})
url = s.get('result_url') or s.get('url') or (s.get('result') or {}).get('url')
if not url:
    sys.exit('no result url')
data = urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': UA}), timeout=300).read()
if url.endswith('.zst'):
    from compression import zstd
    data = zstd.decompress(data)
open(name + '.ndjson', 'wb').write(data)
print('rows', data.count(b'\n'), 'bytes', len(data))
