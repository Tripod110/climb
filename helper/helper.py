"""Climb helper: logs when Deadlock is running and serves that log to Climb.

Phase 1 of the play-time tracker. Two jobs, nothing else:

1. Every POLL_S seconds, ask Windows whether deadlock.exe is running (tasklist; the game is never
   touched, so this is anti-cheat safe). Runs of "running" become sessions {start, end}.
2. Serve the log read-only on http://127.0.0.1:PORT/sessions for Climb to fetch.

Stdlib only. Run it with pythonw.exe so there's no console window; install-task.ps1 sets that up
at logon. The log lives in %LOCALAPPDATA%\\climb-helper\\sessions.json and is the source of
truth; Climb only reads it.

Security: binds 127.0.0.1 only, answers GET only, sends CORS headers only to Climb's own
origins, and rejects any Host header that isn't localhost (stops DNS-rebinding pages from
reading it). The data is only play times, but it's still nobody else's business.
"""
import json
import os
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 47615
POLL_S = 15
# A gap shorter than this (crash + relaunch, helper restart) continues the same session.
MERGE_GAP_S = 180
PROCESS = 'deadlock.exe'
ORIGINS = {
    'https://tripod110.github.io',
    'http://localhost:5179',
    'http://127.0.0.1:5179',
}
HOSTS = {f'127.0.0.1:{PORT}', f'localhost:{PORT}'}

DIR = os.path.join(os.environ.get('LOCALAPPDATA') or os.path.expanduser('~'), 'climb-helper')
LOG = os.path.join(DIR, 'sessions.json')
ERR = os.path.join(DIR, 'helper.log')

lock = threading.Lock()
state = {'sessions': [], 'playing': False, 'since': None}


def note(msg):
    try:
        with open(ERR, 'a', encoding='utf-8') as f:
            f.write(time.strftime('%Y-%m-%d %H:%M:%S ') + msg + '\n')
    except OSError:
        pass


def load():
    try:
        with open(LOG, encoding='utf-8') as f:
            data = json.load(f)
    except (OSError, ValueError):
        data = {}
    sessions = [s for s in data.get('sessions', []) if isinstance(s.get('start'), (int, float))]
    # A session left open by a crash/shutdown is closed at the last time it was seen running.
    # (If the game is still running, the first poll reopens it via MERGE_GAP_S.)
    for s in sessions:
        if 'seen' in s:
            s['end'] = s.pop('seen')
    return data.get('since'), sessions


def save():
    os.makedirs(DIR, exist_ok=True)
    tmp = LOG + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump({'since': state['since'], 'sessions': state['sessions']}, f)
    os.replace(tmp, LOG)


def deadlock_running():
    out = subprocess.run(
        ['tasklist', '/FI', f'IMAGENAME eq {PROCESS}', '/FO', 'CSV', '/NH'],
        capture_output=True, text=True, timeout=10,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
    ).stdout
    return PROCESS.lower() in out.lower()


def tick(now, running):
    """Advance the session log by one poll. Pure apart from `state`, so it's easy to reason about:
    an open session is the last one with 'seen' set; 'end' is filled in when the game closes."""
    ss = state['sessions']
    last = ss[-1] if ss else None
    if running:
        if last is not None and 'seen' in last:
            last['seen'] = now
        elif last is not None and now - last['end'] <= MERGE_GAP_S:
            last['seen'] = now          # relaunch shortly after closing: same session
            last.pop('end', None)
        else:
            ss.append({'start': now, 'seen': now})
        state['playing'] = True
    else:
        if last is not None and 'seen' in last:
            last['end'] = last.pop('seen')
        state['playing'] = False


def snapshot():
    """Sessions as Climb sees them: closed ones have 'end'; the open one has end = null."""
    out = []
    for s in state['sessions']:
        out.append({'start': s['start'], 'end': s.get('end') if 'seen' not in s else None})
    return out


def watch():
    while True:
        try:
            running = deadlock_running()
            with lock:
                tick(int(time.time()), running)
                save()  # 'seen' is persisted too, so a crash loses at most one poll
        except Exception as e:  # never let one bad poll kill the watcher
            note('poll failed: %r' % (e,))
        time.sleep(POLL_S)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _cors(self):
        origin = self.headers.get('Origin')
        if origin in ORIGINS:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
            # Chrome's Private/Local Network Access preflight for https page -> localhost.
            if self.headers.get('Access-Control-Request-Private-Network'):
                self.send_header('Access-Control-Allow-Private-Network', 'true')

    def _refuse(self, code):
        self.send_response(code)
        self.send_header('Content-Length', '0')
        self.end_headers()

    def _allowed(self):
        if self.headers.get('Host') not in HOSTS:
            return False
        origin = self.headers.get('Origin')
        return origin is None or origin in ORIGINS

    def do_OPTIONS(self):
        if not self._allowed():
            return self._refuse(403)
        self.send_response(204)
        self._cors()
        self.send_header('Access-Control-Allow-Methods', 'GET')
        self.send_header('Access-Control-Max-Age', '600')
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_GET(self):
        if not self._allowed():
            return self._refuse(403)
        if self.path.split('?')[0] != '/sessions':
            return self._refuse(404)
        with lock:
            body = json.dumps({
                'now': int(time.time()), 'poll': POLL_S, 'since': state['since'],
                'playing': state['playing'], 'sessions': snapshot(),
            }).encode()
        self.send_response(200)
        self._cors()
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    os.makedirs(DIR, exist_ok=True)
    try:
        server = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    except OSError:
        sys.exit(0)  # port taken: another helper is already running, which is fine
    since, sessions = load()
    state['since'] = since or int(time.time())  # when tracking began; Climb trusts API data before it
    state['sessions'] = sessions
    save()
    threading.Thread(target=watch, daemon=True).start()
    note('started')
    server.serve_forever()


if __name__ == '__main__':
    main()
