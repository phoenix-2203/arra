#!/usr/bin/env bash
# Installs or updates Arra on the VPS. Run as root from anywhere:
#   bash <(curl -fsSL https://raw.githubusercontent.com/phoenix-2203/arra/main/deploy/setup.sh)
# or, inside a clone:  bash deploy/setup.sh
# Pass your DuckDNS name to get a ready Caddy block, e.g.:  ... setup.sh) arratrade
set -euo pipefail
NAME="${1:-arra}"
DOMAIN="${NAME%.duckdns.org}.duckdns.org"
if [ "$(uname -s)" != "Linux" ]; then
  echo "This sets Arra up on your server. Log in to the server first (ssh), then run it there."
  exit 1
fi
if [ "$(id -u)" != "0" ]; then
  echo "Run this as root on the server (for example: sudo -i, then run it again)."
  exit 1
fi
DIR=/opt/arra
PORT=8787

if [ ! -d "$DIR/.git" ]; then
  git clone https://github.com/phoenix-2203/arra "$DIR"
else
  git -C "$DIR" pull --ff-only
fi

command -v node >/dev/null || { echo "Node.js 20+ is needed: https://nodejs.org"; exit 1; }
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' || { echo "Node.js 20+ is needed"; exit 1; }

echo "Installing agent…"
(cd "$DIR/agent" && npm ci --omit=dev --no-audit --no-fund)
echo "Building app (uses up to 3 GB of memory)…"
(cd "$DIR/app" && npm ci --no-audit --no-fund && NODE_OPTIONS=--max-old-space-size=3072 npm run build)

if [ ! -f "$DIR/agent/.env" ]; then
  cat > "$DIR/agent/.env" <<ENV
CELO_RPC_URL=https://forno.celo.org
PORT=$PORT
# Keeper: set to 1 AND add AGENT_PRIVATE_KEY yourself to let the agent
# auto-refund / auto-pay orders whose deadlines have passed.
KEEPER=0
ENV
  chmod 600 "$DIR/agent/.env"
fi

cat > /etc/systemd/system/arra.service <<UNIT
[Unit]
Description=Arra (API, app and keeper)
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=$DIR/agent
ExecStart=$(command -v node) --env-file=$DIR/agent/.env scripts/serve.js
Restart=always
RestartSec=5
MemoryMax=600M
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now arra
systemctl restart arra
sleep 2
curl -fsS "http://127.0.0.1:$PORT/api/health" && echo
echo
echo "Arra is running on 127.0.0.1:$PORT."
echo "Add these lines to the end of your Caddyfile (usually /etc/caddy/Caddyfile), then run: systemctl reload caddy"
echo
echo "$DOMAIN {"
echo "	encode zstd gzip"
echo "	reverse_proxy 127.0.0.1:$PORT"
echo "}"
echo
echo "Then open https://$DOMAIN"
