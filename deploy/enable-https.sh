#!/usr/bin/env bash
set -euo pipefail
export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
domain=folio.example.com
getent ahostsv4 "$domain" >/dev/null || { echo 'DNS is not ready for folio.example.com'; exit 3; }
if [[ ! -e "/etc/letsencrypt/live/$domain/fullchain.pem" ]]; then
  certbot certonly --webroot -w /var/www/folio-acme -d "$domain" --non-interactive --keep-until-expiring
fi
openssl x509 -in "/etc/letsencrypt/live/$domain/fullchain.pem" -checkend 86400 -noout
install -d -o root -g root -m 755 /etc/letsencrypt/renewal-hooks/deploy
install -o root -g root -m 750 /opt/folio/current/deploy/folio-renew-hook.sh /etc/letsencrypt/renewal-hooks/deploy/40-folio-nginx
install -m 644 /opt/folio/current/deploy/folio-https.conf /etc/nginx/sites-enabled/folio.example.com.conf
nginx -t
systemctl reload nginx
curl --fail --silent --show-error --retry 5 --retry-delay 1 --retry-all-errors --retry-max-time 20 --max-time 10 --resolve "$domain:443:127.0.0.1" "https://$domain/api/health"
echo
echo 'HTTPS is active: https://folio.example.com'
