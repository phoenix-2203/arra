#!/bin/bash
# Fresh local chain + v4 vault + Arra server on :8791 (fake money).
[ -f pids ] && kill $(cat pids) 2>/dev/null; pkill -x anvil 2>/dev/null; sleep 1
cd /root/arra-e2e
setsid nohup ~/.foundry/bin/anvil --chain-id 42220 --port 8545 --silent > anvil.log 2>&1 &
sleep 2
BUYER_USDT=600 BUYER_CNGN=600000 node setup.mjs > vault.json
rm -rf data
V=$(node -e 'console.log(require("/root/arra-e2e/vault.json").vault)')
(fuser -k 8799/tcp; true) >/dev/null 2>&1; setsid nohup node /root/arra-e2e/fakebuy.mjs > /root/arra-e2e/fakebuy.log 2>&1 &
cd /root/arra/agent
BUY_GATEWAY=http://localhost:8799 GEMINI_API=http://localhost:8799/gemini GEMINI_API_KEY=local AGENT_PRIVATE_KEY=0x2a871d0798f97d79848a013d4936a73bf4cc922c4ba1cd22a3b6cc6ca0a2d7e6 CELO_RPC_URL=http://127.0.0.1:8545 ARRA_LOCAL_VAULTS="[{\"address\":\"$V\",\"firstId\":1}]" ARRA_NUMERIC_LINKS_MAX=0 DATA_DIR=/root/arra-e2e/data PORT=8791 setsid nohup node scripts/serve.js > /root/arra-e2e/server.log 2>&1 &
echo $! > /root/arra-e2e/pids
sleep 3
curl -s localhost:8791/api/health | head -c 60; echo
