#!/usr/bin/env bash
set -euo pipefail
export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
release=${1:?release}
[[ "$release" =~ ^[a-zA-Z0-9._-]+$ ]] || exit 2
destination="/opt/folio/releases/$release"
test -f "$destination/server/runtime.ts"
previous=$(readlink /opt/folio/current)
backup="/var/backups/folio/$release"
install -d -o root -g root -m 700 /var/backups/folio "$backup"
# State-volume exports can contain full OAuth refresh credentials.
install -d -o root -g root -m 700 /var/lib/cc-sandbox/backups
python3 - "$backup" <<'PY'
import os,sqlite3,sys,shutil
root=sys.argv[1]
source=sqlite3.connect('file:/var/lib/folio/workspace.sqlite?mode=ro',uri=True)
target=sqlite3.connect(os.path.join(root,'workspace.sqlite'))
source.backup(target); target.close(); source.close()
for name in ['vault.key','settings.enc']:
    path=os.path.join('/var/lib/folio',name)
    if os.path.exists(path): shutil.copy2(path,os.path.join(root,name))
for name in ['assets','reports']:
    assets=os.path.join('/var/lib/folio',name)
    if os.path.isdir(assets): shutil.copytree(assets,os.path.join(root,name),dirs_exist_ok=True)
for directory,dirs,files in os.walk(root):
    os.chmod(directory,0o700)
    for name in files: os.chmod(os.path.join(directory,name),0o600)
print('Encrypted configuration and consistent SQLite backup saved; no secrets printed.')
PY
# Preserve the live certificate configuration; only raise this site's body cap.
nginx_file=$(readlink -f /etc/nginx/sites-enabled/folio.example.com.conf)
if [[ -f "$nginx_file" ]]; then
  cp -p "$nginx_file" "$backup/folio-nginx.conf"
  chmod 600 "$backup/folio-nginx.conf"
  sed -E -i 's/client_max_body_size[[:space:]]+[0-9]+[kKmM];/client_max_body_size 25m;/' "$nginx_file"
  if ! grep -q 'proxy_request_buffering' "$nginx_file"; then
    sed -i '/proxy_buffering off;/a\        proxy_request_buffering off;' "$nginx_file"
  fi
  python3 - "$nginx_file" <<'PY'
import sys
path=sys.argv[1]
text=open(path).read()
if '$folio_connection_upgrade' not in text:
    text='map $http_upgrade $folio_connection_upgrade { default upgrade; "" ""; }\n'+text
    text=text.replace('proxy_set_header Connection "";', 'proxy_set_header Upgrade $http_upgrade;\n        proxy_set_header Connection $folio_connection_upgrade;')
open(path,'w').write(text)
PY
  if ! nginx -t; then cp -p "$backup/folio-nginx.conf" "$nginx_file"; exit 1; fi
  systemctl reload nginx
fi
install -d -o root -g root -m 755 /opt/folio/gateway
if [[ -f /opt/folio/gateway/report-gateway.py ]]; then
  cp -p /opt/folio/gateway/report-gateway.py "$backup/report-gateway.py"
fi
if [[ -f /etc/systemd/system/folio-reports.service ]]; then
  cp -p /etc/systemd/system/folio-reports.service "$backup/folio-reports.service"
elif ss -lnt '( sport = :8124 )' | grep -q LISTEN; then
  echo 'Port 8124 is already in use; refusing to replace it.'; exit 1
fi
install -o root -g root -m 644 "$destination/deploy/report-gateway.py" /opt/folio/gateway/report-gateway.py
install -o root -g root -m 644 "$destination/deploy/folio-reports.service" /etc/systemd/system/folio-reports.service
systemctl daemon-reload
systemctl enable --now folio-reports.service
systemctl restart folio-reports.service
systemctl is-active --quiet folio-reports.service
ln -s "$destination" "/opt/folio/.activate-$release"
mv -Tf "/opt/folio/.activate-$release" /opt/folio/current
systemctl restart folio.service
ready=0
for try in $(seq 1 25); do
  if curl -fsS http://127.0.0.1:8004/api/health >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
if [[ "$ready" != 1 ]]; then
  ln -s "$previous" "/opt/folio/.rollback-$release"
  mv -Tf "/opt/folio/.rollback-$release" /opt/folio/current
  systemctl restart folio.service
  echo 'New release failed readiness; previous release restored.'
  exit 1
fi
curl -fsS http://127.0.0.1:8004/api/health
echo
systemctl show folio.service -p ActiveState -p SubState -p MainPID
