#!/usr/bin/env python3
"""Read-only post-deployment checks. Never reads or prints provider credentials."""
import json
import urllib.request
import urllib.error
import http.cookiejar
from pathlib import Path

def request(path, body=None, host=None):
    headers = {'Content-Type': 'application/json'}
    if host:
        headers['Host'] = host
    req = urllib.request.Request('http://127.0.0.1:8004'+path,
        data=None if body is None else json.dumps(body).encode(), headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            return response.status, response.read().decode()
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode()

code, page = request('/')
assert code == 200 and 'Folio' in page and '/assets/index-' in page
code, health = request('/api/health')
assert code == 200 and json.loads(health)['service'] == 'folio'
code, setup = request('/api/setup/status', host='folio.example.com')
assert code == 200
status = json.loads(setup)
if status['required']:
    assert status['needsInstallCode'] and not status['unlocked'] and 'defaults' not in status
    assert request('/api/config')[0] == 428
    assert request('/api/setup/complete', {})[0] == 401
    # Claim a temporary installer cookie only to test the real sandbox connection.
    # The code stays in memory on this server, and setup is deliberately unfinished.
    jar = http.cookiejar.CookieJar()
    client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    def installer(path, body=None):
        req = urllib.request.Request('http://127.0.0.1:8004/api/setup/'+path,
            data=None if body is None else json.dumps(body).encode(),
            headers={'Content-Type': 'application/json'})
        with client.open(req, timeout=30) as response:
            return json.load(response)
    installer('unlock', {'code': Path('/etc/folio/bootstrap-token').read_text().strip()})
    assert installer('status')['defaults']['sandboxConfigured']
    assert installer('check', {'kind': 'sandbox'})['ok']
    assert installer('status')['required']
    print('PASS: installed service authenticated to the actual sandbox image API; no container or model started')
else:
    assert request('/api/config')[0] == 401
print('PASS: built frontend, health, domain Host, install-code gate, protected configuration')
print('Health:', health)
print('Setup pending:', status['required'])
