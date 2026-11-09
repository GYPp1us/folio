#!/usr/bin/env bash
set -euo pipefail
umask 027
archive=${1:?archive}
test -e /opt/folio/.folio-managed
current=$(readlink -f /opt/folio/current)
[[ "$current" == /opt/folio/releases/* ]] || exit 2
staging=$(mktemp -d /opt/folio/.static-XXXXXXXX)
cleanup() { [[ "$staging" == /opt/folio/.static-* ]] && rm -rf -- "$staging"; }
trap cleanup EXIT
tar --no-same-owner -xzf "$archive" -C "$staging"
test -f "$staging/dist/index.html"
# Keep existing hashed assets so open tabs and pending OAuth flows remain valid.
for asset in "$staging"/dist/assets/*; do
  [[ -f "$asset" ]] || continue
  install -o root -g folio -m 640 "$asset" "$current/dist/assets/${asset##*/}"
done
for source in src/SandboxLoginPanel.tsx README.md deploy/install-la.sh deploy/activate-la.sh deploy/update-static-la.sh; do
  install -o root -g folio -m 640 "$staging/$source" "$current/$source"
done
install -o root -g folio -m 640 "$staging/dist/index.html" "$current/dist/index.html.next"
mv -Tf "$current/dist/index.html.next" "$current/dist/index.html"
echo 'Static assets and matching sources updated; backend and OAuth flows kept running.'
