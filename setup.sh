#!/usr/bin/env bash
# Writes .env for docker compose. Re-run it to change the host or password.
set -euo pipefail
cd "$(dirname "$0")"

if [[ -e .env ]]; then
  read -rp ".env already exists. Overwrite it? [y/N] " answer
  [[ "$answer" == [yY]* ]] || exit 0
fi

echo "Address your friends will use: a domain (recommended) or your public IP."
read -rp "Host: " host
read -rsp "Room password: " password
echo

if [[ -z "$host" || -z "$password" ]]; then
  echo "Host and password are both required." >&2
  exit 1
fi
if [[ "$password" == *"'"* ]]; then
  echo "The password can't contain a single quote." >&2
  exit 1
fi

umask 077
cat > .env <<ENV
PUBLIC_HOST='$host'
ROOM_PASSWORD='$password'
SESSION_SECRET='$(openssl rand -hex 32)'
LIVEKIT_API_KEY='$(openssl rand -hex 8)'
LIVEKIT_API_SECRET='$(openssl rand -hex 32)'
ENV

echo "Wrote .env. Start it with: docker compose up -d --build"
