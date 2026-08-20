# Graph Report - multitenant-platform  (2026-08-20)

## Corpus Check
- 214 files · ~113,297 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1240 nodes · 2103 edges · 131 communities (90 shown, 41 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 8 edges (avg confidence: 0.63)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `9ae45733`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- agentFetch
- adminDb.ts
- deploy.ts
- domains.ts
- cmsDb.ts
- index.ts
- Analytics Aggregation
- projects.ts
- README.md
- CMS Auth & App Layout
- Platform Overview Dashboard
- CMS Database Role Management
- CMS Row Editing UI
- CMS Rows & Media API
- Core Database Schema
- routes/secrets.ts
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
- backupHealth.ts
- Docker Stats Monitoring
- devDependencies
- env/page.tsx
- Provisioning Agent TS Config
- Versions- und CVE-Übersicht
- Projects List UI
- Redeploy Script
- cms/package.json
- devDependencies
- CMS Media & Row Forms
- 3. Die gefundenen Lücken
- Project Overview Page
- @types/react
- CMS Media Page
- useToast
- Operations Runbook
- logAudit
- Backup- und Restore-Plan
- Dashboard Layout Nav
- backup-script.sh
- Backup einrichten — Schritt für Schritt
- scripts
- Smoke Test Script
- restore-script.sh
- cms service
- CMS ESLint Config
- 5. Umsetzung im Agent
- Dashboard ESLint Config
- Audit Log UI
- Restore Test Script
- pg
- App Icon Route
- 5. Was umgesetzt wurde
- CMS Root Layout
- PgBouncer Auth Schema
- Tenant Tables List UI
- App Login Page
- Bootstrap Script
- Graphify Guard Script
- Graphify Session Hook
- CMS Next Config
- CMS Next Env Types
- CMS Pg-Format Types
- Postgres Memory Tuning
- 2. Was inventarisiert wird
- Backups Schema
- Audit Logs Schema
- Saved Queries Schema
- Revoke Public Connect Script
- Dashboard Next Config
- Dashboard Next Env Types
- Dashboard Pg-Format Types
- Git Askpass Script
- Pg-Format Type Declaration
- Migration Script
- Postgres OOM Protection
- Write Rate Limit Script
- Cloudflared Compose Config
- CMS Compose Config
- Postgres Compose Config
- Dashboard Compose Setup
- API Route Handlers
- Analytics Aggregation Tables
- Domains Table
- MinIO Storage Compose
- Uptime Monitoring Compose
- Provisioning Agent Compose
- Tenant Compose Template
- Traefik Proxy Compose
- 7. Phasen
- Setup Guide
- docs/GRAPHIFY.md
- next
- traefik service

## God Nodes (most connected - your core abstractions)
1. `agentFetch()` - 86 edges
2. `useToast()` - 19 edges
3. `logAudit()` - 18 edges
4. `logAudit()` - 17 edges
5. `compilerOptions` - 16 edges
6. `getTenantBySlug()` - 16 edges
7. `compilerOptions` - 16 edges
8. `requireSession()` - 15 edges
9. `provisioning-agent service` - 15 edges
10. `getPool()` - 14 edges

## Surprising Connections (you probably didn't know these)
- `CI Workflow` --references--> `cms service`  [INFERRED]
  .github/workflows/ci.yml → cms/docker-compose.yml
- `provisioning-agent service` --implements--> `cms_config role (Migration 22)`  [EXTRACTED]
  provisioning-agent/docker-compose.yml → docs/CMS-PLAN.md
- `traefik service` --conceptually_related_to--> `Per-project Docker network as runtime-only state`  [INFERRED]
  traefik/docker-compose.yml → ARCHITECTURE.md
- `cms service` --references--> `cms_audit table`  [EXTRACTED]
  cms/docker-compose.yml → docs/CMS-PLAN.md
- `cms service` --references--> `cms_collections table`  [EXTRACTED]
  cms/docker-compose.yml → docs/CMS-PLAN.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Security Hardening Measures** — docker_socket_proxy, webhook_hmac_verification, rate_limiting_cf_connecting_ip, cms_session_validation, upload_hardening [EXTRACTED 0.80]

## Communities (131 total, 41 thin omitted)

### Community 0 - "agentFetch"
Cohesion: 0.05
Nodes (47): GET(), GET(), POST(), GET(), POST(), POST(), DELETE(), POST() (+39 more)

### Community 1 - "adminDb.ts"
Cohesion: 0.10
Nodes (41): GET(), POST(), requestMeta(), DELETE(), GET(), POST(), GET(), DELETE() (+33 more)

### Community 2 - "deploy.ts"
Cohesion: 0.08
Nodes (37): reattachProjectNetworks(), detectBuildErrorHint(), truncateBuildLog(), decrypt(), encrypt(), getKey(), maskSecrets(), activeDeployments (+29 more)

### Community 3 - "domains.ts"
Cohesion: 0.07
Nodes (49): buildInstructions(), cfFetch(), cfZoneId(), checkDns(), checkTls(), cloudflare, configuredProviders(), DnsCheckResult (+41 more)

### Community 4 - "cmsDb.ts"
Cohesion: 0.13
Nodes (31): DELETE(), PATCH(), POST(), GET(), POST(), PATCH(), GET(), POST() (+23 more)

### Community 5 - "index.ts"
Cohesion: 0.12
Nodes (14): app, cleanupTenantResources(), execFileP, globalLimiter, sensitiveOpLimiter, webhookLimiter, AnyFn, wrapHandler() (+6 more)

### Community 6 - "Analytics Aggregation"
Cohesion: 0.14
Nodes (21): AccessLogLine, accumulate(), adminClient(), Aggregates, BOT_UA_RE, dailySalt(), dailySaltCache, dayOf() (+13 more)

### Community 7 - "projects.ts"
Cohesion: 0.18
Nodes (16): deleteGithubWebhook(), githubHeaders(), parseGithubRepo(), webhookUrlFor(), createHttpMonitor(), deleteMonitor(), isConfigured(), withKumaSocket() (+8 more)

### Community 8 - "README.md"
Cohesion: 0.09
Nodes (22): age (Verschlüsselung), Cloudflare (DNS-01, Zero Trust), Cloudflare Tunnel, CMS Session-Gültigkeitsprüfung, docker-socket-proxy, GoTrue, NextAuth v5, Next.js 15 (Dashboard/CMS) (+14 more)

### Community 9 - "CMS Auth & App Layout"
Cohesion: 0.17
Nodes (17): clientIp(), POST(), AppLayout(), StartPage(), SidebarNav(), CmsUserRow, Collection, Field (+9 more)

### Community 10 - "Platform Overview Dashboard"
Cohesion: 0.13
Nodes (22): barColor(), DiskUsage, DOMAIN_STATUS_LABEL, formatBytes(), formatNumber(), MemoryConsumer, OrphanContainer, Overview (+14 more)

### Community 11 - "CMS Database Role Management"
Cohesion: 0.22
Nodes (20): assertRealTable(), cmsKey(), cmsRoleName(), describeTenantTable(), dropCmsRole(), encryptForCms(), ensureCmsRole(), execFileP (+12 more)

### Community 12 - "CMS Row Editing UI"
Cohesion: 0.20
Nodes (17): CollectionPage(), preview(), EditRowPage(), decryptCmsPassword(), coerce(), deleteRow(), getRow(), insertRow() (+9 more)

### Community 13 - "CMS Rows & Media API"
Cohesion: 0.23
Nodes (15): DELETE(), PATCH(), POST(), POST(), NewRowPage(), getCollectionWithFields(), insertMedia(), logCmsAudit() (+7 more)

### Community 14 - "Core Database Schema"
Cohesion: 0.15
Nodes (16): kunden, deployments, domains, github_connections, project_env_vars, projects, analytics_daily, analytics_ingest_state (+8 more)

### Community 15 - "routes/secrets.ts"
Cohesion: 0.28
Nodes (6): signTenantJwt(), TenantRoleKind, tenantRoleName(), execFileP, rotateLimiter, secretsRouter

### Community 16 - "provisioning-agent service"
Cohesion: 0.13
Nodes (19): cloudflared service, GitHub webhook deploy routing, P0-1: Docker socket proxy network isolation, PgBouncer AUTH_QUERY against pgbouncer_auth, Per-project Docker network as runtime-only state, pgbouncer service, dashboard service, kunden table (+11 more)

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
Nodes (17): dependencies, bcryptjs, jose, minio, pg-format, react, react-dom, sanitize-html (+9 more)

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
Cohesion: 0.22
Nodes (14): adminClient(), ANALYTICS_DAILY_RETENTION_DAYS, ANALYTICS_DETAIL_RETENTION_DAYS, ANALYTICS_VISITOR_RETENTION_DAYS, CleanupResult, dirSize(), execFileP, getDiskUsage() (+6 more)

### Community 31 - "backupHealth.ts"
Cohesion: 0.12
Nodes (23): alert(), lastSent, adminClient(), BackupFreshness, checkBackupFreshness(), checkDisasterRecoveryReadiness(), DR_BUNDLE_MAX_AGE_DAYS, execFileP (+15 more)

### Community 32 - "Docker Stats Monitoring"
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

### Community 36 - "Versions- und CVE-Übersicht"
Cohesion: 0.33
Nodes (6): 1. Ziel, 3. Werkzeug, 4. Datenmodell, 6. Dashboard, 8. Ergänzend, außerhalb dieses Plans, Versions- und CVE-Übersicht

### Community 37 - "Projects List UI"
Cohesion: 0.27
Nodes (9): Project, ProjectsPage(), handleCreate(), handleDelete(), handleStatusChange(), load(), Tenant, EmptyState() (+1 more)

### Community 38 - "Redeploy Script"
Cohesion: 0.47
Nodes (10): add_env(), compose(), die(), info(), ok(), psql_admin(), say(), redeploy.sh script (+2 more)

### Community 39 - "cms/package.json"
Cohesion: 0.40
Nodes (4): name, private, type, version

### Community 40 - "devDependencies"
Cohesion: 0.12
Nodes (17): devDependencies, eslint, eslint-config-next, @types/bcryptjs, @types/node, @types/pg, @types/react-dom, @types/sanitize-html (+9 more)

### Community 41 - "CMS Media & Row Forms"
Cohesion: 0.24
Nodes (4): MediaPicker(), FormField, RowForm(), toInputValue()

### Community 42 - "3. Die gefundenen Lücken"
Cohesion: 0.15
Nodes (13): 3. Die gefundenen Lücken, B-10 — Der Restore konnte nie funktionieren  (Schwere: kritisch), B-11 — Beim Löschen blieb jedes Mal eine Datei liegen  (Schwere: hoch), B-12 — Die Budgetprüfung kam zu spät und schätzte  (Schwere: kritisch), B-1 — Der Schlüssel liegt im brennenden Haus  (Schwere: kritisch), B-2 — Restore-Test aus dem Dashboard lehnt alle DB-Dumps ab  (Schwere: hoch), B-3 — `encrypt_failed` verletzt den CHECK-Constraint  (Schwere: mittel), B-4 — Kein Alarm, wenn das Backup gar nicht erst läuft  (Schwere: hoch) (+5 more)

### Community 43 - "Project Overview Page"
Cohesion: 0.20
Nodes (3): GithubRepo, ProjectOverviewPage(), Tenant

### Community 45 - "CMS Media Page"
Cohesion: 0.33
Nodes (6): formatBytes(), MediaPage(), MediaUploader(), listMedia(), usedStorageBytes(), MAX_STORAGE_BYTES

### Community 46 - "useToast"
Cohesion: 0.21
Nodes (9): Backup, BackupsPage(), formatBytes(), isTestRow(), RemoteFile, RestoreResultEntry, STATUS_COLOR, STATUS_LABEL (+1 more)

### Community 47 - "Operations Runbook"
Cohesion: 0.50
Nodes (3): project_env_vars table, projects table, Operations Runbook

### Community 48 - "logAudit"
Cohesion: 0.43
Nodes (5): ActorInfo, actorStorage, currentActor(), logAudit(), redact()

### Community 49 - "Backup- und Restore-Plan"
Cohesion: 0.20
Nodes (10): 1. Kurzfassung, 2.1 Was schon lief, 2.2 Kennzahlen davor, 2. Ausgangszustand (vor dieser Arbeit), 4. Zielbild, 5a. Prüfstand, 6. Betrieb: der Ernstfall in sechs Schritten, 6a. Inbetriebnahme und Abnahme (+2 more)

### Community 50 - "Dashboard Layout Nav"
Cohesion: 0.32
Nodes (3): NAV_ITEMS, SidebarNav(), ThemeToggle()

### Community 51 - "backup-script.sh"
Cohesion: 0.44
Nodes (12): delete_oldest_run(), fail(), flush_uploads(), keep_staged_locally(), log(), preflight_budget(), prune_generation(), record_backup() (+4 more)

### Community 52 - "Backup einrichten — Schritt für Schritt"
Cohesion: 0.15
Nodes (12): Ab jetzt läuft es allein, Backup einrichten — Schritt für Schritt, Bleibt das im Gratiskontingent?, Schritt 1 — Speicherplatz beim Anbieter anlegen (im Browser), Schritt 2 — Code und Werkzeuge auf den Server holen, Schritt 3 — Server mit dem Speicher verbinden, Schritt 4 — Verschlüsselungsschlüssel erzeugen, Schritt 5 — Konfiguration eintragen (+4 more)

### Community 53 - "scripts"
Cohesion: 0.40
Nodes (5): scripts, build, dev, lint, start

### Community 54 - "Smoke Test Script"
Cohesion: 0.57
Nodes (6): agent(), cleanup(), fail(), log(), smoke-test.sh script, step()

### Community 55 - "restore-script.sh"
Cohesion: 0.57
Nodes (5): confirm(), die(), fetch(), log(), restore-script.sh script

### Community 56 - "cms service"
Cohesion: 0.43
Nodes (8): cms service, cms_audit table, cms_collections table, cms_fields table, cms_media table, cms_users table, Migration 21: CMS schema, CMS Implementation Plan

### Community 57 - "CMS ESLint Config"
Cohesion: 0.40
Nodes (4): compat, __dirname, eslintConfig, __filename

### Community 58 - "5. Umsetzung im Agent"
Cohesion: 0.33
Nodes (6): 5. Umsetzung im Agent, Alarme, `provisioning-agent/src/lib/inventory.ts` (neu), `provisioning-agent/src/lib/securityScan.ts` (neu), `provisioning-agent/src/routes/security.ts` (neu), Zeitplan

### Community 59 - "Dashboard ESLint Config"
Cohesion: 0.40
Nodes (4): compat, __dirname, eslintConfig, __filename

### Community 60 - "Audit Log UI"
Cohesion: 0.50
Nodes (4): AuditLog, AuditLogPage(), handleExport(), toCsv()

### Community 66 - "5. Was umgesetzt wurde"
Cohesion: 0.40
Nodes (5): 5. Was umgesetzt wurde, Phase 1 — Die Fehler im laufenden Code, Phase 2 — Nicht mehr blind sein, Phase 3 — Der Test, der von allein läuft, Phase 4 — Generationen

### Community 79 - "2. Was inventarisiert wird"
Cohesion: 0.40
Nodes (5): 2. Was inventarisiert wird, Ebene A — Plattform-Infrastruktur (Betreiber kann sofort handeln), Ebene B — Tenant-Dienste (Betreiber kann handeln, betrifft alle Tenants), Ebene C — Gehostete Kundenprojekte (Kunde muss handeln, Betreiber informiert), Zwei Wahrheiten, absichtlich beide

### Community 125 - "7. Phasen"
Cohesion: 0.40
Nodes (5): 7. Phasen, Phase 1 — Inventar ohne Scanner (ca. 1 Tag), Phase 2 — Scan und Zähler (ca. 1,5 Tage), Phase 3 — Täglich und laut (ca. ½ Tag), Phase 4 — Ausnahmen und Verlauf (ca. ½ Tag)

### Community 127 - "Setup Guide"
Cohesion: 0.40
Nodes (5): Architecture Overview, Contributing Guide, cms_config role (Migration 22), Migration 19: optional database, Setup Guide

### Community 128 - "docs/GRAPHIFY.md"
Cohesion: 0.67
Nodes (3): CLAUDE.md — Project Instructions, .claude/hooks/*.sh, graphify CLI Tool

## Knowledge Gaps
- **387 isolated node(s):** `graphify-guard.sh script`, `graphify-session-start.sh script`, `bootstrap.sh script`, `__filename`, `__dirname` (+382 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **41 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Operations Runbook` connect `Operations Runbook` to `Setup Guide`?**
  _High betweenness centrality (0.010) - this node is a cross-community bridge._
- **Why does `dependencies` connect `dependencies` to `next`, `pg`, `cms/package.json`?**
  _High betweenness centrality (0.009) - this node is a cross-community bridge._
- **Why does `minio` connect `dependencies` to `README.md`?**
  _High betweenness centrality (0.009) - this node is a cross-community bridge._
- **What connects `graphify-guard.sh script`, `graphify-session-start.sh script`, `bootstrap.sh script` to the rest of the system?**
  _387 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `agentFetch` be split into smaller, more focused modules?**
  _Cohesion score 0.05198537095088819 - nodes in this community are weakly interconnected._
- **Should `adminDb.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.1003921568627451 - nodes in this community are weakly interconnected._
- **Should `deploy.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.08418367346938775 - nodes in this community are weakly interconnected._