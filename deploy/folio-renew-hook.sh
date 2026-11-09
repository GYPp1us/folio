#!/usr/bin/env bash
set -euo pipefail
if [[ "${RENEWED_LINEAGE:-}" == /etc/letsencrypt/live/folio.example.com ]]; then
    /usr/sbin/nginx -t
    /usr/bin/systemctl reload nginx
fi
