#!/usr/bin/env bash
set -euo pipefail
export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
umask 027
archive=${1:?Pass the uploaded release archive}
release=${2:?Pass a release identifier}
[[ "$release" =~ ^[a-zA-Z0-9._-]+$ ]] || exit 2
root=/opt/folio
previous_healthy=0
if systemctl is-active --quiet folio.service && curl -fsS http://127.0.0.1:8004/api/health >/dev/null 2>&1; then previous_healthy=1; fi
if [[ -d "$root" && ! -e "$root/.folio-managed" ]]; then
  echo 'Refusing to replace an existing unmanaged /opt/folio'; exit 2
fi
install -d -o root -g root -m 700 /var/lib/cc-sandbox/backups
if ! systemctl is-active --quiet folio.service; then
  python3 - <<'PY'
import socket
with socket.socket() as s:
    s.bind(('127.0.0.1', 8004))
print('Port 8004 is available')
PY
fi
if id folio >/dev/null 2>&1; then
  [[ $(id -u folio) -lt 1000 && $(getent passwd folio | cut -d: -f6) == /var/lib/folio ]] || { echo 'Existing folio account is not this service user'; exit 2; }
else
  useradd --system --user-group --home-dir /var/lib/folio --shell /usr/sbin/nologin folio
fi
install -d -o root -g root -m 755 "$root" "$root/releases"
touch "$root/.folio-managed"
destination="$root/releases/$release"
[[ ! -e "$destination" ]] || { echo 'Release directory already exists'; exit 2; }
install -d -o root -g root -m 755 "$destination"
tar --no-same-owner -xzf "$archive" -C "$destination"
cd "$destination"
npm ci --omit=dev --no-audit --no-fund
# npm respects umask 027; the service user needs group access. Also normalize
# permissive modes in archives produced on Windows, keeping service code read-only.
chown -R root:folio "$destination"
chmod -R u=rwX,g=rX,o= "$destination"
install -d -o root -g folio -m 750 /etc/folio
install -d -o folio -g folio -m 700 /var/lib/folio
install -o root -g folio -m 640 /etc/cc-sandbox/token /etc/folio/sandbox.token
if [[ ! -e /etc/folio/bootstrap-token ]]; then
  python3 - <<'PY'
import os, secrets
fd=os.open('/etc/folio/bootstrap-token', os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
with os.fdopen(fd,'w') as f: f.write(secrets.token_urlsafe(32)+'\n')
PY
  chown root:folio /etc/folio/bootstrap-token
  chmod 640 /etc/folio/bootstrap-token
fi
if [[ ! -e /etc/folio/webui.env ]]; then
  cat > /etc/folio/webui.env <<'ENV'
HOST=127.0.0.1
PORT=8004
DATA_DIR=/var/lib/folio
RETENTION_DAYS=30
TRUST_PROXY=1
CC_SANDBOX_URL=http://127.0.0.1:8123
CC_SANDBOX_TOKEN_FILE=/etc/folio/sandbox.token
FOLIO_SETUP_TOKEN_FILE=/etc/folio/bootstrap-token
ENV
  chown root:folio /etc/folio/webui.env
  chmod 640 /etc/folio/webui.env
fi
previous=$(readlink "$root/current" || true)
ln -s "$destination" "$root/.current-$release"
mv -Tf "$root/.current-$release" "$root/current"
install -m 644 deploy/folio.service /etc/systemd/system/folio.service
systemctl daemon-reload
systemctl enable folio.service
systemctl restart folio.service
ready=0
for attempt in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:8004/api/health >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
if [[ "$ready" != 1 ]]; then
  if [[ -n "$previous" && "$previous_healthy" == 1 ]]; then
    ln -s "$previous" "$root/.rollback-$release"
    mv -Tf "$root/.rollback-$release" "$root/current"
    systemctl restart folio.service
  else
    systemctl stop folio.service
  fi
  echo 'Folio failed readiness; the previous release was restored if available.'
  exit 1
fi
install -d -o root -g root -m 755 /var/www/folio-acme /var/www/folio-acme/.well-known /var/www/folio-acme/.well-known/acme-challenge
if [[ -f /etc/letsencrypt/live/folio.example.com/fullchain.pem ]]; then
  install -m 644 deploy/folio-https.conf /etc/nginx/sites-enabled/folio.example.com.conf
else
  install -m 644 deploy/folio-http.conf /etc/nginx/sites-enabled/folio.example.com.conf
fi
nginx -t
systemctl reload nginx
echo 'Folio installed. Health:'
curl -fsS http://127.0.0.1:8004/api/health
echo
systemctl show folio.service -p ActiveState -p SubState -p MainPID -p User
echo 'Bootstrap token file: /etc/folio/bootstrap-token (not printed)'
