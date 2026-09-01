# Graph Report - multitenant-platform  (2026-09-01)

## Corpus Check
- 247 files · ~152,172 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1533 nodes · 2394 edges · 137 communities (86 shown, 51 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 14 edges (avg confidence: 0.58)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `0b0d3bb1`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- agentFetch
- Tenant Query API Routes
- deploy.ts
- domains.ts
- cmsDb.ts
- index.ts
- Analytics Aggregation
- projects.ts
- README.md
- CMS Auth & App Layout
- Platform Overview Dashboard
- TEIL 2 — DSGVO-Konkretisierung
- CMS Row Editing UI
- CMS Rows & Media API
- 2. Testkategorien pro Feature
- logAudit
- provisioning-agent service
- analytics/page.tsx
- domains/page.tsx
- CMS Login & Session
- CMS Admin Page
- Deployments Management UI
- dependencies
- compilerOptions
- Tenant Table Editor UI
- compilerOptions
- Media Upload Storage
- SQL Query Editor UI
- Dashboard Layout & Toasts
- dependencies
- lib/cleanup.ts
- ANALYSE 1 — Ist-Analyse & Risiko-Absicherung
- stats.ts
- devDependencies
- env/page.tsx
- Provisioning Agent TS Config
- Tenant-Migration: up2-site
- Projects List UI
- RESSOURCEN-PROFIL & SKALIERUNGSGRENZE
- cms/package.json
- devDependencies
- CMS Media & Row Forms
- inventory.ts
- useToast
- @types/react
- CMS Media Page
- backups/page.tsx
- Setup Guide
- CMS Schema Tables
- 5. Unterschiede zu echtem Supabase — die eigentlichen Fehlerquellen
- Dashboard Layout Nav
- env.sh
- Projekte fuer die MultiTenant-Plattform
- verify-backups.sh
- CI-SETUP
- structure.test.js
- git.ts
- CMS ESLint Config
- routes/secrets.ts
- Dashboard ESLint Config
- Audit Log UI
- crypto.ts
- Backup-Verifikation — Arbeitsstand
- scripts
- Versions- und CVE-Übersicht
- App Icon Route
- tenant-api.test.js
- CMS Root Layout
- jwt.test.js
- Tenant Tables List UI
- App Login Page
- isolation.test.js
- Graphify Guard Script
- Graphify Session Hook
- CMS Next Config
- CMS Next Env Types
- CMS Pg-Format Types
- Postgres Memory Tuning
- auth.ts
- build-log.test.js
- masking.test.js
- tenant-compose.test.js
- Revoke Public Connect Script
- Dashboard Next Config
- Dashboard Next Env Types
- Dashboard Pg-Format Types
- Git Askpass Script
- Pg-Format Type Declaration
- up.sh script
- Postgres OOM Protection
- Write Rate Limit Script
- Cloudflared Compose Config
- CMS Compose Config
- Postgres Compose Config
- provision-test-tenants.js
- analytics.test.js
- build-env.test.js
- dns.test.js
- inventory.test.js
- tariff.test.js
- assert-not-production.sh
- agent.ts
- in-net.sh
- run-tests.sh
- middleware.ts
- audit-logs/route.ts
- projects/route.ts
- cms/route.ts
- [slug]/route.ts
- minio
- cleanup/run/route.ts
- primary/route.ts
- domains/[id]/route.ts
- Dashboard Compose Setup
- API Route Handlers
- Analytics Aggregation Tables
- Domains Table
- MinIO Storage Compose
- Uptime Monitoring Compose
- Provisioning Agent Compose
- Tenant Compose Template
- Traefik Proxy Compose
- pg
- 5. Umsetzung im Agent
- verify/route.ts
- 7. Phasen
- bulk/route.ts
- repair/route.ts
- inventory/route.ts
- database/route.ts
- public-access/route.ts
- rotate-secret/route.ts

## God Nodes (most connected - your core abstractions)
1. `agentFetch()` - 88 edges
2. `useToast()` - 21 edges
3. `2. Testkategorien pro Feature` - 21 edges
4. `logAudit()` - 17 edges
5. `compilerOptions` - 16 edges
6. `getTenantBySlug()` - 16 edges
7. `compilerOptions` - 16 edges
8. `logAudit()` - 16 edges
9. `requireSession()` - 15 edges
10. `provisioning-agent service` - 15 edges

## Surprising Connections (you probably didn't know these)
- `CI Workflow` --references--> `cms service`  [INFERRED]
  .github/workflows/ci.yml → cms/docker-compose.yml
- `provisioning-agent service` --implements--> `cms_config role (Migration 22)`  [EXTRACTED]
  provisioning-agent/docker-compose.yml → docs/CMS-PLAN.md
- `CI Workflow` --references--> `dashboard service`  [INFERRED]
  .github/workflows/ci.yml → dashboard/docker-compose.yml
- `CI Workflow` --references--> `provisioning-agent service`  [INFERRED]
  .github/workflows/ci.yml → provisioning-agent/docker-compose.yml
- `cms service` --references--> `minio service`  [EXTRACTED]
  cms/docker-compose.yml → minio/docker-compose.yml

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Security Hardening Measures** — docker_socket_proxy, webhook_hmac_verification, rate_limiting_cf_connecting_ip, cms_session_validation, upload_hardening [EXTRACTED 0.80]

## Communities (137 total, 51 thin omitted)

### Community 0 - "agentFetch"
Cohesion: 0.13
Nodes (15): DELETE(), POST(), POST(), GET(), POST(), DELETE(), GET(), PUT() (+7 more)

### Community 1 - "Tenant Query API Routes"
Cohesion: 0.10
Nodes (41): GET(), POST(), requestMeta(), DELETE(), GET(), POST(), GET(), DELETE() (+33 more)

### Community 2 - "deploy.ts"
Cohesion: 0.12
Nodes (23): reattachProjectNetworks(), detectBuildErrorHint(), truncateBuildLog(), maskSecrets(), activeDeployments, ActiveDeployState, adminClient(), cancelDeployment() (+15 more)

### Community 3 - "domains.ts"
Cohesion: 0.05
Nodes (71): assertRealTable(), cmsKey(), cmsRoleName(), describeTenantTable(), dropCmsRole(), encryptForCms(), ensureCmsRole(), execFileP (+63 more)

### Community 4 - "cmsDb.ts"
Cohesion: 0.14
Nodes (29): DELETE(), PATCH(), POST(), GET(), POST(), PATCH(), GET(), POST() (+21 more)

### Community 5 - "index.ts"
Cohesion: 0.10
Nodes (16): app, cleanupTenantResources(), execFileP, globalLimiter, sensitiveOpLimiter, webhookLimiter, alert(), lastSent (+8 more)

### Community 6 - "Analytics Aggregation"
Cohesion: 0.14
Nodes (21): AccessLogLine, accumulate(), adminClient(), Aggregates, BOT_UA_RE, dailySalt(), dailySaltCache, dayOf() (+13 more)

### Community 7 - "projects.ts"
Cohesion: 0.18
Nodes (16): deleteGithubWebhook(), githubHeaders(), parseGithubRepo(), webhookUrlFor(), createHttpMonitor(), deleteMonitor(), isConfigured(), withKumaSocket() (+8 more)

### Community 8 - "README.md"
Cohesion: 0.09
Nodes (25): age (Verschlüsselung), CLAUDE.md — Project Instructions, .claude/hooks/*.sh, Cloudflare (DNS-01, Zero Trust), Cloudflare Tunnel, CMS Session-Gültigkeitsprüfung, docker-socket-proxy, graphify CLI Tool (+17 more)

### Community 9 - "CMS Auth & App Layout"
Cohesion: 0.17
Nodes (17): clientIp(), POST(), AppLayout(), StartPage(), SidebarNav(), CmsUserRow, Collection, Field (+9 more)

### Community 10 - "Platform Overview Dashboard"
Cohesion: 0.13
Nodes (22): barColor(), DiskUsage, DOMAIN_STATUS_LABEL, formatBytes(), formatNumber(), MemoryConsumer, OrphanContainer, Overview (+14 more)

### Community 11 - "TEIL 2 — DSGVO-Konkretisierung"
Cohesion: 0.04
Nodes (44): 0.1 Blocker B-1 (P0): es gibt keine dauerhaft nutzbare isolierte Testumgebung, 0.2 Was der CI-Stack heute abdeckt — und was nicht, 0.3 Klasse-3-Prüfungen, die für diesen Bericht auf der Live-VPS ausgeführt wurden, 0. Ausführungsrahmen — was tatsächlich getestet werden konnte, 1.1 Endpunkt-Inventar (Auftragspunkt 1.3), 1.2 Tenant-Isolation — konkrete Testfälle (Auftragspunkt 1.1), 1.3 Auth-Schwachstellen (Auftragspunkt 1.2), 1.4 Priorisierte Lückenliste Teil 1 (+36 more)

### Community 12 - "CMS Row Editing UI"
Cohesion: 0.20
Nodes (17): CollectionPage(), preview(), EditRowPage(), decryptCmsPassword(), coerce(), deleteRow(), getRow(), insertRow() (+9 more)

### Community 13 - "CMS Rows & Media API"
Cohesion: 0.23
Nodes (15): DELETE(), PATCH(), POST(), POST(), NewRowPage(), getCollectionWithFields(), insertMedia(), logCmsAudit() (+7 more)

### Community 14 - "2. Testkategorien pro Feature"
Cohesion: 0.04
Nodes (47): 0.1 Korrekturen an den Auftragsannahmen, 0.2 Werkzeuge (Festlegung, damit die Testfälle konkret sind), 0. Rahmen — was wo überhaupt getestet werden darf, 1. Feature-Inventar, 2. Testkategorien pro Feature, 3.1 Wo personenbezogene Daten liegen, 3.2 Reicht die age-Verschlüsselung?, 3.3 Lösch- und Auskunftsfunktionen (+39 more)

### Community 15 - "logAudit"
Cohesion: 0.18
Nodes (9): ActorInfo, actorStorage, currentActor(), logAudit(), redact(), hasDrift(), backupsRouter, execFileP (+1 more)

### Community 16 - "provisioning-agent service"
Cohesion: 0.12
Nodes (21): cloudflared service, GitHub webhook deploy routing, P0-1: Docker socket proxy network isolation, PgBouncer AUTH_QUERY against pgbouncer_auth, Per-project Docker network as runtime-only state, Rate limiting keyed on Cf-Connecting-Ip, pgbouncer service, dashboard service (+13 more)

### Community 17 - "analytics/page.tsx"
Cohesion: 0.15
Nodes (14): AnalyticsData, AnalyticsPage(), formatDay(), formatNumber(), RANGES, RankedList(), SeriesPoint, ViewsChart() (+6 more)

### Community 18 - "domains/page.tsx"
Cohesion: 0.13
Nodes (10): AddDomainResult, Domain, DomainsPage(), Instruction, relTime(), STATUS_META, ConfirmDialog(), ConfirmDialogProps (+2 more)

### Community 19 - "CMS Login & Session"
Cohesion: 0.21
Nodes (11): POST(), LoginPage(), LoginForm(), getSessionUser(), clearStaleCookie(), CmsSession, createSession(), destroySession() (+3 more)

### Community 20 - "CMS Admin Page"
Cohesion: 0.12
Nodes (6): CmsAdminPage(), CmsUser, Collection, Field, FIELD_TYPES, TableCandidate

### Community 21 - "Deployments Management UI"
Cohesion: 0.14
Nodes (8): ACTIVE_STATES, CANCELLABLE_STATES, Deployment, DeploymentsPage(), duration(), githubCommitUrl(), STATUS_COLOR, WebhookStatus

### Community 22 - "dependencies"
Cohesion: 0.12
Nodes (17): dependencies, bcryptjs, jose, next, pg-format, react, react-dom, sanitize-html (+9 more)

### Community 23 - "compilerOptions"
Cohesion: 0.07
Nodes (26): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+18 more)

### Community 24 - "Tenant Table Editor UI"
Cohesion: 0.21
Nodes (10): ColumnInfo, displayValue(), InputKind, inputKindFor(), Row, TableEditorPage(), saveEdit(), startEdit() (+2 more)

### Community 25 - "compilerOptions"
Cohesion: 0.07
Nodes (26): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+18 more)

### Community 26 - "Media Upload Storage"
Cohesion: 0.21
Nodes (12): ALLOWED, bucketFor(), getClient(), MAX_FILE_BYTES, MAX_TENANT_BYTES, MAX_UPLOAD_BYTES, PORT, PUBLIC_BASE (+4 more)

### Community 27 - "SQL Query Editor UI"
Cohesion: 0.26
Nodes (10): historyKey(), loadHistory(), pushHistory(), QueryResult, SavedQuery, SqlEditorPage(), handleExportCsv(), handleKeyDown() (+2 more)

### Community 28 - "Dashboard Layout & Toasts"
Cohesion: 0.18
Nodes (9): metadata, Providers(), COLORS, ICONS, ToastApi, ToastContext, ToastItem, ToastKind (+1 more)

### Community 29 - "dependencies"
Cohesion: 0.06
Nodes (34): express-rate-limit, jsonwebtoken, dependencies, express, express-rate-limit, jsonwebtoken, pg, pg-format (+26 more)

### Community 30 - "lib/cleanup.ts"
Cohesion: 0.25
Nodes (13): adminClient(), ANALYTICS_DAILY_RETENTION_DAYS, ANALYTICS_DETAIL_RETENTION_DAYS, ANALYTICS_VISITOR_RETENTION_DAYS, CleanupResult, dirSize(), execFileP, getDiskUsage() (+5 more)

### Community 31 - "ANALYSE 1 — Ist-Analyse & Risiko-Absicherung"
Cohesion: 0.05
Nodes (38): 0. Korrekturen an den Annahmen aus dem Auftrag, 1.1 Plattform-Dienste (ein Container für alle Tenants), 1.2 Tenant-Dienste (pro Kunde, nur bei `db_enabled=true`), 1.3 Kunden-App-Container (pro Projekt), 1.4 Netzwerkmodell, 1.5 Abhängigkeitskette, 1. Service-Inventar, 2. Tenant-Architektur — wie Mandantentrennung technisch umgesetzt ist (+30 more)

### Community 32 - "stats.ts"
Cohesion: 0.21
Nodes (8): directorySize(), DockerStatsLine, execFileP, parseMemUsage(), parseSize(), readBucketSizes(), readDockerStats(), statsRouter

### Community 33 - "devDependencies"
Cohesion: 0.05
Nodes (41): dependencies, bcryptjs, next, next-auth, pg, pg-format, react, react-dom (+33 more)

### Community 34 - "env/page.tsx"
Cohesion: 0.22
Nodes (3): ApiKeys, EnvVar, EnvVarsPage()

### Community 35 - "Provisioning Agent TS Config"
Cohesion: 0.17
Nodes (11): compilerOptions, esModuleInterop, module, outDir, resolveJsonModule, rootDir, skipLibCheck, strict (+3 more)

### Community 36 - "Tenant-Migration: up2-site"
Cohesion: 0.40
Nodes (4): Bewusst nicht uebernommen, Daten, Einspielen, Tenant-Migration: up2-site

### Community 37 - "Projects List UI"
Cohesion: 0.27
Nodes (9): Project, ProjectsPage(), handleCreate(), handleDelete(), handleStatusChange(), load(), Tenant, EmptyState() (+1 more)

### Community 38 - "RESSOURCEN-PROFIL & SKALIERUNGSGRENZE"
Cohesion: 0.05
Nodes (39): 0.1 „Bisher gibt es kein Monitoring" trifft nicht ganz zu, 0.2 Das Messwerkzeug läuft auf der Messmaschine, 0.3 Einschränkung nach Leitplanke: n = 2, 0. Vorbemerkungen — zwei Korrekturen und eine Einschränkung, 1. VPS-Spezifikation, 2.1 Geteilte Dienste, 2.2 Build-Infrastruktur — der überraschende Posten, 2.3 Host-Ebene — was `docker stats` nicht zeigt (+31 more)

### Community 39 - "cms/package.json"
Cohesion: 0.40
Nodes (4): name, private, type, version

### Community 40 - "devDependencies"
Cohesion: 0.12
Nodes (17): devDependencies, eslint, eslint-config-next, @types/bcryptjs, @types/node, @types/pg, @types/react-dom, @types/sanitize-html (+9 more)

### Community 41 - "CMS Media & Row Forms"
Cohesion: 0.24
Nodes (4): MediaPicker(), FormField, RowForm(), toInputValue()

### Community 42 - "inventory.ts"
Cohesion: 0.20
Nodes (18): adminClient(), baseImageOf(), classifyContainer(), collectInventory(), collectPinnedVersions(), collectProjectComponents(), collectRunningContainers(), Component (+10 more)

### Community 43 - "useToast"
Cohesion: 0.12
Nodes (8): GithubRepo, ProjectOverviewPage(), Tenant, Component, SCOPE_HINT, SCOPE_LABEL, SecurityPage(), useToast()

### Community 45 - "CMS Media Page"
Cohesion: 0.33
Nodes (6): formatBytes(), MediaPage(), MediaUploader(), listMedia(), usedStorageBytes(), MAX_STORAGE_BYTES

### Community 46 - "backups/page.tsx"
Cohesion: 0.29
Nodes (5): Backup, BackupsPage(), formatBytes(), RestoreResultEntry, STATUS_COLOR

### Community 47 - "Setup Guide"
Cohesion: 0.22
Nodes (8): Architecture Overview, Contributing Guide, cms_config role (Migration 22), Migration 19: optional database, project_env_vars table, projects table, Operations Runbook, Setup Guide

### Community 48 - "CMS Schema Tables"
Cohesion: 0.43
Nodes (8): cms service, cms_audit table, cms_collections table, cms_fields table, cms_media table, cms_users table, Migration 21: CMS schema, CMS Implementation Plan

### Community 49 - "5. Unterschiede zu echtem Supabase — die eigentlichen Fehlerquellen"
Cohesion: 0.06
Nodes (32): 1. DB-Schema und Migrations-Format, 2. Storage / MinIO-Bucket-Struktur, 3. Auth / GoTrue-Erwartungen, 4. Deployment-Voraussetzungen (Nixpacks / Provisioning-Agent), 5.10 Kleinere, aber häufige, 5.1 Rollennamen sind tenant-spezifisch (der große), 5.2 `auth.uid()` existiert nicht, 5.3 Kein Storage-Service, kein `storage`-Schema (+24 more)

### Community 50 - "Dashboard Layout Nav"
Cohesion: 0.32
Nodes (3): NAV_ITEMS, SidebarNav(), ThemeToggle()

### Community 51 - "env.sh"
Cohesion: 0.06
Nodes (52): encrypt_and_upload(), fail(), log(), record_backup(), send_alert(), backup-script.sh script, confirm(), die() (+44 more)

### Community 52 - "Projekte fuer die MultiTenant-Plattform"
Cohesion: 0.08
Nodes (25): 1. Migrationen, 2. Storage / MinIO, 3. Auth / GoTrue, 4. Deployment (Nixpacks), 5. Checkliste vor dem ersten Deploy, 6. Wenn etwas nicht laeuft, Aus einem Supabase-Dump portieren, Der Build hat KEINEN Netzzugriff auf die eigene API (+17 more)

### Community 53 - "verify-backups.sh"
Cohesion: 0.53
Nodes (8): c_crit(), c_ok(), c_warn(), newest_for(), probe_archive(), psql_admin(), verify-backups.sh script, step()

### Community 54 - "CI-SETUP"
Cohesion: 0.11
Nodes (18): 1.1 Job `unit` — Stufe 1 aus `TESTPLAN.md` §4, 1.2 Job `integration`, 1.3 Job `security`, 1. Was die Pipeline tut, 2.1 Warum die Testmandanten mit echtem Agent-Code angelegt werden, 2.2 Die Notbremse, 2. Der isolierte CI-Stack, 3.1 Wie das zur `age`-Verschlüsselung der Backups passt (+10 more)

### Community 55 - "structure.test.js"
Cohesion: 0.15
Nodes (10): API_DIR, assert, fs, GUARD_EXEMPT, HTTP_METHODS, path, REPO, routeFiles (+2 more)

### Community 56 - "git.ts"
Cohesion: 0.29
Nodes (8): Project, checkoutRepo(), execFileP, gitEnv(), normalizeRepoUrl(), remoteMatches(), verifyGithubSignature(), webhooksRouter

### Community 57 - "CMS ESLint Config"
Cohesion: 0.40
Nodes (4): compat, __dirname, eslintConfig, __filename

### Community 58 - "routes/secrets.ts"
Cohesion: 0.28
Nodes (6): signTenantJwt(), TenantRoleKind, tenantRoleName(), execFileP, rotateLimiter, secretsRouter

### Community 59 - "Dashboard ESLint Config"
Cohesion: 0.40
Nodes (4): compat, __dirname, eslintConfig, __filename

### Community 60 - "Audit Log UI"
Cohesion: 0.50
Nodes (4): AuditLog, AuditLogPage(), handleExport(), toCsv()

### Community 61 - "crypto.ts"
Cohesion: 0.40
Nodes (8): decrypt(), encrypt(), getKey(), adminClient(), buildEnvVars(), getProjectEnvVars(), getTenantSecrets(), TenantSecrets

### Community 62 - "Backup-Verifikation — Arbeitsstand"
Cohesion: 0.18
Nodes (10): Antwort auf (1): beides, mit einem Vorbehalt, Antwort auf (2): `backups/verify-backups.sh`, Ausgangsfrage, Backup-Verifikation — Arbeitsstand, Die drei ursprünglich dokumentierten Bugs — gefixt, Die eigentliche Diskrepanz (Stufe 0b KRIT vs. Stufe 1 OK), Neuer Befund beim Testen: Dashboard-Buttons sind komplett tot, Nächste Schritte (+2 more)

### Community 63 - "scripts"
Cohesion: 0.40
Nodes (5): scripts, build, dev, lint, start

### Community 64 - "Versions- und CVE-Übersicht"
Cohesion: 0.18
Nodes (11): 1. Ziel, 2. Was inventarisiert wird, 3. Werkzeug, 4. Datenmodell, 6. Dashboard, 8. Ergänzend, außerhalb dieses Plans, Ebene A — Plattform-Infrastruktur (Betreiber kann sofort handeln), Ebene B — Tenant-Dienste (Betreiber kann handeln, betrifft alle Tenants) (+3 more)

### Community 66 - "tenant-api.test.js"
Cohesion: 0.29
Nodes (3): assert, { signTenantJwt }, { test }

### Community 68 - "jwt.test.js"
Cohesion: 0.33
Nodes (5): assert, jwt, SECRET, { signTenantJwt, tenantRoleName }, { test }

### Community 71 - "isolation.test.js"
Cohesion: 0.40
Nodes (5): assert, { Client }, conn(), { test, before, after }, tryConnect()

### Community 79 - "auth.ts"
Cohesion: 0.13
Nodes (7): POST(), GET(), GET(), POST(), GET(), { handlers, auth, signIn, signOut }, requestMeta()

### Community 80 - "build-log.test.js"
Cohesion: 0.40
Nodes (4): assert, { detectBuildErrorHint }, { test }, { truncateBuildLog }

### Community 81 - "masking.test.js"
Cohesion: 0.40
Nodes (3): assert, { maskSecrets }, { test }

### Community 82 - "tenant-compose.test.js"
Cohesion: 0.40
Nodes (4): assert, compose, fs, { test }

### Community 97 - "provision-test-tenants.js"
Cohesion: 0.40
Nodes (3): agent, path, { provisionTenantDatabaseSchema, writeTenantCompose }

### Community 98 - "analytics.test.js"
Cohesion: 0.50
Nodes (3): assert, { test }, {
  visitorHash,
  normalizeHost,
  normalizePath,
  normalizeReferrer,
}

### Community 99 - "build-env.test.js"
Cohesion: 0.50
Nodes (3): assert, { isBuildTimeSafe }, { test }

### Community 100 - "dns.test.js"
Cohesion: 0.50
Nodes (3): assert, { splitHostname, buildInstructions }, { test }

### Community 101 - "inventory.test.js"
Cohesion: 0.50
Nodes (3): assert, { splitImageRef, classifyContainer, hasDrift }, { test }

### Community 102 - "tariff.test.js"
Cohesion: 0.50
Nodes (3): assert, { TARIFF_LIMITS }, { test }

### Community 104 - "agent.ts"
Cohesion: 0.13
Nodes (7): POST(), GET(), POST(), GET(), GET(), GET(), POST()

### Community 107 - "middleware.ts"
Cohesion: 0.50
Nodes (3): authConfig, { auth: middleware }, config

### Community 128 - "5. Umsetzung im Agent"
Cohesion: 0.33
Nodes (6): 5. Umsetzung im Agent, Alarme, `provisioning-agent/src/lib/inventory.ts` (neu), `provisioning-agent/src/lib/securityScan.ts` (neu), `provisioning-agent/src/routes/security.ts` (neu), Zeitplan

### Community 130 - "7. Phasen"
Cohesion: 0.40
Nodes (5): 7. Phasen, Phase 1 — Inventar ohne Scanner (ca. 1 Tag), Phase 2 — Scan und Zähler (ca. 1,5 Tage), Phase 3 — Täglich und laut (ca. ½ Tag), Phase 4 — Ausnahmen und Verlauf (ca. ½ Tag)

## Knowledge Gaps
- **620 isolated node(s):** `graphify-guard.sh script`, `graphify-session-start.sh script`, `bootstrap.sh script`, `__filename`, `__dirname` (+615 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **51 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `dependencies` connect `dependencies` to `minio`, `pg`, `cms/package.json`?**
  _High betweenness centrality (0.006) - this node is a cross-community bridge._
- **Why does `useToast()` connect `useToast` to `env/page.tsx`, `Projects List UI`, `backups/page.tsx`, `domains/page.tsx`, `CMS Admin Page`, `Deployments Management UI`, `Tenant Table Editor UI`, `SQL Query Editor UI`, `Dashboard Layout & Toasts`?**
  _High betweenness centrality (0.006) - this node is a cross-community bridge._
- **Why does `minio` connect `minio` to `README.md`?**
  _High betweenness centrality (0.005) - this node is a cross-community bridge._
- **What connects `graphify-guard.sh script`, `graphify-session-start.sh script`, `bootstrap.sh script` to the rest of the system?**
  _620 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `agentFetch` be split into smaller, more focused modules?**
  _Cohesion score 0.13405797101449277 - nodes in this community are weakly interconnected._
- **Should `Tenant Query API Routes` be split into smaller, more focused modules?**
  _Cohesion score 0.1003921568627451 - nodes in this community are weakly interconnected._
- **Should `deploy.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.12413793103448276 - nodes in this community are weakly interconnected._