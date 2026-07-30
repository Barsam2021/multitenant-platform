# MultiTenant Platform — Roadmap bis Go-Live (v2, nach echter Code-Analyse)

**Korrektur zur v1-Roadmap:** Die erste Version basierte auf einer gecachten/veralteten GitHub-Ansicht und ging fälschlich von einem leeren Repo aus. Diese Version basiert auf dem tatsächlichen Code (`git log`, `codeload.github.com`-Tarball, Datei-für-Datei gelesen).

## Ist-Zustand korrigiert
Deutlich weiter als gedacht: Provisioning Agent hat eine **vollständige Deployment Engine** (Blue-Green-Deploy, Rollback, Webhook-Signaturverifikation, DNS-Polling für Custom Domains, AES-256-GCM-Verschlüsselung). Dashboard hat einen **funktionierenden Table/SQL-Editor**. Was fehlt, ist gezielter als "alles fehlt":

| Bereich | Backend-Code | Dashboard-UI | Produktionsreif? |
|---|---|---|---|
| Tenant-Provisioning | ✅ | ❌ nur Leseansicht | ⚠️ — SMTP/Resend noch offen |
| Deployment Engine | ✅ vollständig | ❌ Platzhalter-Seite | ⚠️ |
| Table/SQL-Editor | ✅ | ✅ | ✅ im Wesentlichen fertig |
| Custom Domains | ✅ inkl. DNS-Polling | ❌ | ⚠️ |
| GitHub-Integration | ❌ nicht vorhanden | ❌ nicht vorhanden | ❌ |
| Monitoring-Integration | ❌ nicht vorhanden | – | ❌ |
| Backup-Verschlüsselung | ❌ nicht vorhanden | – | ❌ |

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
- [ ] `/dashboard/database`: "Tenant erstellen"-Button + Formular (`POST /tenants` über `/api/provision-tenant`) + "Löschen"-Aktion
- [ ] `/dashboard/hosting`: Projekt-Liste, "New Project"-Wizard (ohne GitHub-Repo-Picker erstmal), Deployment-Historie, Rollback-Button, Live-Build-Logs via Polling
- [ ] Env-Var-Editor pro Projekt
- [ ] Domain-UI

---

## Phase 3 — GitHub-Integration (1–2 Tage)
- [ ] GitHub OAuth App anlegen
- [ ] `github_connections`-Tabelle nutzen
- [ ] Connect-Flow + Repo-Picker im Wizard
- [ ] Automatische Webhook-Registrierung bei Projekt-Erstellung

---

## Phase 4 — Monitoring-Integration (1 Tag)
- [ ] `kuma-api`-Dependency hinzufügen
- [ ] Automatische Monitor-Registrierung bei `POST /tenants`/`POST /projects`
- [ ] Monitore entfernen bei `DELETE /tenants/:slug`

---

## Phase 5 — Backup, Verschlüsselung, Restore-Test (2 Tage)
- [ ] Prüfen ob `backup-script.sh` als Cron läuft
- [ ] Backup-Script + Cron-Eintrag ins Repo
- [ ] Verschlüsselung der Dumps vor `rclone`-Upload (`age`/`gpg`)
- [ ] Einmaliger Restore-Test
- [ ] Trockenlauf von `09_disaster_recovery_runbook.md`

---

## Phase 6 — Security-Hardening Rest (1–2 Tage)
- [ ] Rate-Limiting auf Dashboard-/Agent-API
- [ ] CSP, HSTS, Security-Header im Dashboard
- [ ] `audit_logs`-Tabelle + Logging
- [ ] Secret-Scanner für Build-Logs konsequent prüfen

---

## Phase 7 — Security Rotation & Go-Live (0.5–1 Tag)
- [ ] `POST /tenants/:slug/rotate-secret` (JWT-Secret, MinIO-Key, Resend-Key, Env-Vars, Agent-Secret — siehe unten)
- [ ] Smoke-Test End-to-End (GitHub → Deploy → Monitoring → Backup → Rollback → Restore → Tenant-Löschung)
- [ ] Keine Secrets im Klartext

### Secret-Rotation-Matrix (für Phase 7)
| Secret | Rotation |
|---|---|
| `gotrue_jwt_secret` | Neu erzeugen → GoTrue + PostgREST neu starten → alte Tokens ungültig |
| `minio_secret_key` | Neuen MinIO-User-Key erzeugen → DB aktualisieren → Apps neu deployen |
| `resend_api_key` | API-Key in DB ersetzen → GoTrue neu starten |
| `project_env_vars` | Einzelne Env-Var austauschen → App neu deployen |
| `PROVISIONING_AGENT_SECRET` | Dashboard + Agent gleichzeitig auf neuen Shared-Secret umstellen |

---

## Zeitschätzung gesamt

| Phase | Aufwand |
|---|---|
| 0 Blocker fixen | ✅ erledigt |
| 1 Agent-Lücken | ⚠️ größtenteils erledigt, SMTP + Hardening offen |
| 2 Dashboard-UI | 3–4 Tage |
| 3 GitHub-Integration | 1–2 Tage |
| 4 Monitoring | 1 Tag |
| 5 Backup/Restore | 2 Tage |
| 6 Security-Rest | 1–2 Tage |
| 7 Security Rotation/Go-Live | 0.5–1 Tag |

## Kritischer Pfad
Phase 0 + größter Teil von Phase 1 erledigt. Nächster Block: Phase 2 (Dashboard-UI) — größte verbleibende Lücke, Backend existiert schon lange. Phase 3 (GitHub) und Phase 4 (Monitoring) sind parallelisierbar.
