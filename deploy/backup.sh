#!/usr/bin/env bash
# Daily backup of Arra's server data: order sheets (terms), the payee address book,
# container numbers, invites and the link secret (without it, private order links break).
# Funds never depend on this: they live in the vault on Celo. Keeps the last 14 days.
# Copy /opt/arra-backups somewhere off this machine now and then (e.g. scp to your laptop).
set -euo pipefail
DATA=/opt/arra/agent/data
OUT=/opt/arra-backups
mkdir -p "$OUT"
chmod 700 "$OUT"
[ -d "$DATA" ] || exit 0
tar -czf "$OUT/arra-data-$(date +%Y%m%d).tgz" -C "$(dirname "$DATA")" "$(basename "$DATA")"
chmod 600 "$OUT"/arra-data-*.tgz
ls -1t "$OUT"/arra-data-*.tgz | tail -n +15 | xargs -r rm --
