#!/bin/bash
# build-db-template.sh: create the Postgres/Redis data template at /opt/frugal/data-template with
# the dev and test databases created and the checkpoint schema loaded (dev also seeded: the 'Web'
# OAuth superapp the web UI needs, and the dev admin admin@localhost:3000 / mastodonadmin).
# Runs as uid 1000 at image build time. `services start` copies the template into /data.
set -euo pipefail
T=/opt/frugal/data-template
PGBIN=$(ls -d /usr/lib/postgresql/*/bin | sort -V | tail -1)

rm -rf "$T"/pg "$T"/redis "$T"/log
mkdir -p "$T"/redis "$T"/log
"$PGBIN"/initdb -D "$T"/pg -U "$DB_USER" --auth=trust --encoding=UTF8 --locale=C.UTF-8 >/dev/null
cat >> "$T"/pg/postgresql.conf <<'EOF'

# --- frugal: single-user benchmark sandbox ---------------------------------------------------
# TCP on loopback only and no unix socket, so nothing outside /data needs to be writable.
listen_addresses = '127.0.0.1'
port = 5432
unix_socket_directories = ''
# Throwaway data: trade durability for speed (rspec truncates/creates a lot).
fsync = off
synchronous_commit = off
full_page_writes = off
shared_buffers = 128MB
max_connections = 100
logging_collector = off
log_min_messages = warning
EOF
cat > "$T"/pg/pg_hba.conf <<'EOF'
host all all 127.0.0.1/32 trust
host all all ::1/128      trust
EOF

FRUGAL_DATA_DIR="$T" /opt/frugal/task/services start

cd /workspace
bin/rails db:create db:schema:load db:seed
RAILS_ENV=test bin/rails db:create db:schema:load
psql -d postgres -Atc "select datname from pg_database where datname like 'mastodon%' order by 1"
bin/rails runner 'puts "dev accounts: #{Account.count}, oauth apps: #{Doorkeeper::Application.count}"'

FRUGAL_DATA_DIR="$T" /opt/frugal/task/services stop
rm -f "$T"/pg/postmaster.pid "$T"/pg/postmaster.opts "$T"/log/* "$T"/redis/*
chmod 700 "$T"/pg
# Files the template run left in the (git-ignored) workspace dirs.
rm -rf /workspace/log/*.log /workspace/tmp/pids /workspace/tmp/sockets
git -C /workspace status --porcelain | head -20
