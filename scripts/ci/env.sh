#!/bin/bash
# =============================================================================
# Wegwerf-Secrets fuer den CI-Lauf. Zum Sourcen gedacht: `source scripts/ci/env.sh`
#
# ES WERDEN KEINE ECHTEN SECRETS BENUTZT — auch keine aus GitHub Actions Secrets.
# Alles hier wird pro Lauf neu gewuerfelt und stirbt mit dem Runner. Damit gibt
# es keinen Pfad, ueber den ein Pull Request aus einem Fork an ein Produktions-
# geheimnis kaeme, und keinen Grund, jemals ein Prod-Secret in GitHub zu legen.
#
# Die age-Verschluesselung der Backups (BACKUP_AGE_*) taucht hier bewusst NICHT
# auf: die Pipeline testet keine Backups gegen den echten Object Storage.
# Begruendung in CI-SETUP.md, Abschnitt "Secrets".
# =============================================================================
hex() { openssl rand -hex "${1:-16}"; }

export MASTER_DB_PASSWORD="ci-$(hex 16)"
export PGBOUNCER_AUTH_PASSWORD="ci-$(hex 16)"
export MINIO_ROOT_USER="ciminioroot"
export MINIO_ROOT_PASSWORD="ci-$(hex 16)"
# 64 Hexzeichen = 32 Byte, so verlangt es lib/crypto.ts.
export ENCRYPTION_MASTER_KEY="$(hex 32)"
export CMS_ENCRYPTION_KEY="$(hex 32)"
export ANALYTICS_SALT="$(hex 16)"

# .invalid ist per RFC 2606 garantiert nicht aufloesbar - ein Test, der
# versehentlich nach draussen telefoniert, scheitert sofort statt still zu
# funktionieren.
export PLATFORM_DOMAIN="ci.invalid"
export VPS_PUBLIC_IP="192.0.2.10"
# Die Dienstnamen gelten INNERHALB von traefik-net; scripts/ci/in-net.sh setzt
# sie fuer den Testcontainer ohnehin nochmals explizit.
export PGBOUNCER_HOST="pgbouncer"
export ADMIN_DB_HOST="core-postgres"

# Bewusst leer: ohne Wert soll der Code seinen Warnpfad gehen, nicht versuchen
# zu senden. Ein echter Key hat im CI nichts verloren.
export RESEND_API_KEY=""
export GITHUB_PAT=""
export CF_DNS_API_TOKEN=""

# Tenant-Slugs des Testlaufs. Zwei, weil eine Tenant-Isolation sich nur mit
# einem zweiten Tenant pruefen laesst.
export CI_TENANT_A="ci-alpha"
export CI_TENANT_B="ci-beta"
export CI_TENANT_A_PW="ci-$(hex 16)"
export CI_TENANT_B_PW="ci-$(hex 16)"
export CI_TENANT_A_JWT_SECRET="$(hex 32)"
export CI_TENANT_B_JWT_SECRET="$(hex 32)"
