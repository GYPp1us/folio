#!/usr/bin/env python3
"""Loopback-only Docker service gateway. No shell, arbitrary destination or host mount API."""
import http.server, http.client, json, os, re, select, socket, subprocess, threading, time, secrets
from urllib.parse import urlsplit

TOKEN = '/etc/cc-sandbox/token'
PREFIX = 'folio-report-'
ID = re.compile(r'^[a-f0-9-]{36}$')
REPO = re.compile(r'^[a-z0-9][a-z0-9_-]{0,47}$')
LOCK = threading.Lock()

def docker(args):
    p = subprocess.run(['docker', *args], capture_output=True, timeout=40)
    if p.returncode: raise ValueError('Container operation failed')
    return p.stdout + p.stderr if args[0] == 'logs' else p.stdout

def inspect(id):
    if not ID.fullmatch(id): raise ValueError('Invalid publication')
    return json.loads(docker(['inspect', PREFIX + id]))[0]

def owned(id):
    info = inspect(id)
    if info['Config'].get('Labels', {}).get('folio.publication') != id: raise ValueError('Unknown publication')
    return info

def target(id):
    info = owned(id)
    if not info['State']['Running']: raise ValueError('Service is stopped')
    labels = info['Config']['Labels']
    if float(labels['folio.expires']) < time.time(): raise ValueError('Service expired')
    return info['NetworkSettings']['Networks']['cc-sandbox']['IPAddress'], int(labels['folio.port'])

class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def log_message(self, *args): pass
    def auth(self):
        try:
            token = open(TOKEN).read().strip()
            return bool(token) and secrets.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + token)
        except OSError: return False
    def answer(self, code, data):
        body = json.dumps(data).encode()
        self.send_response(code); self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_POST(self):
        if not self.auth(): return self.answer(401, {'error': 'Unauthorized'})
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if size > 12000: raise ValueError('Body too large')
            b = json.loads(self.rfile.read(size))
            if self.path in ('/network/cut', '/network/restore'):
                repo = b['repo']
                if not REPO.fullmatch(repo): raise ValueError('Invalid repository')
                names = docker(['ps', '-aq', '--filter', 'label=folio.repo=' + repo]).splitlines()
                for name in names:
                    info = json.loads(docker(['inspect', name.decode()]))[0]
                    pub = info['Config']['Labels'].get('folio.publication', '')
                    if not ID.fullmatch(pub): continue
                    connected = 'cc-sandbox' in info['NetworkSettings']['Networks']
                    if self.path.endswith('/cut') and connected: docker(['network', 'disconnect', '-f', 'cc-sandbox', PREFIX + pub])
                    if self.path.endswith('/restore') and not connected and info['State']['Running']: docker(['network', 'connect', 'cc-sandbox', PREFIX + pub])
                return self.answer(200, {'ok': True})
            id = b['id']
            if not ID.fullmatch(id): raise ValueError('Invalid publication')
            if self.path == '/start':
                repo, cwd, port = b['repo'], b['cwd'], int(b['port'])
                if not REPO.fullmatch(repo) or not (cwd == '/work' or cwd.startswith('/work/')) or '..' in cwd.split('/') or not 1024 <= port <= 65535: raise ValueError('Invalid configuration')
                source = json.loads(docker(['inspect', 'ccsb-' + repo]))[0]
                if not source['State']['Running'] or 'cc-sandbox' not in source['NetworkSettings']['Networks']: raise ValueError('Start the sandbox and restore its network before publishing a service')
                with LOCK:
                    active = docker(['ps', '-q', '--filter', 'label=folio.publication']).splitlines()
                    if len(active) >= 6: raise ValueError('Maximum six active services')
                    expires = int(time.time()) + min(max(int(b.get('ttl', 7200)), 300), 86400)
                    docker(['volume', 'inspect', 'cc-work-' + repo])
                    args = ['run', '-d', '--name', PREFIX + id, '--label', 'folio.publication=' + id, '--label', 'folio.repo=' + repo,
                            '--label', 'folio.expires=' + str(expires), '--label', 'folio.port=' + str(port),
                            '--network', 'cc-sandbox', '--memory', '384m', '--cpus', '0.5', '--pids-limit', '128',
                            '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only',
                            '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m,mode=1777',
                            '--mount', 'type=volume,src=cc-work-' + repo + ',dst=/work,readonly',
                            '--workdir', cwd, '-e', 'HOME=/tmp', '-e', 'CLAUDE_CONFIG_DIR=/tmp/.claude',
                            '-e', 'PORT=' + str(port), '-e', 'BASE_PATH=./', 'cc-sandbox:1', 'sh', '-c', b['command']]
                    docker(args)
                # A successful publish means the service actually accepts connections.
                try:
                    deadline = time.time() + 25
                    while True:
                        try:
                            host, p = target(id)
                            with socket.create_connection((host, p), timeout=1): break
                        except (OSError, ValueError):
                            if time.time() >= deadline: raise ValueError('Service did not become ready')
                            time.sleep(.3)
                except Exception:
                    docker(['rm', '-f', PREFIX + id]); raise
                return self.answer(200, {'state': 'running', 'expiresAt': expires})
            if self.path == '/stop':
                owned(id); docker(['rm', '-f', PREFIX + id]); return self.answer(200, {'ok': True})
            if self.path == '/status':
                try: info = owned(id)
                except ValueError: return self.answer(200, {'state': 'stopped'})
                return self.answer(200, {'state': 'running' if info['State']['Running'] and float(info['Config']['Labels']['folio.expires']) > time.time() else 'stopped'})
            if self.path == '/logs':
                owned(id); return self.answer(200, {'text': docker(['logs', '--tail', '100', PREFIX + id]).decode(errors='replace')[-32000:]})
            return self.answer(404, {'error': 'Not found'})
        except Exception as e: return self.answer(400, {'error': str(e) if isinstance(e, ValueError) else 'Gateway operation failed'})
    def do_CONNECT(self):
        if not self.auth(): return self.answer(401, {'error': 'Unauthorized'})
        try:
            id = self.path.removeprefix('/')
            host, port = target(id)
            upstream = socket.create_connection((host, port), timeout=15)
        except Exception: return self.answer(502, {'error': 'Service unavailable'})
        self.send_response(200); self.end_headers(); self.wfile.flush()
        self.close_connection = True
        self.connection.settimeout(None); upstream.settimeout(None)
        try:
            while True:
                ready, _, _ = select.select([self.connection, upstream], [], [], 600)
                if not ready: break
                for source in ready:
                    data = source.recv(65536)
                    if not data: return
                    (upstream if source is self.connection else self.connection).sendall(data)
        finally: upstream.close()

def reap():
    while True:
        try:
            names = docker(['ps', '-aq', '--filter', 'label=folio.publication']).splitlines()
            for name in names:
                info = json.loads(docker(['inspect', name.decode()]))[0]
                id = info['Config']['Labels'].get('folio.publication', '')
                if ID.fullmatch(id) and float(info['Config']['Labels']['folio.expires']) < time.time():
                    docker(['rm', '-f', PREFIX + id])
        except Exception: pass
        time.sleep(30)

if __name__ == '__main__':
    threading.Thread(target=reap, daemon=True).start()
    http.server.ThreadingHTTPServer(('127.0.0.1', 8124), Handler).serve_forever()
