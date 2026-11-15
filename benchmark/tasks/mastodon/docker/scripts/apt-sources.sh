#!/bin/sh
# Point apt at a Debian mirror that still serves the image's release, then run `apt-get update`.
# Bullseye (Debian 11) left LTS in 2026; deb.debian.org may stop serving it at any time and it
# then lives only on archive.debian.org (whose Release files are past their Valid-Until date).
set -eu
codename=$(. /etc/os-release && echo "$VERSION_CODENAME")

use_archive() {
  echo "apt-sources: deb.debian.org does not serve $codename any more; using archive.debian.org" >&2
  rm -f /etc/apt/sources.list.d/debian.sources
  cat > /etc/apt/sources.list <<EOF
deb http://archive.debian.org/debian $codename main
deb http://archive.debian.org/debian $codename-updates main
deb http://archive.debian.org/debian-security $codename-security main
EOF
  echo 'Acquire::Check-Valid-Until "false";' > /etc/apt/apt.conf.d/99frugal-archive
  apt-get update -o Acquire::Retries=3
}

# Bullseye's packages are gone from deb.debian.org even though its index files still list them
# (seen Nov 2026: the Release files return 200 but debian-security pool files 404), so a
# successful `apt-get update` there proves nothing. Always use the archive for bullseye.
if [ "$codename" = bullseye ]; then
  use_archive
  exit 0
fi

log=$(mktemp)
if apt-get update -o Acquire::Retries=3 >"$log" 2>&1 && ! grep -qE '^(E|W): .*(404|does not have a Release file|no longer has a Release file)' "$log"; then
  cat "$log"
else
  cat "$log" >&2
  use_archive
fi
rm -f "$log"
