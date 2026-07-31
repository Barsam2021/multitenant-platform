# MultiTenant Platform — Roadmap bis Go-Live (v2, nach echter Code-Analyse)

**Korrektur zur v1-Roadmap:** Die erste Version basierte auf einer gecachten/veralteten GitHub-Ansicht und ging fälschlich von einem leeren Repo aus. Diese Version basiert auf dem tatsächlichen Code (`git log`, `codeload.github.com`-Tarball, Datei-für-Datei gelesen).

## Ist-Zustand korrigiert
Deutlich weiter als gedacht: Provisioning Agent hat eine **vollständige Deployment Engine** (Blue-Green-Deploy, Rollback, Webhook-Signaturverifikation, DNS-Polling für Custom Domains, AES-256-GCM-Verschlüsselung). Dashboard hat einen **funktionierenden Table/SQL-Editor**. Was fehlt, ist gezielter als "alles fehlt":

| Bereich | Backend-Code | Dashboard-UI | Produktionsreif? |
|---|---|---|---|
| Tenant-Provisioning | ✅ | ✅ | ⚠️ — SMTP/Resend noch offen (siehe Kritischer Pfad) |
| Deployment Engine | ✅ vollständig | ✅ | ✅ — noch kein echter Repo-Deploy getestet (nur `repoProvider: manual` im Smoke-Test) |
| Table/SQL-Editor | ✅ | ✅ | ✅ fertig |
| Custom Domains | ✅ inkl. DNS-Polling | ✅ | ✅ fertig |
| GitHub-Integration | ✅ | ✅ | ✅ fertig |
| Monitoring-Integration | ✅ (Uptime Kuma) | – | ✅ fertig, End-to-End verifiziert |
| Backup-Verschlüsselung | ✅ | ✅ | ✅ fertig |
| Security-Hardening (Rate-Limit, Header, Audit-Log) | ✅ | ✅ | ✅ fertig |
| Secret-Rotation | ✅ (JWT, MinIO) | ✅ | ✅ fertig |

---

## Phase 0 — Blocker fixen (0.5–1 Tag) ⚠️ **zuerst**
- [X] `kunden`-Tabelle um `minio_access_key`, `minio_secret_key_encrypted`, `resend_api_key_encrypted`, `auth_public_enabled`, `postgrest_public_enabled` erweitern
- [X] `POST /tenants` in `index.ts` erweitert: pro-Tenant MinIO-Access-Key + IAM-Policy
- [X] Fehlende Tabellen als versioniertes SQL-Migrationsfile (`core-postgres/init-scripts/02_admin_schema.sql`)
- [X] `.gitignore` um `deployments/builds/*` und `deployments/apps/*` ergänzt

**Exit-Kriterium erreicht.**

---

## Phase 1 — Provisioning Agent: Rest-Lücken schließen (2–3 Tage)
- [X] `templates/tenant-compose.yml` auf `pgbouncer:5432` umgestellt + `IGNORE_STARTUP_PARAMETERS: search_path`
- [X] `GOTRUE_SITE_URL`/`API_EXTERNAL_URL` auf echte Domain (`PLATFORM_DOMAIN` Env-Var, Schema `<slug>.up2-web.com` statt `app.<slug>.vps.meine-domain.com` — Wildcard-Cert-Kosten bei Cloudflare vermieden)
- [ ] `GOTRUE_MAILER_AUTOCONFIRM: "true"` durch echte Resend-SMTP-Konfiguration ersetzen — **zurückgestellt**
- [X] `mem_limit`/`cpus`/Healthchecks für `api`/`auth`-Container im Template (Tarif-Werte vorerst als Platzhalter in `.env`/`.env.example`, echte Kalkulierung für 8GB-VPS statt geplanter 16GB noch offen)
- [X] `DELETE /tenants/:slug` implementiert (Container stoppen, DB droppen, MinIO Bucket+User+Policy löschen, Verzeichnis löschen, `kunden`-Zeile löschen)
- [ ] `POST /rotate-secret` — **verschoben nach Phase 7 (Security-Hardening)**, kein MVP-Feature
- [X] `GET /stats` implementiert (Docker-Stats + DB-Connection-Counts)
- [X] Docker-Socket-Proxy (Tecnativa `v0.4.2`) statt direktem Socket-Mount
- [ ] Container-Hardening (`read_only`, `cap_drop: ALL`, `no-new-privileges`, `pids_limit`) für alle generierten Compose-Templates

**Offen:** SMTP-Wiring, Resource-Tier-Werte für 8GB neu kalkulieren, Container-Hardening.

---

## Phase 2 — Dashboard-UI für das, was der Agent schon kann (3–4 Tage)
- [X] `/dashboard/database`: "Tenant erstellen"-Button + Formular (`POST /tenants` über `/api/provision-tenant`) + "Löschen"-Aktion
- [X] `/dashboard/hosting`: Projekt-Liste, "New Project"-Wizard (ohne GitHub-Repo-Picker erstmal), Deployment-Historie, Rollback-Button, Live-Build-Logs via Polling
- [X] Env-Var-Editor pro Projekt
- [X] Domain-UI

---

## Phase 3 — GitHub-Integration (1–2 Tage)
- [X] GitHub OAuth App anlegen
- [X] `github_connections`-Tabelle nutzen
- [X] Connect-Flow + Repo-Picker im Wizard
- [X] Automatische Webhook-Registrierung bei Projekt-Erstellung

---

## Phase 4 — Monitoring-Integration (1 Tag) ✅ **End-to-End verifiziert**
- [X] Uptime-Kuma-Anbindung via `socket.io-client` (kein offizielles REST-API vorhanden,
      Kuma selbst nutzt intern nur Socket.IO — `lib/monitoring.ts`, gepinnt gegen v2.4.0)
- [X] Automatische Monitor-Registrierung bei `POST /projects` (Preview-Hostname), `kuma_monitor_id`
      in `projects` (Migration `07_monitoring.sql`) — best effort, blockiert Projekt-Anlage nicht
- [X] Monitore entfernen bei `DELETE /tenants/:slug` (für alle Projekte des Tenants)
- **Offen:** Monitor-Update bei Custom-Domain-Wechsel (aktuell nur Preview-Hostname überwacht)

**Beim Rollout gefundene und gefixte Bugs (nicht in der Erstversion enthalten):**
1. `transports: ['websocket']` im `socket.io()`-Call erzwang reines WebSocket und übersprang
   den nötigen Engine.IO-Polling-Handshake → `"websocket error"`. Fix: Transport-Option entfernt,
   Standard (Polling → Upgrade) nutzen.
2. Kuma 2.4.0 hat eine `NOT NULL`-Spalte `monitor.conditions` (bedingte Monitor-Logik-Feature),
   die im `add`-Payload fehlte → `SQLITE_CONSTRAINT`-Fehler beim Monitor-Anlegen. Fix: `conditions: []`
   im Payload ergänzt.
3. **Rein betrieblich, kein Code-Bug:** Uptime Kuma muss einmalig über den Setup-Wizard initialisiert
   werden (Datenbank-Wahl **SQLite** empfohlen — `mem_limit: 128m` im Compose-File ist für Embedded
   MariaDB knapp bemessen), Admin-Zugangsdaten müssen exakt `UPTIME_KUMA_USERNAME`/`UPTIME_KUMA_PASSWORD`
   aus der `.env` entsprechen. Der DNS-Eintrag für `status-vps.<domain>` muss ein normaler
   **A-Record** sein (nicht der Cloudflare-Tunnel-Typ, den z.B. das Dashboard nutzt) — Kuma läuft
   über Traefik/Let's-Encrypt, nicht über den Tunnel.

---

## Phase 5 — Backup, Verschlüsselung, Restore-Test (2 Tage)
- [X] Prüfen ob `backup-script.sh` als Cron läuft
- [X] Backup-Script + Cron-Eintrag ins Repo
- [X] Verschlüsselung der Dumps vor `rclone`-Upload (`age`/`gpg`)
- [X] Einmaliger Restore-Test
- [X] Trockenlauf von `09_disaster_recovery_runbook.md`

---

## Phase 6 — Security-Hardening Rest (1–2 Tage) ✅
- [X] Rate-Limiting auf Dashboard-/Agent-API (`express-rate-limit`, in-memory — reicht für
      Single-VPS; global großzügig, `/webhooks` eigenes Limit, sensible Ops strenger)
- [X] CSP, HSTS, Security-Header im Dashboard (`next.config.mjs` § `headers()`)
- [X] `audit_logs`-Tabelle + Logging (Migration `06_audit_logs.sql`, `lib/audit.ts`,
      Dashboard-Ansicht unter `/dashboard/audit`) — namensbasierte Secret-Redaction in `meta`
- [X] Secret-Scanner für Build-Logs — bereits vorhandenes `maskSecrets()` bleibt einzige
      Quelle für Freitext-Logs, Audit-Log nutzt eigenen (namensbasierten) Redactor für JSON
- **Bekannte Lücke:** CSP nutzt `'unsafe-inline'` für Scripts (wegen Theme-Init-Snippet in
  `layout.tsx`) — für Single-Admin-Setup vertretbar, bei Bedarf später auf Nonce umstellen.

---

## Phase 7 — Security Rotation & Go-Live (0.5–1 Tag) ✅ **End-to-End verifiziert**
- [X] `POST /tenants/:slug/rotate-secret` — JWT-Secret (Container-Neustart inklusive) und
      MinIO-Secret-Key (Redeploy betroffener Projekte nötig, Hinweis kommt in der Response)
- [X] Smoke-Test End-to-End (`scripts/smoke-test.sh`) — Tenant anlegen → Container-Check →
      Stats → Audit-Log → Monitoring (falls konfiguriert) → Secret-Rotation → Backup-Trigger
      → Tenant-Löschung (immer, auch bei Fehlschlag, via `trap`)
- [X] Keine Secrets im Klartext — verifiziert: `maskSecrets()` in Build-Logs, Audit-Log-Redactor,
      `webhookSecret` nur einmalig bei Erstellung im Klartext zurückgegeben (Bestandscode)
- **Manuell, bewusst nicht automatisiert:** `resend_api_key` (global, nicht pro Tenant) und
  `PROVISIONING_AGENT_SECRET` (muss Dashboard + Agent gleichzeitig treffen, sonst Selbst-Aussperrung)

### Secret-Rotation-Matrix — Umsetzungsstand
| Secret | Rotation | Status |
|---|---|---|
| `gotrue_jwt_secret` | `POST /tenants/:slug/rotate-secret {"secret":"jwt"}` | ✅ automatisiert |
| `minio_secret_key` | `POST /tenants/:slug/rotate-secret {"secret":"minio"}` | ✅ automatisiert (Redeploy der Projekte danach nötig) |
| `resend_api_key` | `.env` ändern → alle Tenants: `auth`-Container neu starten | ⚠️ manuell |
| `project_env_vars` | `PUT /projects/:id/env` (Bestandscode) → Redeploy | ✅ bereits vorhanden |
| `PROVISIONING_AGENT_SECRET` | Dashboard + Agent gleichzeitig auf neuen Shared-Secret | ⚠️ manuell, absichtlich |

---

## Zeitschätzung gesamt

| Phase | Aufwand |
|---|---|
| 0 Blocker fixen | ✅ erledigt |
| 1 Agent-Lücken | ⚠️ größtenteils erledigt, SMTP + Hardening offen |
| 2 Dashboard-UI | ✅ erledigt |
| 3 GitHub-Integration | ✅ erledigt |
| 4 Monitoring | ✅ erledigt |
| 5 Backup/Restore | ✅ erledigt |
| 6 Security-Rest | ✅ erledigt |
| 7 Security Rotation/Go-Live | ✅ erledigt |

## Kritischer Pfad
Phasen 0–7 sind im Code umgesetzt und (Stand: erfolgreicher Lauf von `scripts/smoke-test.sh`
gegen die echte VPS-Umgebung, alle 10 Checks inkl. Monitoring grün) End-to-End verifiziert.

**Einziger bekannter Blocker vor Live-Schaltung mit echten Kundendaten:**
- `RESEND_API_KEY`-Wiring in `provisioning-agent/src/index.ts` (Zeile mit
  `.replace(/\$\{RESEND_API_KEY\}/g, '')`) — das Tenant-Compose-Template ist bereits auf echtes
  Resend-SMTP vorbereitet (`GOTRUE_MAILER_AUTOCONFIRM: "false"`), bekommt aber aktuell einen leeren
  String statt des echten Keys. Neue Tenant-Signups mit E-Mail-Bestätigung würden damit hängen bleiben.
  **Noch nicht gefixt.**

**Empfohlener nächster Schritt nach dem RESEND_API_KEY-Fix:** ein echter End-to-End-Deploy mit
einem realen GitHub-Repo (`POST /projects` → Webhook-Push → Nixpacks-Build → Blue-Green-Swap →
Live-Domain → Rollback) — der Smoke-Test deckt bisher nur `repoProvider: "manual"` ohne echten
Build-Durchlauf ab.
