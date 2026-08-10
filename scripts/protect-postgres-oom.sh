#!/usr/bin/env bash
# Audit §11: Der Kernel-OOM-Killer waehlt nach oom_score — der groesste Prozess
# ist typischerweise PostgreSQL. Ein einziger nixpacks-Build eines Kunden konnte
# damit die Datenbank ALLER Kunden abschiessen.
#
# Muss nach jedem Neustart von core-postgres laufen (der Score haengt an der
# PID). Wird von einem systemd-Timer minuetlich nachgezogen.
set -euo pipefail
PID=$(docker inspect -f '{{.State.Pid}}' core-postgres 2>/dev/null || echo 0)
[ "$PID" != "0" ] || exit 0
echo -900 > "/proc/$PID/oom_score_adj" 2>/dev/null || true
