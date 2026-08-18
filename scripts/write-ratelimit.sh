#!/usr/bin/env bash
# Schreibt die geteilten Traefik-Rate-Limit-Middlewares.
#
# MUSS laufen, bevor global-traefik startet: der websecure-Entrypoint
# referenziert public-ratelimit@file (traefik/docker-compose.yml). Fehlt die
# Datei beim Start, faellt JEDER HTTPS-Router auf 500 — die ganze Plattform ist
# dann offline, nicht nur ungebremst. Deshalb schreibt sie sowohl bootstrap.sh
# (Erstinstallation) als auch redeploy.sh (Infra-Phase) vor dem Traefik-Start,
# und zusaetzlich der Provisioning Agent bei jedem Start als Redundanz.
#
# Geschluesselt auf Cf-Connecting-Ip: vor der Plattform steht Cloudflare, die
# TCP-Gegenstelle ist also immer eine Edge-IP und als Unterscheidungsmerkmal
# wertlos. Inhaltlich identisch mit dem Generator im Provisioning Agent
# (lib/traefikDynamic.ts) -- beide Stellen aendern, wenn sich die Werte aendern.
#
# Werte bewusst grosszuegig: 50 req/s pro IP (Burst 100) fuer Kundenseiten,
# 20/s (Burst 40) fuer die Tenant-APIs. Eine Seite laedt beim Oeffnen Dutzende
# Assets gleichzeitig, und hinter einer IP koennen ganze NAT-Netze stecken —
# das Limit faengt eine Flut ab, nicht den Klickrhythmus eines Menschen.
set -eu
ROOT="${1:?Pfad zum Repo-Root als erstes Argument erwartet}"
DIR="$ROOT/traefik/dynamic"
mkdir -p "$DIR"
cat > "$DIR/aa-rate-limit.yml" <<'YAML'
# Automatisch erzeugt (scripts/write-ratelimit.sh) — nicht von Hand editieren.
http:
  middlewares:
    public-ratelimit:
      rateLimit:
        average: 50
        burst: 100
        period: 1s
        sourceCriterion:
          requestHeaderName: Cf-Connecting-Ip
    api-ratelimit:
      rateLimit:
        average: 20
        burst: 40
        period: 1s
        sourceCriterion:
          requestHeaderName: Cf-Connecting-Ip
YAML
