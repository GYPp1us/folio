#!/usr/bin/env bash
set -euo pipefail
export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
umask 027
archive=${1:?archive}; release=${2:?release}
[[ "$release" =~ ^[a-zA-Z0-9._-]+$ ]] || exit 2
test -e /opt/folio/.folio-managed
destination="/opt/folio/releases/$release"
[[ ! -e "$destination" ]] || { echo 'Release exists'; exit 2; }
install -d -o root -g folio -m 750 "$destination"
tar --no-same-owner -xzf "$archive" -C "$destination"
cd "$destination"
npm ci --omit=dev --no-audit --no-fund
chown -R root:folio "$destination"
chmod -R u=rwX,g=rX,o= "$destination"
echo "Staged $destination; production has not been restarted."
